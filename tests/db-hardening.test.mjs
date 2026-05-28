import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createIngestApi } from "../apps/ingest-api/src/index.ts";
import { DEFAULT_RECORD_BODY_LIMIT_BYTES, createPoolConfig, createRuntimeServer, readiness } from "../apps/ingest-api/src/server.ts";
import { computeRecordStats } from "../apps/ingest-api/src/index.ts";
import { InMemoryRecordStore, PostgresRecordStore } from "../packages/storage/src/index.ts";
import { applyMigrations, MigrationChecksumMismatchError } from "../packages/storage/src/migrations.ts";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const clone = (value) => JSON.parse(JSON.stringify(value));

async function fixtureRecord() {
  const [golden] = await readJson("packages/conformance/vectors/golden-records.json");
  return clone(golden.record);
}

function recordRow(record, shortSignature = "abc123def4") {
  return {
    record_hash: record.manifest.record_hash,
    short_signature: shortSignature,
    format_version: record.manifest.format_version,
    session_id: record.manifest.session_id,
    producer_id: record.manifest.producer.id,
    producer_version: record.manifest.producer.version,
    producer_capabilities: record.manifest.producer.capabilities,
    capture_context: record.manifest.capture_context,
    event_count: record.manifest.event_count,
    duration_ms: record.manifest.duration_ms,
    observed_final_length: 8,
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
  };
}

