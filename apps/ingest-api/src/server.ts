import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { extname, join, normalize } from "node:path";
import pg from "pg";

import { createIngestApi } from "./index.ts";
import { PostgresRecordStore, type PostgresDatabase } from "../../../packages/storage/src/index.ts";

export const DEFAULT_RECORD_BODY_LIMIT_BYTES = 1_000_000;
export const DEFAULT_POOL_MAX = 5;
export const DEFAULT_POOL_IDLE_TIMEOUT_MS = 30_000;
export const DEFAULT_POOL_CONNECTION_TIMEOUT_MS = 5_000;

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

  const statementTimeout = parseOptionalPositiveInteger(env.PG_STATEMENT_TIMEOUT_MS ?? env.PG_QUERY_TIMEOUT_MS);
  if (statementTimeout !== undefined) {
    config.statement_timeout = statementTimeout;
    config.query_timeout = statementTimeout;
  }
  return config;
}

export function createRuntimeServer(options: {
  api: ReturnType<typeof createIngestApi>;
  db: PostgresDatabase;
  webDistDir?: string;
  siteDistDir?: string;
  recordBodyLimitBytes?: number;
}): Server {
  const server = createServer(async (req, res) => {
    try {
      await route(req, res, options);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        json(res, 413, { error: "request_body_too_large", max_bytes: error.limitBytes });
        return;
      }
      console.error(error);
      json(res, 500, { error: "internal_server_error" });
    }
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

export async function readiness(db: PostgresDatabase): Promise<Readiness> {
  try {
    const result = await db.query<{
      records_ready: string | null;
      stats_ready: string | null;
      analysis_ready: string | null;
      migrations_ready: string | null;
    }>(
      `select
        to_regclass('public.records')::text as records_ready,
        to_regclass('public.record_stats')::text as stats_ready,
        to_regclass('public.analysis_results')::text as analysis_ready,
        to_regclass('public.schema_migrations')::text as migrations_ready`,
    );
    const row = result.rows[0];
    let migration001 = false;
    if (row?.migrations_ready) {
      const applied = await db.query<{ version: string }>("select version from schema_migrations where version = '001'");
      migration001 = applied.rows.length > 0;
    }
    const migrations = Boolean(row?.records_ready && row.stats_ready && row.analysis_ready && row.migrations_ready && migration001);
    return { ok: migrations, database: true, migrations };
  } catch {
    return { ok: false, database: false, migrations: false };
  }
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    api: ReturnType<typeof createIngestApi>;
    db: PostgresDatabase;
    webDistDir?: string;
    siteDistDir?: string;
    recordBodyLimitBytes?: number;
  },
): Promise<void> {
  const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (requestUrl.pathname.startsWith("/api/")) {
    const response = await options.api.handleRequest(await toFetchRequest(req, requestUrl, options.recordBodyLimitBytes ?? DEFAULT_RECORD_BODY_LIMIT_BYTES));
    await writeFetchResponse(res, response);
    return;
  }

  if (req.method === "GET" && (requestUrl.pathname === "/health" || requestUrl.pathname === "/live")) {
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/ready") {
    const ready = await readiness(options.db);
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

  if (requestUrl.pathname === "/" || requestUrl.pathname.startsWith("/docs/") || requestUrl.pathname.startsWith("/blog/")) {
    const relative = requestUrl.pathname === "/" ? "index.html" : join(requestUrl.pathname.slice(1), "index.html");
    await serveStatic(res, options.siteDistDir ?? SITE_DIST_DIR, relative);
    return;
  }

  await serveStatic(res, options.webDistDir ?? WEB_DIST_DIR, "index.html");
}

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

async function serveStatic(res: ServerResponse, root: string, relativePath: string): Promise<void> {
  const safeRelative = normalize(relativePath).replace(/^(\.\.[/\\])+/, "");
  const path = join(root, safeRelative);
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("not a file");
    res.setHeader("content-type", contentType(path));
    createReadStream(path).pipe(res);
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
    default: return "application/octet-stream";
  }
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  return parseOptionalPositiveInteger(value) ?? fallback;
}

function parseOptionalPositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

async function main(): Promise<void> {
  if (!DATABASE_URL) throw new Error("DATABASE_URL is required");

  const { Pool } = pg;
  const pool = new Pool({ connectionString: DATABASE_URL, ...createPoolConfig() });
  const store = new PostgresRecordStore(pool as PostgresDatabase);
  const api = createIngestApi({ store, baseUrl: PUBLIC_BASE_URL });
  const server = createRuntimeServer({ api, db: pool as PostgresDatabase, recordBodyLimitBytes: RECORD_BODY_LIMIT_BYTES });
  installGracefulShutdown(server, pool);
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`possiblymadebyahuman listening on 0.0.0.0:${PORT}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
