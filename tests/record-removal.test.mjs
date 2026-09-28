import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import pg from 'pg';
import { createIngestApi } from '../apps/ingest-api/src/index.ts';
import { createRuntimeServer } from '../apps/ingest-api/src/server.ts';
import { computeEventHashChain, computeRecordHash } from '../packages/format/src/index.ts';
import { PostgresRecordStore } from '../packages/storage/src/index.ts';
import { removeRecord } from '../packages/storage/src/maintenance.ts';
import { applyMigrations, loadSqlMigrations } from '../packages/storage/src/migrations.ts';

const needsDatabase = { skip: !process.env.PMBAH_TEST_DATABASE_URL && 'requires managed PostgreSQL test database' };
const producer = { id: 'test', version: '0.1.0', capabilities: ['timing'] };
function record(count, parent_record = null) {
  const manifest = { format_version: '0.3', record_hash: '', session_id: randomUUID(), producer, event_count: count,
    duration_ms: count * 31, created_client_t: '2026-09-01T00:00:00.000Z', ingested_server_t: null, parent_record, attestations: [] };
  const events = Array.from({ length: count }, (_, seq) => ({ seq, t: seq * 31, op: 'insert', pos: seq, ins_len: 1, del_len: 0, source: 'typing' }));
  manifest.record_hash = computeRecordHash(events, manifest.session_id, manifest.format_version, undefined, manifest);
  return { manifest, events };
}
async function setup(t) {
  const pool = new pg.Pool({ connectionString: process.env.PMBAH_TEST_DATABASE_URL });
  t.after(() => pool.end());
  await applyMigrations(pool, await loadSqlMigrations());
  const store = new PostgresRecordStore(pool), api = createIngestApi({ store });
  const call = async (path, body) => {
    const response = await api.handleRequest(new Request(`http://local/api/${path}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() };
  };
  const publish = async (r, observation) => {
    const id = randomUUID();
    assert.equal((await call('record-uploads', { upload_id: id, manifest: r.manifest, ...(observation ? { observation } : {}) })).status, 200);
    assert.equal((await call(`record-uploads/${id}/chunks`, { start_seq: 0, events: r.events })).status, 200);
    const saved = await call(`record-uploads/${id}/finalize`, {});
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    return { ...saved.body, upload_id: id };
  };
  return { pool, store, api, call, publish };
}
const count = async (pool, sql, params) => (await pool.query(`select count(*)::integer as n from ${sql}`, params)).rows[0].n;

test('removing a record deletes its data and observation in one transaction and keeps continuations valid', needsDatabase, async t => {
  const { pool, store, api, call, publish } = await setup(t);
  const parent = record(5), tips = computeEventHashChain(parent.events, parent.manifest.session_id, '0.3');
  const checkpoint = await api.postObservedCheckpoint(parent.manifest.session_id, { event_count: 5, chain_tip: tips[4] });
  const published = await publish(parent, { observed_session_id: parent.manifest.session_id, token: checkpoint.body.token });
  const shadow = randomUUID();
  await call('record-uploads', { upload_id: shadow, manifest: parent.manifest });
  const child = record(3, parent.manifest.record_hash), childSaved = await publish(child);
  const hash = parent.manifest.record_hash;

  const preview = await removeRecord(pool, published.short_signature, { confirm: false });
  assert.deepEqual(preview, { record_hash: hash, short_signature: published.short_signature, removed: false,
    observed_sessions: 1, uploads: 2, chunks: 1, continuations: 1 });
  assert.equal(await store.recordExists(hash), true, 'a preview changes nothing');

  const removed = await removeRecord(pool, published.short_signature, { confirm: true });
  assert.deepEqual(removed, { ...preview, removed: true });
  assert.equal(await store.recordExists(hash), false);
  assert.equal(await store.recordExists(published.short_signature), false);
  for (const [table, column] of [['record_stats', 'record_hash'], ['analysis_results', 'record_hash'], ['observed_sessions', 'finalized_record_hash']]) {
    assert.equal(await count(pool, `${table} where ${column}=$1`, [hash]), 0, table);
  }
  assert.equal(await count(pool, 'observed_checkpoints where observed_session_id=$1', [parent.manifest.session_id]), 0);
  assert.equal(await count(pool, 'record_uploads where upload_id = any($1::uuid[])', [[published.upload_id, shadow]]), 0);
  assert.equal(await count(pool, 'record_event_chunks where upload_id=$1', [published.upload_id]), 0);
  assert.equal(await count(pool, 'removed_records where record_hash=$1', [hash]), 1);
  assert.equal((await call(`records/${published.short_signature}`)).status, 404);
  assert.equal((await call(`records/${hash}/summary`)).status, 404);

  const continuation = await call(`records/${childSaved.short_signature}/summary`);
  assert.equal(continuation.status, 200);
  assert.equal(continuation.body.manifest.parent_record, hash, 'the signed parent reference is unchanged');
  assert.equal((await call(`records/${childSaved.short_signature}/events?offset=0&limit=3`)).body.events.length, 3);
  await assert.rejects(removeRecord(pool, published.short_signature, { confirm: true }), /no stored record/);
  assert.equal((await removeRecord(pool, childSaved.record_hash, { confirm: true })).continuations, 0, 'a continuation is removable by full hash');
});

test('a removed hash cannot be published again and its address stays not-found', needsDatabase, async t => {
  const { pool, store, call, publish } = await setup(t);
  const r = record(4), published = await publish(r);
  await removeRecord(pool, r.manifest.record_hash, { confirm: true });

  const begun = await call('record-uploads', { upload_id: randomUUID(), manifest: r.manifest });
  assert.equal(begun.status, 410);
  assert.equal(begun.body.error, 'record_removed');
  const direct = await call('records', r);
  assert.equal(direct.status, 410);
  assert.equal(direct.body.error, 'record_removed');
  const orphan = await call('record-uploads', { upload_id: randomUUID(), manifest: record(2, r.manifest.record_hash).manifest });
  assert.equal(orphan.status, 400, 'a new continuation of a removed record is refused');

  const staged = record(3), id = randomUUID();
  await call('record-uploads', { upload_id: id, manifest: staged.manifest });
  await call(`record-uploads/${id}/chunks`, { start_seq: 0, events: staged.events });
  await pool.query('insert into removed_records(record_hash) values ($1)', [staged.manifest.record_hash]);
  const finalized = await call(`record-uploads/${id}/finalize`, {});
  assert.equal(finalized.status, 410, 'staging that began before removal cannot publish');
  assert.equal(finalized.body.error, 'record_removed');
  assert.equal(await store.recordExists(staged.manifest.record_hash), false);

  const webDistDir = await mkdtemp(join(tmpdir(), 'pmbah-removed-'));
  await writeFile(join(webDistDir, 'index.html'), '<!doctype html><div id="root"></div>');
  const server = createRuntimeServer({ api: createIngestApi({ store }), store, db: pool, webDistDir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const path of [`/${published.short_signature}`, `/${r.manifest.record_hash}`]) assert.equal((await fetch(`${base}${path}`)).status, 404, path);
});

test('the removal command previews without --confirm and removes with it', needsDatabase, async t => {
  const { pool, store, publish } = await setup(t);
  const r = record(2), published = await publish(r), run = promisify(execFile);
  const env = { ...process.env, DATABASE_URL: process.env.PMBAH_TEST_DATABASE_URL };
  await assert.rejects(run(process.execPath, ['apps/ingest-api/scripts/remove-record.mjs', published.short_signature], { env: { ...process.env, DATABASE_URL: '' } }), /DATABASE_URL is required/);
  const preview = await run(process.execPath, ['apps/ingest-api/scripts/remove-record.mjs', published.short_signature], { env });
  assert.match(preview.stdout, /would remove/);
  assert.match(preview.stdout, /--confirm/);
  assert.equal(await store.recordExists(published.short_signature), true);
  const done = await run(process.execPath, ['apps/ingest-api/scripts/remove-record.mjs', published.short_signature, '--confirm'], { env });
  assert.match(done.stdout, new RegExp(`removed ${r.manifest.record_hash}`));
  assert.equal(await store.recordExists(published.short_signature), false);
});