test("PostgresRecordStore save uses one checked-out client for transaction and releases it", async () => {
  const record = await fixtureRecord();
  let selectCount = 0;
  const poolQueries = [];
  const clientQueries = [];
  let connectCount = 0;
  let releaseCount = 0;
  const client = {
    async query(sql, params) {
      clientQueries.push({ sql, params });
      return { rows: [] };
    },
    release() {
      releaseCount += 1;
    },
  };
  const db = {
    async connect() {
      connectCount += 1;
      return client;
    },
    async query(sql, params) {
      poolQueries.push({ sql, params });
      if (/where r\.record_hash = \$1/i.test(sql)) {
        selectCount += 1;
        return { rows: selectCount === 1 ? [] : [recordRow(record)] };
      }
      if (/select record_hash from records where short_signature/i.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  };

  const store = new PostgresRecordStore(db);
  const result = await store.saveRecord({
    record,
    short_signature: "abc123def4",
    stats: computeRecordStats(record),
    signals: [],
    created_at: "2026-05-28T10:00:01.000Z",
  });

  assert.equal(result.created, true);
  assert.equal(connectCount, 1);
  assert.equal(releaseCount, 1);
  assert.deepEqual(clientQueries.map((query) => query.sql.trim().split(/\s+/)[0].toLowerCase()), [
    "begin",
    "insert",
    "insert",
    "commit",
  ]);
  assert.equal(poolQueries.some((query) => query.sql.trim().toLowerCase() === "begin"), false);
  assert.equal(poolQueries.some((query) => query.sql.trim().toLowerCase() === "commit"), false);
});

test("PostgresRecordStore rolls back and releases checked-out client on transaction failure", async () => {
  const record = await fixtureRecord();
  const clientQueries = [];
  let releaseCount = 0;
  const client = {
    async query(sql) {
      clientQueries.push(sql);
      if (/insert into records/i.test(sql)) {
        const error = new Error("duplicate");
        error.code = "23505";
        throw error;
      }
      return { rows: [] };
    },
    release() {
      releaseCount += 1;
    },
  };
  const db = {
    async connect() { return client; },
    async query() { return { rows: [] }; },
  };

  const store = new PostgresRecordStore(db);
  await assert.rejects(
    store.saveRecord({ record, short_signature: "abc123def4", stats: computeRecordStats(record), signals: [] }),
    /unique constraint conflict/,
  );
  assert.equal(clientQueries.at(-1), "rollback");
  assert.equal(releaseCount, 1);
});

test("runtime POST body limit returns 413 before API handling", async () => {
  let handled = false;
  const server = createRuntimeServer({
    api: { handleRequest: async () => { handled = true; return new Response("{}", { status: 200 }); } },
    db: { async query() { return { rows: [] }; } },
    recordBodyLimitBytes: 5,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/records`, { method: "POST", body: "123456" });
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: "request_body_too_large", max_bytes: 5 });
    assert.equal(handled, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("readiness reports migration and database failures", async () => {
  const missingMigration = await readiness({
    async query(sql, params) {
      assert.match(sql, /with required_migrations/);
      assert.deepEqual(params, [["001"]]);
      return { rows: [{
        records_ready: "records",
        stats_ready: "record_stats",
        analysis_ready: "analysis_results",
        migrations_ready: "schema_migrations",
        required_migration_count: 1,
        applied_required_migration_count: 0,
      }] };
    },
  });
  assert.deepEqual(missingMigration, { ok: false, database: true, migrations: false });

  const missingSchemaMigrations = await readiness({
    async query() {
      const error = new Error("relation schema_migrations does not exist");
      error.code = "42P01";
      throw error;
    },
  });
  assert.deepEqual(missingSchemaMigrations, { ok: false, database: true, migrations: false });

  const dbFailure = await readiness({
    async query() { throw new Error("connection refused"); },
  });
  assert.deepEqual(dbFailure, { ok: false, database: false, migrations: false });
});

test("readiness checks all required migration versions in one query", async () => {
  const queries = [];
  const ready = await readiness({
    async query(sql, params) {
      queries.push({ sql, params });
      assert.match(sql, /join schema_migrations applied using \(version\)/);
      return { rows: [{
        records_ready: "records",
        stats_ready: "record_stats",
        analysis_ready: "analysis_results",
        migrations_ready: "schema_migrations",
        required_migration_count: 2,
        applied_required_migration_count: 2,
      }] };
    },
  }, ["001", "002"]);
  assert.deepEqual(ready, { ok: true, database: true, migrations: true });
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].params, [["001", "002"]]);
});

test("pool config and body-limit defaults are conservative release defaults", () => {
  assert.equal(DEFAULT_RECORD_BODY_LIMIT_BYTES, 10_000_000);
  assert.deepEqual(createPoolConfig({}), {
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  assert.deepEqual(createPoolConfig({
    DATABASE_POOL_MAX: "3",
    PG_POOL_IDLE_TIMEOUT_MS: "10000",
    PG_POOL_CONNECTION_TIMEOUT_MS: "2000",
    PG_STATEMENT_TIMEOUT_MS: "15000",
  }), {
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 2_000,
    statement_timeout: 15_000,
    query_timeout: 15_000,
  });
});

test("migration manager applies once, skips idempotent rerun, and orders migrations", async () => {
  const db = migrationDb();
  const migrations = [
    { version: "002", name: "002_second", sql: "create table if not exists second(id integer);" },
    { version: "001", name: "001_first", sql: "create table if not exists first(id integer);" },
  ];

  const first = await applyMigrations(db, migrations);
  assert.deepEqual(first.applied.map((migration) => migration.version), ["001", "002"]);
  assert.deepEqual(first.skipped, []);

  const second = await applyMigrations(db, migrations);
  assert.deepEqual(second.applied, []);
  assert.deepEqual(second.skipped.map((migration) => migration.version), ["001", "002"]);
});

test("migration manager fails on checksum drift", async () => {
  const db = migrationDb();
  await applyMigrations(db, [{ version: "001", name: "001_first", sql: "create table first(id integer);" }]);
  await assert.rejects(
    applyMigrations(db, [{ version: "001", name: "001_first", sql: "create table first(id bigint);" }]),
    MigrationChecksumMismatchError,
  );
});

test("runtime server still routes valid API requests under the body limit", async () => {
  const store = new InMemoryRecordStore();
  const api = createIngestApi({ store, baseUrl: "https://possiblymadebyahuman.test", now: () => new Date("2026-05-28T10:00:00.000Z") });
  const server = createRuntimeServer({
    api,
    db: { async query() { return { rows: [] }; } },
    recordBodyLimitBytes: 10_000,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const record = await fixtureRecord();
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/records`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(record),
    });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).record_hash, record.manifest.record_hash);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

function migrationDb() {
  const rows = [];
  const client = {
    async query(sql, params = []) {
      if (/insert into schema_migrations/i.test(sql)) {
        rows.push({ version: params[0], name: params[1], checksum: params[2] });
      }
      return { rows: [] };
    },
    release() {},
  };
  return {
    async connect() { return client; },
    async query(sql) {
      if (/select version, name, checksum from schema_migrations/i.test(sql)) return { rows: [...rows].sort((a, b) => a.version.localeCompare(b.version)) };
      return { rows: [] };
    },
  };
}
