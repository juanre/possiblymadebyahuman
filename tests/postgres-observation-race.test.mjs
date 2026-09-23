import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

import { createIngestApi } from "../apps/ingest-api/src/index.ts";
import { computeEventHashChain, computeRecordHash, verifyRecord } from "../packages/format/src/index.ts";
import { PostgresRecordStore } from "../packages/storage/src/index.ts";
import { applyMigrations, loadSqlMigrations } from "../packages/storage/src/migrations.ts";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const clone = (value) => JSON.parse(JSON.stringify(value));
const BAD_TIP = "b3:0000000000000000000000000000000000000000000000000000000000000000";

async function fixtureRecord() {
  const [golden] = await readJson("packages/conformance/vectors/golden-records.json");
  return clone(golden.record);
}

async function textBindingFixtureRecord() {
  const [, golden] = await readJson("packages/conformance/vectors/golden-records.json");
  return clone(golden.record);
}

test("Postgres observed-session finalization validates the exact public checkpoint set", async (t) => {
  const harness = await connectFixtureDatabase(t, "PMBAH_TEST_DATABASE_URL");
  const { api, pool } = harness;

  await t.test("0.3 seals a finish-only pause and parent while preserving older checkpoints and records", async () => {
    const parent = await freshRecord();
    const savedParent = await api.postRecord(parent);
    assert.equal(savedParent.status, 201);
    const parentBefore = await api.getRecord(savedParent.body.short_signature);
    const child = await freshRecord();
    child.manifest.format_version = "0.2";
    const checkpointChain = computeEventHashChain(child.events, child.manifest.session_id, "0.2");
    const checkpoint = await api.postObservedCheckpoint(child.manifest.session_id, {
      event_count: child.events.length, chain_tip: checkpointChain.at(-1),
    });
    assert.equal(checkpoint.status, 201);
    const originalEvents = clone(child.events);
    child.manifest.format_version = "0.3";
    child.manifest.duration_ms = 60 * 86400000;
    child.manifest.parent_record = parent.manifest.record_hash;
    child.manifest.record_hash = computeRecordHash(child.events, child.manifest.session_id, "0.3", undefined, child.manifest);
    const input = { ...child, observation: { observed_session_id: child.manifest.session_id, token: checkpoint.body.token } };
    const uploaded = await api.postRecord(input);
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    assert.equal((await api.postRecord(input)).status, 200, "interrupted upload retries the exact immutable record");
    const fetched = await api.getRecord(uploaded.body.short_signature);
    assert.equal(fetched.body.manifest.format_version, "0.3");
    assert.equal(fetched.body.manifest.duration_ms, 60 * 86400000);
    assert.equal(fetched.body.manifest.parent_record, parent.manifest.record_hash);
    // pg returns timestamptz values as Date objects; verify the public JSON
    // boundary that HTTP clients receive, not the pre-serialization API body.
    const wireRecord = await (await api.handleRequest(new Request(`https://possiblymadebyahuman.test/api/records/${uploaded.body.short_signature}`))).json();
    const verification = verifyRecord(wireRecord);
    assert.equal(verification.valid, true, verification.errors.join("; "));
    assert.deepEqual(fetched.body.events, originalEvents, "finishing adds no artificial edit");
    assert.equal(fetched.body.observation.state, "observed");
    assert.equal(fetched.body.observation.server_observed_span_ms, 0, "the finish duration is not server-observed time");
    assert.equal(fetched.body.observation.commitments[0].chain_tip, checkpointChain.at(-1));
    assert.deepEqual(await api.getRecord(savedParent.body.short_signature), parentBefore);
    const tampered = await api.postRecord({ ...input, manifest: { ...child.manifest, duration_ms: child.manifest.duration_ms + 1 } });
    assert.equal(tampered.status, 400);
    assert.match(tampered.body.details.join(" "), /record_hash mismatch/);
    const raw = await pool.query("select duration_ms, format_version, parent_record_hash from records where record_hash = $1", [child.manifest.record_hash]);
    assert.equal(raw.rows[0].duration_ms, String(60 * 86400000));
    assert.equal(raw.rows[0].parent_record_hash, parent.manifest.record_hash);
  });

  await t.test("invalid containers and integer overflows are client errors before persistence", async () => {
    const record = await fixtureRecord();
    assert.equal((await api.postRecord({ ...record, events: null })).status, 400);
    assert.equal((await api.postObservedCheckpoint(randomUUID(), { event_count: 2147483648, chain_tip: BAD_TIP })).status, 400);
    record.manifest.session_id = randomUUID();
    record.events = [0, 1].map((seq) => ({ seq, t: seq, op: "insert", pos: 0, del_len: 0, ins_len: 2147483647, source: "unknown" }));
    record.manifest.event_count = 2;
    record.manifest.duration_ms = 1;
    record.manifest.record_hash = computeRecordHash(record.events, record.manifest.session_id, record.manifest.format_version);
    const response = await api.postRecord(record);
    assert.equal(response.status, 400);
    assert.equal(response.body.error, "invalid_record");
    assert.equal((await api.getRecord(record.manifest.record_hash)).status, 404);
  });

  await t.test("legacy timing is corrected on read without rewriting stored records or caches", async () => {
    const record = await freshRecord();
    record.events = record.events.map((event) => ({ ...event, t: event.t + 60_000 }));
    record.manifest.duration_ms = 200_000;
    record.manifest.record_hash = computeRecordHash(record.events, record.manifest.session_id, record.manifest.format_version);
    const uploaded = await api.postRecord(record);
    assert.equal(uploaded.status, 201);
    const hash = record.manifest.record_hash;
    await pool.query("update record_stats set active_time_ms = 200000 where record_hash = $1", [hash]);
    await pool.query("update analysis_results set analyzer_version = '0.1.0', measures = $2 where record_hash = $1 and analyzer_id = 'timing-distribution'", [hash, JSON.stringify([{ key: "active_time_ms", value: 200000, unit: "ms" }, { key: "idle_time_ms", value: 0, unit: "ms" }])]);
    const fetched = await api.getRecord(uploaded.body.short_signature);
    const expected = record.events.at(-1).t - record.events[0].t;
    assert.equal(fetched.body.stats.active_time_ms, expected);
    const timing = fetched.body.signals.find((signal) => signal.analyzer_id === "timing-distribution");
    assert.equal(timing.analyzer_version, "0.1.1");
    assert.equal(timing.measures.find((measure) => measure.key === "active_time_ms").value, expected);
    assert.equal(fetched.body.manifest.record_hash, hash);
    assert.deepEqual(fetched.body.events, record.events);
    assert.equal((await pool.query("select active_time_ms from record_stats where record_hash = $1", [hash])).rows[0].active_time_ms, "200000");
  });

  await t.test("text_binding persists and reads back through real Postgres", async () => {
    const record = await textBindingFixtureRecord();
    const ingest = await api.postRecord(record);
    assert.equal(ingest.status, 201);

    const fetched = await api.getRecord(ingest.body.short_signature);
    assert.equal(fetched.status, 200);
    assert.deepEqual(fetched.body.manifest.text_binding, record.manifest.text_binding);

    const row = (await pool.query("select text_binding from records where record_hash = $1", [record.manifest.record_hash])).rows[0];
    assert.deepEqual(row.text_binding, record.manifest.text_binding);
    assert.equal(JSON.stringify(fetched.body).includes("Hello, World!"), false);
  });

  await t.test("concurrent bad checkpoint during finalization does not publish", async () => {
    const trials = 50;
    for (let trial = 0; trial < trials; trial += 1) {
      const record = await freshRecord();
      const chain = computeEventHashChain(record.events, record.manifest.session_id, record.manifest.format_version);
      const first = await api.postObservedCheckpoint(record.manifest.session_id, { event_count: 1, chain_tip: chain[0] });
      assert.equal(first.status, 201);

      let injection;
      const racingApi = createIngestApi({
        store: new InterleavingStore(new PostgresRecordStore(pool), async () => {
          if (injection) return;
          injection = api.postObservedCheckpoint(record.manifest.session_id, {
            event_count: 2,
            chain_tip: BAD_TIP,
            token: first.body.token,
          });
          await new Promise((resolve) => setImmediate(resolve));
        }),
        baseUrl: "https://possiblymadebyahuman.test",
      });
      const finalized = await racingApi.postRecord({
        ...record,
        observation: { observed_session_id: record.manifest.session_id, token: first.body.token },
      });
      const injected = injection ? await injection : null;

      assert.ok([201, 409].includes(finalized.status), `trial ${trial} finalization status`);
      if (finalized.status === 409) assert.equal(finalized.body.error, "observation_mismatch");
      if (finalized.status === 201) assert.equal(injected?.body.error, "observed_session_finalized");
      const fetched = await api.getRecord(record.manifest.record_hash);
      if (fetched.status === 200) {
        assert.equal(fetched.body.observation.commitments.some((commitment) => commitment.chain_tip === BAD_TIP), false, `trial ${trial} published bad tip`);
      } else {
        assert.equal(fetched.status, 404, `trial ${trial} unpublished record status`);
      }
    }
  });

  await t.test("concurrent matching checkpoint during finalization is published consistently", async () => {
    const record = await freshRecord();
    const chain = computeEventHashChain(record.events, record.manifest.session_id, record.manifest.format_version);
    const first = await api.postObservedCheckpoint(record.manifest.session_id, { event_count: 1, chain_tip: chain[0] });
    assert.equal(first.status, 201);

    const racingApi = createIngestApi({
      store: new InterleavingStore(new PostgresRecordStore(pool), async () => {
        await api.postObservedCheckpoint(record.manifest.session_id, {
          event_count: record.events.length,
          chain_tip: chain.at(-1),
          token: first.body.token,
        });
      }),
      baseUrl: "https://possiblymadebyahuman.test",
    });
    const finalized = await racingApi.postRecord({
      ...record,
      observation: { observed_session_id: record.manifest.session_id, token: first.body.token },
    });

    assert.equal(finalized.status, 201);
    const fetched = await api.getRecord(finalized.body.short_signature);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.observation.state, "observed");
    assert.equal(fetched.body.observation.commitments.at(-1).event_count, record.events.length);
    assert.equal(fetched.body.observation.commitments.at(-1).chain_tip, chain.at(-1));
  });

  await t.test("checkpoint after finalization is rejected as finalized", async () => {
    const record = await freshRecord();
    const chain = computeEventHashChain(record.events, record.manifest.session_id, record.manifest.format_version);
    const first = await api.postObservedCheckpoint(record.manifest.session_id, { event_count: 1, chain_tip: chain[0] });
    assert.equal(first.status, 201);
    const finalized = await api.postRecord({
      ...record,
      observation: { observed_session_id: record.manifest.session_id, token: first.body.token },
    });
    assert.equal(finalized.status, 201);

    const late = await api.postObservedCheckpoint(record.manifest.session_id, {
      event_count: 2,
      chain_tip: chain[1],
      token: first.body.token,
    });
    assert.equal(late.status, 409);
    assert.equal(late.body.error, "observed_session_finalized");
  });

  await t.test("many valid observed finalizations do not deadlock", async () => {
    const count = 20;
    const records = await Promise.all(Array.from({ length: count }, () => freshRecord()));
    const prepared = await Promise.all(records.map(async (record) => {
      const chain = computeEventHashChain(record.events, record.manifest.session_id, record.manifest.format_version);
      const checkpoint = await api.postObservedCheckpoint(record.manifest.session_id, {
        event_count: record.events.length,
        chain_tip: chain.at(-1),
      });
      assert.equal(checkpoint.status, 201);
      return { record, token: checkpoint.body.token };
    }));

    const finalized = await Promise.all(prepared.map(({ record, token }) => api.postRecord({
      ...record,
      observation: { observed_session_id: record.manifest.session_id, token },
    })));
    assert.equal(finalized.every((response) => response.status === 201), true);
  });
});

