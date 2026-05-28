import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import pg from "pg";

import { createIngestApi } from "./index.ts";
import { PostgresRecordStore, type PostgresQueryable } from "../../../packages/storage/src/index.ts";

const PORT = Number(process.env.PORT ?? 8000);
const DATABASE_URL = process.env.DATABASE_URL;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`;
const WEB_DIST_DIR = process.env.WEB_DIST_DIR ?? "/app/web/dist";
const SITE_DIST_DIR = process.env.SITE_DIST_DIR ?? "/app/site/public";

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const { Client } = pg;
const db = new Client({ connectionString: DATABASE_URL });
await db.connect();

const store = new PostgresRecordStore(db as PostgresQueryable);
const api = createIngestApi({ store, baseUrl: PUBLIC_BASE_URL });

const server = createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    console.error(error);
    json(res, 500, { error: "internal_server_error" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`possiblymadebyahuman listening on 0.0.0.0:${PORT}`);
});

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (requestUrl.pathname.startsWith("/api/")) {
    const response = await api.handleRequest(await toFetchRequest(req, requestUrl));
    await writeFetchResponse(res, response);
    return;
  }

  if (req.method === "GET" && (requestUrl.pathname === "/health" || requestUrl.pathname === "/live")) {
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/ready") {
    const ready = await readiness();
    json(res, ready.ok ? 200 : 503, ready);
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    json(res, 405, { error: "method_not_allowed" });
    return;
  }

  if (requestUrl.pathname.startsWith("/record-assets/")) {
    await serveStatic(res, WEB_DIST_DIR, requestUrl.pathname.replace(/^\/record-assets\//, ""));
    return;
  }

  if (requestUrl.pathname === "/" || requestUrl.pathname.startsWith("/docs/") || requestUrl.pathname.startsWith("/blog/")) {
    const relative = requestUrl.pathname === "/" ? "index.html" : join(requestUrl.pathname.slice(1), "index.html");
    await serveStatic(res, SITE_DIST_DIR, relative);
    return;
  }

  await serveStatic(res, WEB_DIST_DIR, "index.html");
}

async function readiness(): Promise<{ ok: boolean; database: boolean; migrations: boolean }> {
  try {
    const result = await db.query<{ records_ready: string | null; stats_ready: string | null; analysis_ready: string | null }>(
      "select to_regclass('public.records')::text as records_ready, to_regclass('public.record_stats')::text as stats_ready, to_regclass('public.analysis_results')::text as analysis_ready",
    );
    const row = result.rows[0];
    const migrations = Boolean(row?.records_ready && row.stats_ready && row.analysis_ready);
    return { ok: migrations, database: true, migrations };
  } catch {
    return { ok: false, database: false, migrations: false };
  }
}

async function toFetchRequest(req: IncomingMessage, url: URL): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
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
