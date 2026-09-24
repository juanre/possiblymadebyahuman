import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { extname, join, normalize } from "node:path";
import pg from "pg";

import { createIngestApi } from "./index.ts";
import { PostgresRecordStore, type PostgresDatabase, type RecordStore } from "../../../packages/storage/src/index.ts";
import { loadSqlMigrations } from "../../../packages/storage/src/migrations.ts";

export const DEFAULT_RECORD_BODY_LIMIT_BYTES = 10_000_000;
export const DEFAULT_CHECKPOINT_BODY_LIMIT_BYTES = 16_384;
export const DEFAULT_MAX_IN_FLIGHT_API_REQUESTS = 8;
export const DEFAULT_HTTP_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;
export const DEFAULT_POOL_MAX = 5;
export const DEFAULT_POOL_IDLE_TIMEOUT_MS = 30_000;
export const DEFAULT_POOL_CONNECTION_TIMEOUT_MS = 5_000;
export const DEFAULT_REQUIRED_MIGRATION_VERSIONS = ["001"] as const;

const PORT = Number(process.env.PORT ?? 8000);
const DATABASE_URL = process.env.DATABASE_URL;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`;
const WEB_DIST_DIR = process.env.WEB_DIST_DIR ?? "/app/web/dist";
const SITE_DIST_DIR = process.env.SITE_DIST_DIR ?? "/app/site/public";
const RECORD_BODY_LIMIT_BYTES = parsePositiveInteger(
  process.env.RECORD_BODY_LIMIT_BYTES ?? process.env.MAX_RECORD_BODY_BYTES,
  DEFAULT_RECORD_BODY_LIMIT_BYTES,
);

export type Readiness = { ok: boolean; database: boolean; migrations: boolean };

export class RequestBodyTooLargeError extends Error {
  readonly limitBytes: number;

  constructor(limitBytes: number) {
    super(`request body exceeds ${limitBytes} bytes`);
    this.name = "RequestBodyTooLargeError";
    this.limitBytes = limitBytes;
  }
}

export function createPoolConfig(env: NodeJS.ProcessEnv = process.env): pg.PoolConfig {
  const config: pg.PoolConfig = {
    max: parsePositiveInteger(env.PG_POOL_MAX ?? env.DATABASE_POOL_MAX, DEFAULT_POOL_MAX),
    idleTimeoutMillis: parsePositiveInteger(env.PG_POOL_IDLE_TIMEOUT_MS, DEFAULT_POOL_IDLE_TIMEOUT_MS),
    connectionTimeoutMillis: parsePositiveInteger(env.PG_POOL_CONNECTION_TIMEOUT_MS, DEFAULT_POOL_CONNECTION_TIMEOUT_MS),
  };

  const statementTimeout = parsePositiveInteger(env.PG_STATEMENT_TIMEOUT_MS ?? env.PG_QUERY_TIMEOUT_MS, DEFAULT_STATEMENT_TIMEOUT_MS);
  config.statement_timeout = statementTimeout;
  config.query_timeout = statementTimeout;
  return config;
}

export type RuntimeServerOptions = {
  api: ReturnType<typeof createIngestApi>;
  store: Pick<RecordStore, "recordExists">;
  db: PostgresDatabase;
  webDistDir?: string;
  siteDistDir?: string;
  recordBodyLimitBytes?: number;
  checkpointBodyLimitBytes?: number;
  maxInFlightApiRequests?: number;
  httpRequestTimeoutMs?: number;
  requiredMigrationVersions?: readonly string[];
  buildRevision?: string;
};

export function createRuntimeServer(options: RuntimeServerOptions): Server {
  const maxInFlight = options.maxInFlightApiRequests ?? DEFAULT_MAX_IN_FLIGHT_API_REQUESTS;
  const requestTimeout = options.httpRequestTimeoutMs ?? DEFAULT_HTTP_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(maxInFlight) || maxInFlight <= 0) throw new RangeError("maxInFlightApiRequests must be a positive safe integer");
  if (!Number.isSafeInteger(requestTimeout) || requestTimeout <= 0) throw new RangeError("httpRequestTimeoutMs must be a positive safe integer");
  let inFlight = 0;
  const server = createServer({ requestTimeout, headersTimeout: Math.min(60_000, requestTimeout),
    connectionsCheckingInterval: Math.min(1_000, requestTimeout) }, async (req, res) => {
    let admitted = false;
    try {
      // Admission and routing must use the same normalized target, including
      // absolute-form requests and dot segments, before any body is buffered.
      const requestUrl = new URL((req.url ?? "/").replace(/^\/+/, "/"), `http://${req.headers.host ?? "localhost"}`);
      const apiRequest = requestUrl.pathname.startsWith("/api/");
      if (apiRequest && inFlight >= maxInFlight) {
        res.setHeader("retry-after", "1");
        res.setHeader("connection", "close");
        json(res, 503, { error: "server_busy" });
        return;
      }
      if (apiRequest) { inFlight++; admitted = true; }
      await route(req, res, options, requestUrl);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        json(res, 413, { error: "request_body_too_large", max_bytes: error.limitBytes });
        return;
      }
      if (req.aborted || res.destroyed) return;
      console.error(error);
      json(res, 500, { error: "internal_server_error" });
    } finally { if (admitted) inFlight--; }
  });
  return server;
}

