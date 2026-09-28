import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CLIENT_LIMITS } from "../apps/ingest-api/src/admission.ts";
import { createRuntimeServer, DEFAULT_POOL_MAX, RECORD_APP_CSP, runtimeLimitsFromEnv, SITE_CSP } from "../apps/ingest-api/src/server.ts";

async function runtime(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "pmbah-http-"));
  const siteDistDir = join(root, "site"), webDistDir = join(root, "web");
  await mkdir(join(siteDistDir, "docs"), { recursive: true });
  await mkdir(webDistDir, { recursive: true });
  await writeFile(join(siteDistDir, "index.html"), "<!doctype html><h1>home</h1>");
  await writeFile(join(siteDistDir, "docs", "index.html"), "<!doctype html><h1>docs</h1>");
  await writeFile(join(webDistDir, "index.html"), "<!doctype html><div id=\"root\"></div>");
  const server = createRuntimeServer({ api: { handleRequest: async () => new Response("{}") }, store: { recordExists: async () => false },
    db: { query: async () => ({ rows: [] }) }, siteDistDir, webDistDir, ...options });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("HEAD answers every GET route with the GET status and headers but no body", async t => {
  const base = await runtime(t);
  for (const path of ["/health", "/live", "/ready", "/", "/docs/", "/write", "/unknown-record"]) {
    const get = await fetch(`${base}${path}`);
    const head = await fetch(`${base}${path}`, { method: "HEAD" });
    assert.equal(head.status, get.status, path);
    assert.equal(head.headers.get("content-type"), get.headers.get("content-type"), path);
    assert.equal(await head.text(), "", path);
  }
  assert.equal((await fetch(`${base}/health`, { method: "HEAD" })).status, 200);
});

test("every response carries security headers, with a strict policy for the record app", async t => {
  const base = await runtime(t, { publicBaseUrl: "http://localhost:8000" });
  for (const path of ["/", "/docs/", "/write", "/unknown-record", "/health", "/api/records/x", "/record-assets/missing.js", "/docs/missing/"]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", path);
    assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin", path);
    assert.equal(response.headers.get("x-frame-options"), "DENY", path);
    assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/, path);
    assert.equal(response.headers.get("strict-transport-security"), null, `${path} is not HTTPS`);
  }
  for (const path of ["/write", "/unknown-record"]) {
    const policy = (await fetch(`${base}${path}`)).headers.get("content-security-policy");
    assert.equal(policy, RECORD_APP_CSP, path);
    assert.doesNotMatch(policy, /unsafe/, path);
    for (const directive of ["default-src 'self'", "script-src 'self'", "style-src 'self'", "worker-src 'self'", "object-src 'none'", "base-uri 'none'"]) {
      assert.ok(policy.split("; ").includes(directive), `${path} ${directive}`);
    }
  }
  for (const path of ["/", "/docs/"]) {
    const policy = (await fetch(`${base}${path}`)).headers.get("content-security-policy");
    assert.equal(policy, SITE_CSP, path);
    assert.ok(policy.split("; ").includes("script-src 'self'"), `${path} scripts stay strict`);
  }
});

test("HSTS is sent only when the public origin is HTTPS", async t => {
  const base = await runtime(t, { publicBaseUrl: "https://possiblymadebyahuman.com" });
  for (const path of ["/", "/health", "/api/records/x"]) {
    assert.equal((await fetch(`${base}${path}`)).headers.get("strict-transport-security"), "max-age=31536000", path);
  }
});

const JSON_TYPE = { "content-type": "application/json" };
const TIGHT = { maxInFlightPerClient: 4, writesPerMinute: 1, writeBurst: 2, newSessionsPerMinute: 1, newSessionBurst: 1, maxTrackedClients: 100 };
const post = (base, path, client, body = "{}") => fetch(`${base}${path}`, { method: "POST", headers: { ...JSON_TYPE, ...(client ? { "cf-connecting-ip": client } : {}) }, body });

test("per-client write limits answer 429 with retry-after while other clients and reads continue", async t => {
  let handled = 0;
  const base = await runtime(t, { api: { handleRequest: async () => { handled++; return new Response("{}"); } },
    clientLimits: { ...TIGHT, newSessionBurst: 100 }, trustedClientIpHeader: "cf-connecting-ip" });
  const chunk = "/api/record-uploads/00000000-0000-4000-8000-000000000001/chunks";
  assert.equal((await post(base, chunk, "198.51.100.1")).status, 200);
  assert.equal((await post(base, chunk, "198.51.100.1")).status, 200);
  const limited = await post(base, chunk, "198.51.100.1");
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  assert.deepEqual(await limited.json(), { error: "rate_limited" });
  assert.equal((await fetch(`${base}/api/records/abc`, { headers: { "cf-connecting-ip": "198.51.100.1" } })).status, 200, "reads are not write-limited");
  assert.equal((await post(base, chunk, "198.51.100.2")).status, 200);
  assert.equal(handled, 4);
});

test("forwarded client addresses are ignored unless the header is explicitly trusted", async t => {
  const base = await runtime(t, { clientLimits: { ...TIGHT, newSessionBurst: 100 } });
  const chunk = "/api/record-uploads/00000000-0000-4000-8000-000000000001/chunks";
  assert.equal((await post(base, chunk, "198.51.100.1")).status, 200);
  assert.equal((await post(base, chunk, "198.51.100.2")).status, 200);
  assert.equal((await post(base, chunk, "198.51.100.3")).status, 429, "a spoofed header does not buy a fresh bucket");
});

