import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntimeServer } from "../apps/ingest-api/src/server.ts";

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
