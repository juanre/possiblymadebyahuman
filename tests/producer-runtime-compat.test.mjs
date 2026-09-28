import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createIngestApi } from "../apps/ingest-api/src/index.ts";
import { createRuntimeServer } from "../apps/ingest-api/src/server.ts";
import { uploadJournal } from "../packages/browser-storage/src/upload.ts";
import { DEFAULT_CLIENT_LIMITS } from "../apps/ingest-api/src/admission.ts";
import { InMemoryRecordStore } from "../packages/storage/src/index.ts";
import { buildJournalManifest, publishJournal } from "../producers/emacs/scripts/event-journal.mjs";

const elapsed = 2 * 365 * 24 * 60 * 60 * 1000;
const eventsFor = count => Array.from({ length: count }, (_, seq) => ({ seq, t: Math.floor(seq * elapsed / Math.max(1, count - 1)), op: "insert", pos: seq, del_len: 0, ins_len: 1, source: "typing" }));

async function journal(t, count) {
  const directory = await mkdtemp(join(tmpdir(), "pmbah-producer-runtime-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const events = eventsFor(count), path = join(directory, "events.jsonl");
  await writeFile(path, events.map(event => `${JSON.stringify(event)}\n`).join(""));
  const built = await buildJournalManifest({ journal_path: path, session_id: randomUUID(), format_version: "0.3", event_count: count, duration_ms: elapsed,
    created_client_t: "2024-09-23T00:00:00.000Z", producer: { id: "emacs", version: "0.1.0", capabilities: ["timing", "pause_fidelity"] } });
  return { ...built, events, path };
}

async function producerRuntime(t, options = {}) {
  const store = new InMemoryRecordStore();
  const server = createRuntimeServer({ api: createIngestApi({ store }), store, db: { query: async () => ({ rows: [] }) }, ...options });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { store, base: `http://127.0.0.1:${server.address().port}` };
}

test("Emacs and browser journal publication succeed through the runtime server", async t => {
  const { base } = await producerRuntime(t);
  const emacs = await journal(t, 9000);
  const published = await publishJournal({ ...emacs, journal_path: emacs.path, end_byte: emacs.byte_length, upload_id: randomUUID(), api_base_url: base });
  assert.equal(published.created, true);
  assert.equal(published.record_hash, emacs.manifest.record_hash);

  const browser = await journal(t, 5000);
  const uploaded = await uploadJournal({ endpoint: `${base}/api/record-uploads`, fetch,
    payload: { upload_id: randomUUID(), manifest: browser.manifest, observation: { state: "unobserved" } },
    readEvents: async (start, count) => browser.events.slice(start, start + count) });
  assert.equal(uploaded.created, true);
  assert.equal(uploaded.record_hash, browser.manifest.record_hash);
});

test("journal publication waits out write rate limits instead of failing the upload", async t => {
  const { base } = await producerRuntime(t, { clientLimits: { ...DEFAULT_CLIENT_LIMITS, writesPerMinute: 120, writeBurst: 1 } });
  const statuses = [], original = globalThis.fetch;
  const counting = async (url, init) => { const response = await original(url, init); statuses.push(response.status); return response; };
  const browser = await journal(t, 5000);
  const uploaded = await uploadJournal({ endpoint: `${base}/api/record-uploads`, fetch: counting,
    payload: { upload_id: randomUUID(), manifest: browser.manifest, observation: { state: "unobserved" } },
    readEvents: async (start, count) => browser.events.slice(start, start + count) });
  assert.equal(uploaded.record_hash, browser.manifest.record_hash);
  assert.ok(statuses.includes(429), `browser upload was rate limited: ${statuses}`);

  statuses.length = 0;
  globalThis.fetch = counting;
  t.after(() => { globalThis.fetch = original; });
  const emacs = await journal(t, 5000);
  const published = await publishJournal({ ...emacs, journal_path: emacs.path, end_byte: emacs.byte_length, upload_id: randomUUID(), api_base_url: base });
  globalThis.fetch = original;
  assert.equal(published.record_hash, emacs.manifest.record_hash);
  assert.ok(statuses.includes(429), `Emacs upload was rate limited: ${statuses}`);
});
