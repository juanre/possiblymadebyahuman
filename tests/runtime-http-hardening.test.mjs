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