test("one client cannot hold more than its share of in-flight API requests", async t => {
  let release, calls = 0;
  const held = new Promise(resolve => { release = resolve; });
  const base = await runtime(t, { api: { handleRequest: async () => { calls++; await held; return new Response("{}"); } },
    clientLimits: { ...TIGHT, maxInFlightPerClient: 1, writeBurst: 100 }, trustedClientIpHeader: "cf-connecting-ip" });
  const first = fetch(`${base}/api/records/a`, { headers: { "cf-connecting-ip": "198.51.100.1" } });
  while (calls === 0) await new Promise(resolve => setTimeout(resolve, 5));
  const second = await fetch(`${base}/api/records/b`, { headers: { "cf-connecting-ip": "198.51.100.1" } });
  assert.equal(second.status, 429);
  assert.equal((await second.json()).error, "rate_limited");
  const other = fetch(`${base}/api/records/c`, { headers: { "cf-connecting-ip": "198.51.100.2" } });
  while (calls < 2) await new Promise(resolve => setTimeout(resolve, 5));
  release();
  assert.equal((await first).status, 200);
  assert.equal((await other).status, 200);
  assert.equal((await fetch(`${base}/api/records/d`, { headers: { "cf-connecting-ip": "198.51.100.1" } })).status, 200, "capacity is released");
});

test("starting uploads, observed sessions and direct records spends the stricter new-session bucket", async t => {
  const base = await runtime(t, { clientLimits: { ...TIGHT, writeBurst: 100 }, trustedClientIpHeader: "cf-connecting-ip" });
  const client = "198.51.100.7", upload = "/api/record-uploads/00000000-0000-4000-8000-000000000001";
  const checkpoint = "/api/observed-sessions/00000000-0000-4000-8000-000000000001/checkpoints";
  assert.equal((await post(base, "/api/record-uploads", client)).status, 200);
  const limited = await post(base, "/api/record-uploads", client);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  assert.deepEqual(await limited.json(), { error: "rate_limited" });
  assert.equal((await post(base, "/api/records", client)).status, 429);
  assert.equal((await post(base, checkpoint, client, JSON.stringify({ event_count: 1, chain_tip: "b3:x" }))).status, 429, "a checkpoint without a token starts a session");
  assert.equal((await post(base, checkpoint, client, JSON.stringify({ event_count: 2, chain_tip: "b3:x", token: "t".repeat(43) }))).status, 200);
  assert.equal((await post(base, `${upload}/chunks`, client)).status, 200);
  assert.equal((await post(base, `${upload}/finalize`, client)).status, 200);
  assert.equal((await post(base, "/api/record-uploads", "198.51.100.8")).status, 200);
});

test("runtime limits derive the global API cap from the database pool and read client limits from the environment", () => {
  assert.equal(runtimeLimitsFromEnv({}).maxInFlightApiRequests, DEFAULT_POOL_MAX * 4);
  assert.equal(runtimeLimitsFromEnv({ PG_POOL_MAX: "10" }).maxInFlightApiRequests, 40);
  assert.equal(runtimeLimitsFromEnv({ PG_POOL_MAX: "10", MAX_IN_FLIGHT_API_REQUESTS: "7" }).maxInFlightApiRequests, 7);
  assert.deepEqual(runtimeLimitsFromEnv({}).clientLimits, DEFAULT_CLIENT_LIMITS);
  assert.equal(runtimeLimitsFromEnv({}).trustedClientIpHeader, undefined);
  const configured = runtimeLimitsFromEnv({ TRUSTED_CLIENT_IP_HEADER: "CF-Connecting-IP", MAX_IN_FLIGHT_API_REQUESTS_PER_CLIENT: "3",
    RATE_LIMIT_WRITES_PER_MINUTE: "900", RATE_LIMIT_WRITE_BURST: "90", RATE_LIMIT_NEW_SESSIONS_PER_MINUTE: "12", RATE_LIMIT_NEW_SESSION_BURST: "6" });
  assert.equal(configured.trustedClientIpHeader, "cf-connecting-ip");
  assert.deepEqual(configured.clientLimits, { ...DEFAULT_CLIENT_LIMITS, maxInFlightPerClient: 3, writesPerMinute: 900, writeBurst: 90, newSessionsPerMinute: 12, newSessionBurst: 6 });
});

test("API writes require a JSON media type before the body is buffered or handled", async t => {
  let handled = 0;
  const base = await runtime(t, { api: { handleRequest: async () => { handled++; return new Response("{}"); } } });
  const routes = ["/api/records", "/api/record-uploads", "/api/record-uploads/00000000-0000-4000-8000-000000000001/chunks",
    "/api/record-uploads/00000000-0000-4000-8000-000000000001/finalize", "/api/observed-sessions/00000000-0000-4000-8000-000000000001/checkpoints"];
  for (const path of routes) {
    for (const headers of [{ "content-type": "text/plain" }, { "content-type": "application/x-www-form-urlencoded" }, { "content-type": "multipart/form-data; boundary=x" },
      { "content-type": "application/jsonp" }, {}]) {
      const response = await fetch(`${base}${path}`, { method: "POST", headers, body: headers["content-type"] ? "{}" : new Uint8Array([123, 125]) });
      assert.equal(response.status, 415, `${path} ${JSON.stringify(headers)}`);
      assert.deepEqual(await response.json(), { error: "unsupported_media_type" });
    }
    for (const type of ["application/json", "application/json; charset=utf-8", "Application/JSON;charset=UTF-8"]) {
      assert.equal((await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": type }, body: "{}" })).status, 200, `${path} ${type}`);
    }
  }
  assert.equal(handled, routes.length * 3);
});