test("Postgres forward migration preserves old records and observations, then stores month-long sessions", async (t) => {
  const harness = await connectFixtureDatabase(t, "PMBAH_TEST_UPGRADE_DATABASE_URL", ["001", "002"]);
  const { pool, store } = harness;
  const firstAt = new Date("2026-01-01T00:00:00.000Z");
  const pauseMs = 60 * 24 * 60 * 60 * 1000;
  let wallClock = firstAt;
  const api = createIngestApi({ store, now: () => wallClock });
  const old = await fixtureRecord();
  const uploaded = await api.postRecord(old);
  assert.equal(uploaded.status, 201);
  const oldBefore = await api.getRecord(uploaded.body.short_signature);
  const rawBefore = (await pool.query("select record_hash, events, duration_ms from records where record_hash = $1", [old.manifest.record_hash])).rows[0];

  const record = await freshRecord();
  record.events = [
    { seq: 0, t: 0, op: "insert", pos: 0, del_len: 0, ins_len: 1, source: "typing" },
    { seq: 1, t: pauseMs, op: "insert", pos: 1, del_len: 0, ins_len: 1, source: "typing" },
  ];
  record.manifest.event_count = 2;
  record.manifest.duration_ms = pauseMs + 500;
  record.manifest.record_hash = computeRecordHash(record.events, record.manifest.session_id, record.manifest.format_version);
  const chain = computeEventHashChain(record.events, record.manifest.session_id, record.manifest.format_version);
  const first = await api.postObservedCheckpoint(record.manifest.session_id, { event_count: 1, chain_tip: chain[0] });
  assert.equal(first.status, 201);

  const migrated = await applyMigrations(pool, await loadSqlMigrations());
  assert.deepEqual(migrated.applied.map(({ version }) => version), ["003"]);
  assert.deepEqual(migrated.skipped.map(({ version }) => version), ["001", "002"]);
  assert.deepEqual(await api.getRecord(uploaded.body.short_signature), oldBefore);
  const rawAfter = (await pool.query("select record_hash, events, duration_ms from records where record_hash = $1", [old.manifest.record_hash])).rows[0];
  assert.equal(rawAfter.record_hash, rawBefore.record_hash);
  assert.deepEqual(rawAfter.events, rawBefore.events);
  assert.equal(rawAfter.duration_ms, String(rawBefore.duration_ms));
  const schema = (await pool.query("select table_name, column_name, data_type from information_schema.columns where table_schema = 'public' and ((table_name = 'records' and column_name in ('duration_ms', 'event_count', 'created_client_t')) or (table_name = 'record_stats' and (column_name like 'inter_event_delay_%_ms' or column_name in ('active_time_ms', 'idle_time_ms', 'observed_final_length'))))")).rows;
  for (const column of schema) {
    assert.equal(column.data_type, column.column_name.endsWith("_ms") ? "bigint" : column.column_name === "created_client_t" ? "timestamp with time zone" : "integer");
  }

  wallClock = new Date(firstAt.getTime() + pauseMs);
  const resumed = await api.postObservedCheckpoint(record.manifest.session_id, { event_count: 2, chain_tip: chain[1], token: first.body.token });
  assert.equal(resumed.status, 201);
  const signed = await api.postRecord({ ...record, observation: { observed_session_id: record.manifest.session_id, token: first.body.token } });
  assert.equal(signed.status, 201, JSON.stringify(signed.body));
  const response = await api.handleRequest(new Request(`https://possiblymadebyahuman.test/api/records/${signed.body.short_signature}`));
  assert.equal(response.status, 200);
  const fetched = { body: await response.json() };
  assert.equal(fetched.body.manifest.duration_ms, pauseMs + 500);
  assert.equal(fetched.body.manifest.record_hash, record.manifest.record_hash);
  assert.deepEqual(fetched.body.events, record.events);
  assert.equal(fetched.body.stats.idle_time_ms, pauseMs);
  assert.equal(fetched.body.stats.active_time_ms, 0);
  for (const percentile of ["min", "p50", "p90", "p95", "p99", "max"]) {
    assert.equal(fetched.body.stats[`inter_event_delay_${percentile}_ms`], pauseMs);
  }
  assert.equal(fetched.body.observation.first_observed_at, firstAt.toISOString());
  assert.equal(fetched.body.observation.last_observed_at, wallClock.toISOString());
  assert.equal(fetched.body.observation.server_observed_span_ms, pauseMs);
  assert.equal(fetched.body.observation.checkpoint_count, 2);
  assert.equal(JSON.stringify(fetched.body).includes(first.body.token), false);

  // A value allowed by PostgreSQL bigint but not exact in JS must never escape
  // rounded into public JSON. This row is isolated in this disposable database.
  await pool.query("update records set duration_ms = $2 where record_hash = $1", [record.manifest.record_hash, "9007199254740993"]);
  await assert.rejects(store.findByRecordHash(record.manifest.record_hash), /safe integer range/);
});