export function installGracefulShutdown(server: Server, pool: { end: () => Promise<void> }, signals = ["SIGTERM", "SIGINT"] as const): void {
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received; closing HTTP server and Postgres pool`);
    server.close((error) => {
      if (error) console.error(error);
      void pool.end().then(
        () => process.exit(error ? 1 : 0),
        (poolError) => {
          console.error(poolError);
          process.exit(1);
        },
      );
    });
  };
  for (const signal of signals) process.once(signal, shutdown);
}

export async function readiness(
  db: PostgresDatabase,
  requiredMigrationVersions: readonly string[] = DEFAULT_REQUIRED_MIGRATION_VERSIONS,
): Promise<Readiness> {
  try {
    const result = await db.query<{
      records_ready: string | null;
      stats_ready: string | null;
      analysis_ready: string | null;
      observed_sessions_ready: string | null;
      observed_checkpoints_ready: string | null;
      migrations_ready: string | null;
      required_migration_count: number | string;
      applied_required_migration_count: number | string;
    }>(
      `with required_migrations(version) as (select unnest($1::text[]))
       select
         to_regclass('public.records')::text as records_ready,
         to_regclass('public.record_stats')::text as stats_ready,
         to_regclass('public.analysis_results')::text as analysis_ready,
         to_regclass('public.observed_sessions')::text as observed_sessions_ready,
         to_regclass('public.observed_checkpoints')::text as observed_checkpoints_ready,
         to_regclass('public.schema_migrations')::text as migrations_ready,
         (select count(*) from required_migrations) as required_migration_count,
         (select count(*) from required_migrations required join schema_migrations applied using (version)) as applied_required_migration_count`,
      [[...requiredMigrationVersions]],
    );
    const row = result.rows[0];
    const requiredCount = Number(row?.required_migration_count ?? 0);
    const appliedCount = Number(row?.applied_required_migration_count ?? -1);
    const migrations = Boolean(
      row?.records_ready
        && row.stats_ready
        && row.analysis_ready
        && row.observed_sessions_ready
        && row.observed_checkpoints_ready
        && row.migrations_ready
        && appliedCount === requiredCount,
    );
    return { ok: migrations, database: true, migrations };
  } catch (error) {
    if (isUndefinedTableError(error)) return { ok: false, database: true, migrations: false };
    return { ok: false, database: false, migrations: false };
  }
}

async function route(req: IncomingMessage, res: ServerResponse, options: RuntimeServerOptions, requestUrl: URL): Promise<void> {
  if (requestUrl.pathname.startsWith("/api/")) {
    const checkpoint = /^\/api\/observed-sessions\/[^/]+\/checkpoints$/.test(requestUrl.pathname);
    const upload = requestUrl.pathname === "/api/record-uploads" || requestUrl.pathname.startsWith("/api/record-uploads/");
    const bodyLimit = upload ? Math.min(1024 * 1024, options.recordBodyLimitBytes ?? DEFAULT_RECORD_BODY_LIMIT_BYTES) : checkpoint ? Math.min(options.checkpointBodyLimitBytes ?? DEFAULT_CHECKPOINT_BODY_LIMIT_BYTES,
      options.recordBodyLimitBytes ?? DEFAULT_RECORD_BODY_LIMIT_BYTES) : options.recordBodyLimitBytes ?? DEFAULT_RECORD_BODY_LIMIT_BYTES;
    const response = await options.api.handleRequest(await toFetchRequest(req, requestUrl, bodyLimit));
    await writeFetchResponse(res, response);
    return;
  }

  if (req.method === "GET" && (requestUrl.pathname === "/health" || requestUrl.pathname === "/live")) {
    json(res, 200, { ok: true, revision: options.buildRevision ?? process.env.BUILD_REVISION ?? "development" });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/ready") {
    const ready = await readiness(options.db, options.requiredMigrationVersions);
    json(res, ready.ok ? 200 : 503, ready);
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    json(res, 405, { error: "method_not_allowed" });
    return;
  }

  if (requestUrl.pathname.startsWith("/record-assets/")) {
    await serveStatic(res, options.webDistDir ?? WEB_DIST_DIR, requestUrl.pathname.replace(/^\/record-assets\//, ""));
    return;
  }

  if (requestUrl.pathname.startsWith("/images/") || requestUrl.pathname.startsWith("/og/")) {
    await serveStatic(res, options.siteDistDir ?? SITE_DIST_DIR, requestUrl.pathname.slice(1));
    return;
  }

  // Hugo-owned SEO / favicon / manifest / sitemap files at the site root.
  // The React record viewer fallback below would otherwise swallow them.
  if (SITE_ROOT_STATIC_FILES.has(requestUrl.pathname)) {
    await serveStatic(res, options.siteDistDir ?? SITE_DIST_DIR, requestUrl.pathname.slice(1));
    return;
  }

  if (requestUrl.pathname === "/docs") {
    res.statusCode = 301;
    res.setHeader("location", "/docs/");
    res.end();
    return;
  }

  if (requestUrl.pathname === "/" || requestUrl.pathname.startsWith("/docs/")) {
    const relative = requestUrl.pathname === "/" ? "index.html" : join(requestUrl.pathname.slice(1), "index.html");
    await serveStatic(res, options.siteDistDir ?? SITE_DIST_DIR, relative);
    return;
  }

  // Every remaining path is the record app: /write, or a record address. An
  // address with no stored record still gets the app shell (so it can explain
  // that nothing is there) but with a 404 status, so browsers and crawlers do
  // not treat a broken link as a page that exists. When the lookup itself
  // fails, the shell is served with 200 and the app reports the failure.
  const slug = requestUrl.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  if (slug !== "" && slug !== "write" && !(await recordExistsOrUnknown(options.store, slug))) {
    await serveStatic(res, options.webDistDir ?? WEB_DIST_DIR, "index.html", 404);
    return;
  }
  await serveStatic(res, options.webDistDir ?? WEB_DIST_DIR, "index.html");
}

async function recordExistsOrUnknown(store: Pick<RecordStore, "recordExists">, slug: string): Promise<boolean> {
  try {
    return await store.recordExists(slug);
  } catch (error) {
    console.error(error);
    return true;
  }
}

// Files that live at the root of the Hugo site (apps/site/static/) and would
// otherwise fall through to the React record viewer's `index.html`. Crawlers
// and browsers fetch these by exact path; the set is small and stable.
const SITE_ROOT_STATIC_FILES = new Set<string>([
  "/sitemap.xml",
  "/robots.txt",
  "/site.webmanifest",
  "/favicon.svg",
  "/favicon.ico",
  "/favicon-32.png",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
]);

export async function toFetchRequest(req: IncomingMessage, url: URL, maxBodyBytes = DEFAULT_RECORD_BODY_LIMIT_BYTES): Promise<Request> {
  const contentLength = req.headers["content-length"];
  if (typeof contentLength === "string" && Number(contentLength) > maxBodyBytes) {
    throw new RequestBodyTooLargeError(maxBodyBytes);
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBodyBytes) throw new RequestBodyTooLargeError(maxBodyBytes);
    chunks.push(buffer);
  }
  return new Request(url, {
    method: req.method,
    headers: req.headers as HeadersInit,
    body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
  });
}

async function writeFetchResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(Buffer.from(await response.arrayBuffer()));
}

async function serveStatic(res: ServerResponse, root: string, relativePath: string, status = 200): Promise<void> {
  const safeRelative = normalize(relativePath).replace(/^(\.\.[/\\])+/, "");
  const path = join(root, safeRelative);
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("not a file");
    res.statusCode = status;
    res.setHeader("content-type", contentType(path));
    const stream = createReadStream(path);
    stream.on("error", (error) => {
      console.error(error);
      if (!res.headersSent) json(res, 500, { error: "internal_server_error" });
      else res.destroy();
    });
    stream.pipe(res);
  } catch {
    json(res, 404, { error: "not_found" });
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function contentType(path: string): string {
  switch (extname(path)) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".webp": return "image/webp";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".png": return "image/png";
    case ".gif": return "image/gif";
    case ".ico": return "image/x-icon";
    case ".txt": return "text/plain; charset=utf-8";
    case ".xml": return "application/xml; charset=utf-8";
    case ".webmanifest": return "application/manifest+json";
    default: return "application/octet-stream";
  }
}

function isUndefinedTableError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "42P01";
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  return parseOptionalPositiveInteger(value) ?? fallback;
}

function parseOptionalPositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export async function main(): Promise<void> {
  if (!DATABASE_URL) throw new Error("DATABASE_URL is required");

  const { Pool } = pg;
  const pool = new Pool({ connectionString: DATABASE_URL, ...createPoolConfig() });
  const store = new PostgresRecordStore(pool as PostgresDatabase);
  const api = createIngestApi({ store, baseUrl: PUBLIC_BASE_URL });
  const requiredMigrationVersions = (await loadSqlMigrations()).map((migration) => migration.version);
  const server = createRuntimeServer({
    api,
    store,
    db: pool as PostgresDatabase,
    recordBodyLimitBytes: RECORD_BODY_LIMIT_BYTES,
    checkpointBodyLimitBytes: parsePositiveInteger(process.env.CHECKPOINT_BODY_LIMIT_BYTES, DEFAULT_CHECKPOINT_BODY_LIMIT_BYTES),
    maxInFlightApiRequests: parsePositiveInteger(process.env.MAX_IN_FLIGHT_API_REQUESTS, DEFAULT_MAX_IN_FLIGHT_API_REQUESTS),
    httpRequestTimeoutMs: parsePositiveInteger(process.env.HTTP_REQUEST_TIMEOUT_MS, DEFAULT_HTTP_REQUEST_TIMEOUT_MS),
    requiredMigrationVersions,
  });
  installGracefulShutdown(server, pool);
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`possiblymadebyahuman listening on 0.0.0.0:${PORT}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
