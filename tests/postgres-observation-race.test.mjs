import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";

import pg from "pg";

import { createIngestApi } from "../apps/ingest-api/src/index.ts";
import { computeEventHashChain, computeRecordHash } from "../packages/format/src/index.ts";
import { PostgresRecordStore } from "../packages/storage/src/index.ts";
import { applyMigrations, loadSqlMigrations } from "../packages/storage/src/migrations.ts";

const execFileAsync = promisify(execFile);
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
  const harness = await startPostgresHarness(t);
  if (!harness) return;
  const { api, pool } = harness;

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
    assert.equal((await pool.query("select active_time_ms from record_stats where record_hash = $1", [hash])).rows[0].active_time_ms, 200000);
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

async function startPostgresHarness(t) {
  if (process.env.PMBAH_SKIP_POSTGRES_RACE_TEST === "1") {
    t.skip("PMBAH_SKIP_POSTGRES_RACE_TEST=1");
    return null;
  }

  const name = `pmbah-race-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const password = `pmbah-race-${randomUUID()}`;
  try {
    await execFileAsync("docker", [
      "run", "--rm", "-d",
      "--name", name,
      "-e", "POSTGRES_USER=pmbah",
      "-e", `POSTGRES_PASSWORD=${password}`,
      "-e", "POSTGRES_DB=pmbah",
      "-p", "127.0.0.1::5432",
      "postgres:16-alpine",
    ], { timeout: 120_000 });
  } catch (error) {
    if (process.env.CI) throw error;
    t.skip(`docker postgres unavailable: ${error.message}`);
    return null;
  }

  const { stdout } = await execFileAsync("docker", ["port", name, "5432/tcp"], { timeout: 30_000 });
  const port = Number(stdout.trim().match(/:(\d+)$/)?.[1]);
  if (!port) throw new Error(`could not determine postgres port from: ${stdout}`);

  const connectionString = `postgresql://pmbah:${encodeURIComponent(password)}@127.0.0.1:${port}/pmbah`;
  const pool = new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 1_000 });
  t.after(async () => {
    await pool.end().catch(() => undefined);
    await execFileAsync("docker", ["rm", "-f", name], { timeout: 30_000 }).catch(() => undefined);
  });

  await waitForPostgres(pool);
  await applyMigrations(pool, await loadSqlMigrations());
  const store = new PostgresRecordStore(pool);
  return { pool, store, api: createIngestApi({ store, baseUrl: "https://possiblymadebyahuman.test" }) };
}

async function waitForPostgres(pool) {
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await pool.query("select 1");
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError ?? new Error("postgres did not become ready");
}