class InterleavingStore {
  #base;
  #beforeSave;

  constructor(base, beforeSave) {
    this.#base = base;
    this.#beforeSave = beforeSave;
  }

  async saveRecord(input) {
    await this.#beforeSave(input);
    return this.#base.saveRecord(input);
  }

  findByRecordHash(...args) { return this.#base.findByRecordHash(...args); }
  findByShortSignature(...args) { return this.#base.findByShortSignature(...args); }
  findByShortSignatureOrHash(...args) { return this.#base.findByShortSignatureOrHash(...args); }
  shortSignatureExists(...args) { return this.#base.shortSignatureExists(...args); }
  appendObservedCheckpoint(...args) { return this.#base.appendObservedCheckpoint(...args); }
  getObservedSessionForBinding(...args) { return this.#base.getObservedSessionForBinding(...args); }
}

async function freshRecord() {
  const record = await fixtureRecord();
  record.manifest.session_id = randomUUID();
  const chain = computeEventHashChain(record.events, record.manifest.session_id, record.manifest.format_version);
  record.manifest.record_hash = chain.at(-1);
  return record;
}

async function connectFixtureDatabase(t, variable, migrationVersions) {
  const connectionString = process.env[variable];
  assert.ok(connectionString, `${variable} is required; run npm test so pgdbm supplies isolated databases`);
  const pool = new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 1_000 });
  // The pgdbm fixture owns creation/readiness/drop. This process owns only its pool.
  t.after(() => pool.end());
  const migrations = await loadSqlMigrations();
  await applyMigrations(pool, migrationVersions ? migrations.filter((migration) => migrationVersions.includes(migration.version)) : migrations);
  const store = new PostgresRecordStore(pool);
  return { pool, store, api: createIngestApi({ store, baseUrl: "https://possiblymadebyahuman.test" }) };
}
