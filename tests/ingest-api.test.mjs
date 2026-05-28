import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

import { createIngestApi } from "../apps/ingest-api/src/index.ts";
import { InMemoryRecordStore } from "../packages/storage/src/index.ts";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const clone = (value) => JSON.parse(JSON.stringify(value));

async function fixtureRecord() {
  const [golden] = await readJson("packages/conformance/vectors/golden-records.json");
  return clone(golden.record);
}

function makeApi() {
  const store = new InMemoryRecordStore();
  const api = createIngestApi({
    store,
    baseUrl: "https://possiblymadebyahuman.test",
    now: () => new Date("2026-05-28T10:00:00.000Z"),
  });
  return { api, store };
}

test("Postgres migration defines records, stats, and analysis-results tables", async () => {
  await access("packages/storage/migrations/001_init.sql");
  const migration = await readFile("packages/storage/migrations/001_init.sql", "utf8");
  assert.match(migration, /create table if not exists records/i);
  assert.match(migration, /create table if not exists record_stats/i);
  assert.match(migration, /create table if not exists analysis_results/i);
  assert.match(migration, /parent_record_hash\s+text null references records\(record_hash\)/i);
  assert.doesNotMatch(migration, /plaintext|final_text\s+text/i);
});

test("POST /api/records ingests a valid content-blind record", async () => {
  const { api } = makeApi();
  const record = await fixtureRecord();
  const response = await api.postRecord(record);

  assert.equal(response.status, 201);
  assert.equal(response.body.record_hash, record.manifest.record_hash);
  assert.match(response.body.short_signature, /^[1-9A-HJ-NP-Za-km-z]{10,}$/);
  assert.equal(response.body.url, `https://possiblymadebyahuman.test/${response.body.short_signature}`);
  assert.equal(response.body.created, true);
});

test("GET /api/records/:id supports short signature and full hash lookup", async () => {
  const { api } = makeApi();
  const record = await fixtureRecord();
  const ingest = await api.postRecord(record);
  assert.equal(ingest.status, 201);

  const byShort = await api.getRecord(ingest.body.short_signature);
  assert.equal(byShort.status, 200);
  assert.equal(byShort.body.manifest.record_hash, record.manifest.record_hash);
  assert.equal(byShort.body.manifest.ingested_server_t, "2026-05-28T10:00:00.000Z");
  assert.deepEqual(byShort.body.events, record.events);
  assert.deepEqual(byShort.body.signals, []);

  const byHash = await api.getRecord(record.manifest.record_hash);
  assert.equal(byHash.status, 200);
  assert.deepEqual(byHash.body, byShort.body);
});

test("ingest rejects invalid record hashes", async () => {
  const { api } = makeApi();
  const record = await fixtureRecord();
  record.manifest.record_hash = "b3:0000000000000000000000000000000000000000000000000000000000000000";

  const response = await api.postRecord(record);
  assert.equal(response.status, 400);
  assert.equal(response.body.error, "verification_failed");
  assert.ok(response.body.details.some((detail) => detail.includes("record_hash mismatch")));
});

test("stats are computed and persisted with meaningful fields", async () => {
  const { api } = makeApi();
  const record = await fixtureRecord();
  const ingest = await api.postRecord(record);
  const fetched = await api.getRecord(ingest.body.short_signature);

  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.stats.record_hash, record.manifest.record_hash);
  assert.equal(fetched.body.stats.event_count, 4);
  assert.equal(fetched.body.stats.duration_ms, 240);
  assert.equal(fetched.body.stats.final_text_length, 8);
  assert.equal(fetched.body.stats.insert_op_count, 3);
  assert.equal(fetched.body.stats.delete_op_count, 1);
  assert.equal(fetched.body.stats.replace_op_count, 0);
  assert.equal(fetched.body.stats.typed_event_count, 2);
  assert.equal(fetched.body.stats.paste_event_count, 1);
  assert.equal(fetched.body.stats.cut_event_count, 1);
  assert.equal(fetched.body.stats.inserted_codepoints_total, 9);
  assert.equal(fetched.body.stats.deleted_codepoints_total, 1);
  assert.equal(fetched.body.stats.largest_atomic_insert_codepoints, 6);
  assert.equal(fetched.body.stats.inter_event_delay_min_ms, 60);
  assert.equal(fetched.body.stats.inter_event_delay_p50_ms, 60);
  assert.equal(fetched.body.stats.inter_event_delay_max_ms, 120);
  assert.equal(fetched.body.stats.active_time_ms, 240);
  assert.equal(fetched.body.stats.idle_time_ms, 0);
  assert.equal(fetched.body.stats.long_pause_count, 0);
  assert.ok(Array.isArray(fetched.body.stats.delay_histogram));
});

test("duplicate ingest is immutable and idempotent", async () => {
  const { api } = makeApi();
  const record = await fixtureRecord();
  const first = await api.postRecord(record);
  const second = await api.postRecord(record);

  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.body.created, false);
  assert.equal(second.body.short_signature, first.body.short_signature);
});

test("public ingest rejects plaintext/content-bearing fields", async () => {
  const { api } = makeApi();
  const record = await fixtureRecord();
  record.events[0].ins_text = "Hi";

  const response = await api.postRecord(record);
  assert.equal(response.status, 400);
  assert.equal(response.body.error, "content_not_allowed");
  assert.ok(response.body.details.some((detail) => detail.includes("ins_text")));
});

test("fetch handler exposes health, POST, and GET endpoint shapes", async () => {
  const { api } = makeApi();
  const health = await api.handleRequest(new Request("https://possiblymadebyahuman.test/api/health"));
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  const record = await fixtureRecord();
  const post = await api.handleRequest(new Request("https://possiblymadebyahuman.test/api/records", {
    method: "POST",
    body: JSON.stringify(record),
  }));
  assert.equal(post.status, 201);
  const postBody = await post.json();

  const get = await api.handleRequest(new Request(`https://possiblymadebyahuman.test/api/records/${postBody.short_signature}`));
  assert.equal(get.status, 200);
  const getBody = await get.json();
  assert.equal(getBody.manifest.record_hash, record.manifest.record_hash);
});

test("fetch handler does not expose a public DELETE endpoint", async () => {
  const { api } = makeApi();
  const response = await api.handleRequest(new Request("https://possiblymadebyahuman.test/api/records/example", {
    method: "DELETE",
  }));
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not_found" });
});
