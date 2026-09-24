import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { createRuntimeServer, DEFAULT_CHECKPOINT_BODY_LIMIT_BYTES, DEFAULT_HTTP_REQUEST_TIMEOUT_MS } from "../apps/ingest-api/src/server.ts";
import { InMemoryRecordStore } from "../packages/storage/src/index.ts";

async function runtime(t, handleRequest, options = {}) {
  const server = createRuntimeServer({ api: { handleRequest }, store: new InMemoryRecordStore(),
    db: { query: async () => ({ rows: [] }) }, ...options });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

function incompleteRequest(url, length, path) {
  let request;
  const response = new Promise((resolve, reject) => {
    request = httpRequest(url, { method: "POST", ...(path ? { path } : {}), headers: { "content-length": String(length) } }, result => {
      const chunks = [];
      result.on("data", chunk => chunks.push(chunk));
      result.on("end", () => resolve({ status: result.statusCode, headers: result.headers, body: Buffer.concat(chunks).toString() }));
      result.on("error", reject);
    });
    request.on("error", reject);
    request.flushHeaders();
  });
  return { request, response };
}

test("checkpoint requests have a smaller body allowance than full records", async t => {
  let handled = 0;
  const { base, server } = await runtime(t, async () => { handled++; return new Response("{}"); },
    { checkpointBodyLimitBytes: 16, recordBodyLimitBytes: 64 });
  assert.equal(DEFAULT_CHECKPOINT_BODY_LIMIT_BYTES, 16_384);
  assert.equal(server.requestTimeout, DEFAULT_HTTP_REQUEST_TIMEOUT_MS);
  const checkpoint = `${base}/api/observed-sessions/00000000-0000-4000-8000-000000000001/checkpoints`;
  const rejected = await fetch(checkpoint, { method: "POST", body: "x".repeat(17) });
  assert.equal(rejected.status, 413);
  assert.deepEqual(await rejected.json(), { error: "request_body_too_large", max_bytes: 16 });
  assert.equal(handled, 0);
  assert.equal((await fetch(`${base}/api/records`, { method: "POST", body: "x".repeat(17) })).status, 200);
  assert.equal((await fetch(checkpoint, { method: "POST", body: "{}" })).status, 200);
  assert.equal(handled, 2);
});

test("API admission rejects before buffering and releases capacity after success and failure", async t => {
  let release, started, calls = 0;
  const entered = new Promise(resolve => { started = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const { base } = await runtime(t, async () => {
    calls++;
    if (calls === 1) { started(); await held; }
    return new Response("{}");
  }, { maxInFlightApiRequests: 1, recordBodyLimitBytes: 5 });
  const first = fetch(`${base}/api/records`, { method: "POST", body: "{}" });
  await entered;
  const unfinished = incompleteRequest(`${base}/api/records`, 100_000);
  try {
    const rejected = await unfinished.response;
    assert.equal(rejected.status, 503, "admission happens before waiting for the unfinished body");
    assert.equal(rejected.headers["retry-after"], "1");
    assert.equal(JSON.parse(rejected.body).error, "server_busy");
    assert.equal(calls, 1);
    for (const path of [`${base}/api/records`, "/unrelated/../api/records", "//api/records"]) {
      const normalized = incompleteRequest(base, 100_000, path);
      try { assert.equal((await normalized.response).status, 503, `normalized API path is admitted consistently: ${path}`); }
      finally { normalized.request.destroy(); }
    }
    assert.equal((await fetch(`${base}/health`)).status, 200, "liveness remains available during overload");
  } finally { unfinished.request.destroy(); release(); }
  assert.equal((await first).status, 200);
  assert.equal((await fetch(`${base}/api/records`, { method: "POST", body: "too big" })).status, 413);
  assert.equal((await fetch(`${base}/api/records`, { method: "POST", body: "{}" })).status, 200);
  assert.equal(calls, 2);
});

test("slow unfinished bodies time out and release their API admission slot", async t => {
  let calls = 0;
  const { base, server } = await runtime(t, async () => { calls++; return new Response("{}"); },
    { maxInFlightApiRequests: 1, httpRequestTimeoutMs: 50 });
  assert.equal(server.requestTimeout, 50);
  assert.equal(server.headersTimeout, 50);
  const unfinished = incompleteRequest(`${base}/api/records`, 100);
  t.after(() => unfinished.request.destroy());
  const response = await unfinished.response;
  assert.equal(response.status, 408);
  assert.equal(calls, 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await fetch(`${base}/api/records`, { method: "POST", body: "{}" })).status, 200);
  assert.equal(calls, 1);
});

test("resumable upload bodies stay bounded independently of legacy record allowances", async t => {
  let handled = 0;
  const { base } = await runtime(t, async () => { handled++; return new Response("{}"); }, { recordBodyLimitBytes: 2 * 1024 * 1024 });
  for (const route of ["record-uploads", "record-uploads/00000000-0000-4000-8000-000000000001/chunks"]) {
    const response = await fetch(`${base}/api/${route}`, { method: "POST", body: "x".repeat(1024 * 1024 + 1) });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).max_bytes, 1024 * 1024);
  }
  assert.equal(handled, 0);
  assert.equal((await fetch(`${base}/api/record-uploads`, { method: "POST", body: "{}" })).status, 200);
  assert.equal(handled, 1);
});
