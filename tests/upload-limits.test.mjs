import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { promisify } from 'node:util';
import pg from 'pg';
import { createIngestApi, DEFAULT_MAX_UPLOAD_BYTES, DEFAULT_MAX_UPLOAD_EVENTS } from '../apps/ingest-api/src/index.ts';
import { runtimeLimitsFromEnv } from '../apps/ingest-api/src/server.ts';
import { uploadJournal } from '../packages/browser-storage/src/upload.ts';
import { computeRecordHash } from '../packages/format/src/index.ts';
import { InMemoryRecordStore, PostgresRecordStore } from '../packages/storage/src/index.ts';
import { deleteAbandonedUploads } from '../packages/storage/src/maintenance.ts';
import { applyMigrations, loadSqlMigrations } from '../packages/storage/src/migrations.ts';

const fixture = JSON.parse(await readFile('packages/conformance/vectors/golden-records.json', 'utf8'))[0].record;
function record(count) {
  const manifest = { ...structuredClone(fixture.manifest), session_id: randomUUID(), format_version: '0.3', event_count: count, duration_ms: count * 31 };
  const events = Array.from({ length: count }, (_, seq) => ({ seq, t: seq * 31, op: 'insert', pos: seq, ins_len: 1, del_len: 0, source: 'typing' }));
  manifest.record_hash = computeRecordHash(events, manifest.session_id, manifest.format_version, undefined, manifest);
  return { manifest, events };
}
function client(store, options = {}) {
  const api = createIngestApi({ store, ...options });
  return async (path, body) => {
    const response = await api.handleRequest(new Request(`http://local/api/${path}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() };
  };
}
async function database(t) {
  const pool = new pg.Pool({ connectionString: process.env.PMBAH_TEST_DATABASE_URL });
  t.after(() => pool.end());
  await applyMigrations(pool, await loadSqlMigrations());
  return pool;
}
const needsDatabase = { skip: !process.env.PMBAH_TEST_DATABASE_URL && 'requires managed PostgreSQL test database' };

test('default upload caps leave room for the documented multi-year sessions', () => {
  assert.ok(DEFAULT_MAX_UPLOAD_EVENTS >= 2 * 4_000_000);
  const largestEvent = JSON.stringify({ seq: 2147483646, t: Number.MAX_SAFE_INTEGER, op: 'replace', pos: 2147483646, del_len: 2147483646, ins_len: 2147483646, source: 'programmatic' });
  assert.ok(DEFAULT_MAX_UPLOAD_BYTES >= DEFAULT_MAX_UPLOAD_EVENTS * Buffer.byteLength(largestEvent), 'the byte cap never binds before the event cap for schema-valid events');
  assert.deepEqual(runtimeLimitsFromEnv({}).upload, { maxEvents: DEFAULT_MAX_UPLOAD_EVENTS, maxBytes: DEFAULT_MAX_UPLOAD_BYTES });
  assert.deepEqual(runtimeLimitsFromEnv({ MAX_UPLOAD_EVENTS: '5', MAX_UPLOAD_BYTES: '600' }).upload, { maxEvents: 5, maxBytes: 600 });
});

async function exerciseCaps(store) {
  const r = record(10), id = randomUUID();
  const maxUploadBytes = Buffer.byteLength(JSON.stringify(r.events.slice(0, 8))) + 10;
  const call = client(store, { maxUploadEvents: 10, maxUploadBytes });
  const tooMany = record(11);
  const rejected = await call('record-uploads', { upload_id: randomUUID(), manifest: tooMany.manifest });
  assert.equal(rejected.status, 413);
  assert.equal(rejected.body.error, 'upload_too_large');
  assert.match(rejected.body.details[0], /10 events/);

  assert.equal((await call('record-uploads', { upload_id: id, manifest: r.manifest })).status, 200);
  assert.equal((await call(`record-uploads/${id}/chunks`, { start_seq: 0, events: r.events.slice(0, 8) })).status, 200);
  const resumed = client(store, { maxUploadEvents: 10, maxUploadBytes });
  const over = await resumed(`record-uploads/${id}/chunks`, { start_seq: 8, events: r.events.slice(8) });
  assert.equal(over.status, 413, 'the byte total survives resumption');
  assert.equal(over.body.error, 'upload_too_large');
  assert.match(over.body.details[0], new RegExp(`${maxUploadBytes} bytes`));
  assert.equal((await resumed(`record-uploads/${id}`)).body.next_seq, 8, 'a rejected chunk is not stored');
  const generous = client(store);
  assert.equal((await generous(`record-uploads/${id}/chunks`, { start_seq: 8, events: r.events.slice(8) })).status, 200);
  assert.equal((await generous(`record-uploads/${id}/finalize`, {})).status, 201);
}

test('uploads are capped in events and received bytes', async () => exerciseCaps(new InMemoryRecordStore()));
test('PostgreSQL uploads are capped in events and received bytes', needsDatabase, async t => exerciseCaps(new PostgresRecordStore(await database(t))));

test('abandoned unfinalized uploads are deleted and producers restart them cleanly', needsDatabase, async t => {
  const pool = await database(t), store = new PostgresRecordStore(pool), call = client(store);
  const abandoned = record(9000), recent = record(3), published = record(3);
  const [abandonedId, recentId, publishedId] = [randomUUID(), randomUUID(), randomUUID()];
  for (const [id, r] of [[abandonedId, abandoned], [recentId, recent], [publishedId, published]]) {
    await call('record-uploads', { upload_id: id, manifest: r.manifest });
    await call(`record-uploads/${id}/chunks`, { start_seq: 0, events: r.events.slice(0, 4096) });
  }
  assert.equal((await call(`record-uploads/${publishedId}/finalize`, {})).status, 201);
  const age = (id, days) => pool.query(`update record_uploads set updated_at=now()-make_interval(days=>$2) where upload_id=$1`, [id, days]);
  await age(abandonedId, 31); await age(recentId, 29); await age(publishedId, 400);

  const before = (await pool.query('select updated_at from record_uploads where upload_id=$1', [recentId])).rows[0].updated_at;
  assert.equal((await call('record-uploads', { upload_id: recentId, manifest: recent.manifest })).status, 200);
  const touched = (await pool.query('select updated_at from record_uploads where upload_id=$1', [recentId])).rows[0].updated_at;
  assert.ok(touched > before, 'resuming an upload marks it active');
  await age(recentId, 29);
  const idle = (await pool.query('select updated_at from record_uploads where upload_id=$1', [abandonedId])).rows[0].updated_at;
  assert.equal((await call(`record-uploads/${abandonedId}/chunks`, { start_seq: 4096, events: abandoned.events.slice(4096, 8192) })).status, 200);
  assert.ok((await pool.query('select updated_at from record_uploads where upload_id=$1', [abandonedId])).rows[0].updated_at > idle, 'appending marks an upload active');
  await age(abandonedId, 31);

  const deleted = await deleteAbandonedUploads(pool, { olderThanDays: 30 });
  assert.ok(deleted.uploads >= 1);
  const remaining = (await pool.query(`select upload_id::text from record_uploads where upload_id = any($1::uuid[])`, [[abandonedId, recentId, publishedId]])).rows.map(row => row.upload_id).sort();
  assert.deepEqual(remaining, [recentId, publishedId].sort());
  const leftovers = (await pool.query(`select (select count(*) from record_event_chunks where upload_id=$1)::integer as chunks,
    (select count(*) from upload_delay_counts where upload_id=$1)::integer as delays`, [abandonedId])).rows[0];
  assert.deepEqual(leftovers, { chunks: 0, delays: 0 });
  assert.equal((await call(`records/${(await call(`record-uploads/${publishedId}/finalize`, {})).body.short_signature}/events?offset=0&limit=3`)).body.events.length, 3, 'published pages are kept');

  const api = createIngestApi({ store });
  const fetchApi = async (url, init) => api.handleRequest(new Request(new URL(url, 'http://local'), init));
  const uploaded = await uploadJournal({ endpoint: '/api/record-uploads', fetch: fetchApi, payload: { upload_id: abandonedId, manifest: abandoned.manifest },
    readEvents: async (start, count) => abandoned.events.slice(start, start + count) });
  assert.equal(uploaded.created, true);
  assert.equal(uploaded.record_hash, abandoned.manifest.record_hash);
});

test('the abandoned-upload cleanup command requires a database and reports what it deleted', needsDatabase, async t => {
  const pool = await database(t), call = client(new PostgresRecordStore(pool)), r = record(2), id = randomUUID();
  await call('record-uploads', { upload_id: id, manifest: r.manifest });
  await pool.query(`update record_uploads set updated_at=now()-interval '45 days' where upload_id=$1`, [id]);
  const run = promisify(execFile);
  await assert.rejects(run(process.execPath, ['apps/ingest-api/scripts/delete-abandoned-uploads.mjs'], { env: { ...process.env, DATABASE_URL: '' } }), /DATABASE_URL is required/);
  const { stdout } = await run(process.execPath, ['apps/ingest-api/scripts/delete-abandoned-uploads.mjs', '--older-than-days', '40'],
    { env: { ...process.env, DATABASE_URL: process.env.PMBAH_TEST_DATABASE_URL } });
  assert.match(stdout, /deleted \d+ abandoned unfinalized uploads untouched for 40 days/);
  assert.equal((await pool.query('select count(*)::integer as count from record_uploads where upload_id=$1', [id])).rows[0].count, 0);
});
