import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

import { createIngestApi, generateShortSignature, isReservedShortSignature } from "../apps/ingest-api/src/index.ts";
import { InMemoryRecordStore, PostgresRecordStore } from "../packages/storage/src/index.ts";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const clone = (value) => JSON.parse(JSON.stringify(value));

async function fixtureRecord() {
  const [golden] = await readJson("packages/conformance/vectors/golden-records.json");
  return clone(golden.record);
}

function makeApi(options = {}) {
  const store = new InMemoryRecordStore();
  const api = createIngestApi({
    store,
    baseUrl: "https://possiblymadebyahuman.test",
    now: () => new Date("2026-05-28T10:00:00.000Z"),
    ...options,
  });
  return { api, store };
}

test("Postgres migration defines records, stats, and analysis-results tables", async () => {
  await access("packages/storage/migrations/001_init.sql");
  const migration = await readFile("packages/storage/migrations/001_init.sql", "utf8");
  const migrateScript = await readFile("apps/ingest-api/scripts/migrate.mjs", "utf8");
  const migrateRuntime = await readFile("apps/ingest-api/src/migrate.ts", "utf8");
  assert.match(migrateScript, /runMigrations/);
  assert.match(migrateRuntime, /applyMigrations/);
  assert.match(migrateRuntime, /loadSqlMigrations/);
  assert.match(migration, /create table if not exists records/i);
  assert.match(migration, /create table if not exists record_stats/i);
  assert.match(migration, /create table if not exists analysis_results/i);
  assert.match(migration, /parent_record_hash\s+text null references records\(record_hash\)/i);
  assert.match(migration, /record_hash\s+text not null references records\(record_hash\) on delete cascade/i);
  assert.doesNotMatch(migration, /records_short_signature_idx/i);
  assert.match(migration, /observed_final_length\s+integer null/i);
  assert.doesNotMatch(migration, /plaintext|final_text\s+text|final_text_hash|final_text_length/i);
});

test("POST /api/records ingests a valid content-opaque record", async () => {
  const { api } = makeApi();
  const record = await fixtureRecord();
  const response = await api.postRecord(record);

  assert.equal(response.status, 201);
  assert.equal(response.body.record_hash, record.manifest.record_hash);
  assert.match(response.body.short_signature, /^[1-9A-HJ-NP-Za-km-z]{10,}$/);
  assert.equal(response.body.url, `https://possiblymadebyahuman.test/${response.body.short_signature}`);
  assert.equal(response.body.created, true);
});

test("short signatures reserve runtime/static route prefixes", () => {
  assert.equal(isReservedShortSignature("apiABC1234"), true);
  assert.equal(isReservedShortSignature("docs123456"), true);
  assert.equal(isReservedShortSignature("record-assetsXYZ"), true);
  assert.equal(isReservedShortSignature("imagesXYZ"), true);
  assert.equal(isReservedShortSignature("K7Qp9dLx2m"), false);
});

test("reserved-prefix hashes deterministically get a safe rescued short signature", async () => {
  const store = new InMemoryRecordStore();
  const signature = await generateShortSignature(
    "b3:8b8a680e94bd0e43419b3f6ac755c2169aa29fb67c485a7b6845c9cc81651f0c",
    store,
  );
  assert.equal(signature, "XAPi5VHjgR");
  assert.equal(signature.startsWith("X"), true);
  assert.equal(isReservedShortSignature(signature), false);
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
  assert.equal(byShort.body.signals.length, 2);
  assert.deepEqual(byShort.body.signals.map((signal) => signal.analyzer_id), ["timing-distribution", "edit-topology"]);

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
  assert.equal(fetched.body.stats.observed_final_length, 8);
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
  assert.equal(fetched.body.signals.length, 2);
  assert.equal(fetched.body.signals[0].analyzer_id, "timing-distribution");
  assert.equal(fetched.body.signals[1].analyzer_id, "edit-topology");
});

test("ingest stores explicit-null unknown process measurements", async () => {
  const { api } = makeApi();
  const record = await fixtureRecord();
  const [, nullVector] = await readJson("packages/conformance/vectors/hash-chain.json");
  record.events = clone(nullVector.events);
  record.manifest.record_hash = nullVector.record_hash;
  record.manifest.event_count = record.events.length;
  record.manifest.duration_ms = 10;

  const ingest = await api.postRecord(record);
  assert.equal(ingest.status, 201);
  const fetched = await api.getRecord(ingest.body.short_signature);

  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.events[1].pos, null);
  assert.equal(fetched.body.events[1].del_len, null);
  assert.equal(fetched.body.events[1].ins_len, null);
  assert.equal(fetched.body.stats.observed_final_length, null);
  assert.equal(fetched.body.stats.inserted_codepoints_total, 3);
  const topology = fetched.body.signals.find((signal) => signal.analyzer_id === "edit-topology");
  assert.equal(topology.measures.find((measure) => measure.key === "unknown_process_measurement_count")?.value, 1);
});

test("buggy analyzers do not block ingestion or mutate stored records", async () => {
  const record = await fixtureRecord();
  const originalEvents = clone(record.events);
  const { api } = makeApi({
    analyzers: [
      {
        id: "buggy-mutator",
        version: "0.0.0",
        analyze(input) {
          input.events[0].ins_len = 999;
          return { analyzer_id: "buggy-mutator", analyzer_version: "0.0.0", applicable: true, measures: [], explanation: "mutated" };
        },
      },
      {
        id: "storage-observer",
        version: "0.0.0",
        analyze(input) {
          return {
            analyzer_id: "storage-observer",
            analyzer_version: "0.0.0",
            applicable: true,
            measures: [{ key: "first_insert_len", value: input.events[0].ins_len }],
            explanation: "Observed the record shape after a failed analyzer.",
          };
        },
      },
    ],
  });

  const ingest = await api.postRecord(record);
  assert.equal(ingest.status, 201);
  const fetched = await api.getRecord(ingest.body.short_signature);
  assert.equal(fetched.status, 200);
  assert.deepEqual(fetched.body.events, originalEvents);
  assert.deepEqual(fetched.body.signals.map((signal) => signal.analyzer_id), ["buggy-mutator", "storage-observer"]);
  assert.equal(fetched.body.signals[0].applicable, false);
  assert.equal(fetched.body.signals[0].measures.find((measure) => measure.key === "analyzer_error")?.value, true);
  assert.equal(fetched.body.signals[1].measures.find((measure) => measure.key === "first_insert_len")?.value, originalEvents[0].ins_len);
  assert.doesNotMatch(fetched.body.signals.map((signal) => signal.explanation).join(" "), /likely|suspicious|AI-generated|score|verdict/i);
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

test("public ingest rejects unexpected manifest fields", async () => {
  const { api } = makeApi();
  const record = await fixtureRecord();
  record.manifest.user_note = "this would be plaintext if accepted";

  const response = await api.postRecord(record);
  assert.equal(response.status, 400);
  assert.equal(response.body.error, "invalid_manifest");
  assert.ok(response.body.details.some((detail) => detail.includes("user_note")));
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

test("Postgres read SQL uses explicit columns so created_at is the record timestamp", async () => {
  const record = await fixtureRecord();
  const queries = [];
  const db = {
    async query(sql, params) {
      queries.push({ sql, params });
      return {
        rows: [{
          record_hash: record.manifest.record_hash,
          short_signature: "abc123def4",
          format_version: record.manifest.format_version,
          session_id: record.manifest.session_id,
          producer_id: record.manifest.producer.id,
          producer_version: record.manifest.producer.version,
          producer_capabilities: record.manifest.producer.capabilities,
          capture_context: record.manifest.capture_context,
          event_count: record.manifest.event_count,
          duration_ms: record.manifest.duration_ms,
          created_client_t: record.manifest.created_client_t,
          ingested_server_t: "2026-05-28T10:00:00.000Z",
          parent_record_hash: null,
          attestations: record.manifest.attestations,
          events: record.events,
          created_at: "2026-05-28T10:00:01.000Z",
          insert_op_count: 3,
          delete_op_count: 1,
          replace_op_count: 0,
          typed_event_count: 2,
          paste_event_count: 1,
          cut_event_count: 1,
          drop_event_count: 0,
          ime_event_count: 0,
          autocomplete_event_count: 0,
          programmatic_event_count: 0,
          unknown_source_count: 0,
          inserted_codepoints_total: 9,
          deleted_codepoints_total: 1,
          largest_atomic_insert_codepoints: 6,
          inter_event_delay_min_ms: 60,
          inter_event_delay_p50_ms: 60,
          inter_event_delay_p90_ms: 120,
          inter_event_delay_p95_ms: 120,
          inter_event_delay_p99_ms: 120,
          inter_event_delay_max_ms: 120,
          active_time_ms: 240,
          idle_time_ms: 0,
          long_pause_count: 0,
          delay_histogram: [],
          signals: [],
        }],
      };
    },
  };

  const store = new PostgresRecordStore(db);
  const stored = await store.findByRecordHash(record.manifest.record_hash);

  assert.equal(stored.created_at, "2026-05-28T10:00:01.000Z");
  assert.ok(queries[0].sql.includes("r.created_at"));
  assert.match(queries[0].sql, /jsonb_agg\(to_jsonb\(analysis_results\) order by created_at, analyzer_id, analyzer_version, id\)/i);
  assert.doesNotMatch(queries[0].sql, /select\s+r\.\*,\s*s\.\*/i);
});
