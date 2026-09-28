import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { createIngestApi } from '../apps/ingest-api/src/index.ts';
import { uploadJournal } from '../packages/browser-storage/src/upload.ts';
import { computeRecordHash, verifyRecord } from '../packages/format/src/index.ts';
import { InMemoryRecordStore, PostgresRecordStore } from '../packages/storage/src/index.ts';
import { applyMigrations, loadSqlMigrations } from '../packages/storage/src/migrations.ts';

// Records describe only the writing process. Producers released before this
// sent where the text was written; the service keeps none of it.
const LEGACY_CONTEXT = {
  surface: 'browser',
  label: 'Drafts - someone@example.com - Mail',
  browser: { url: 'https://mail.example/mail/u/0/', title: 'Drafts - someone@example.com - Mail', field_kind: 'contenteditable' },
  emacs: { buffer_name: 'resignation-letter.md', major_mode: 'markdown-mode' },
};
const producer = { id: 'test', version: '0.3.3', capabilities: ['timing'] };
function legacyRecord(count = 4) {
  const manifest = { format_version: '0.3', record_hash: '', session_id: randomUUID(), producer, capture_context: LEGACY_CONTEXT,
    event_count: count, duration_ms: count * 31, created_client_t: '2026-09-01T00:00:00.000Z', ingested_server_t: null, parent_record: null, attestations: [] };
  const events = Array.from({ length: count }, (_, seq) => ({ seq, t: seq * 31, op: 'insert', pos: seq, ins_len: 1, del_len: 0, source: 'typing' }));
  manifest.record_hash = computeRecordHash(events, manifest.session_id, manifest.format_version, undefined, manifest);
  return { manifest, events };
}
function assertNothingAboutWhere(body) {
  assert.equal('capture_context' in body.manifest, false);
  const text = JSON.stringify(body);
  for (const leak of ['someone@example.com', 'mail.example', 'resignation-letter', 'markdown-mode', 'contenteditable']) assert.equal(text.includes(leak), false, leak);
  assert.equal(verifyRecord({ manifest: body.manifest, events: body.events }).valid, true, 'the record still verifies');
}

test('a whole record sent with where it was written is stored and served without it', async () => {
  const api = createIngestApi({ store: new InMemoryRecordStore(), baseUrl: 'https://possiblymadebyahuman.test' });
  const created = await api.postRecord(legacyRecord());
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assertNothingAboutWhere((await api.getRecord(created.body.short_signature)).body);
});

test('a chunked upload sent with where it was written is stored and served without it', async () => {
  const api = createIngestApi({ store: new InMemoryRecordStore(), baseUrl: 'https://possiblymadebyahuman.test' });
  const fetch = (url, init) => api.handleRequest(new Request(url, init));
  const record = legacyRecord();
  const uploaded = await uploadJournal({ endpoint: 'http://local/api/record-uploads', fetch,
    payload: { upload_id: randomUUID(), manifest: record.manifest, observation: { state: 'unobserved' } },
    readEvents: async (start, n) => record.events.slice(start, start + n) });
  assertNothingAboutWhere((await api.getRecord(uploaded.short_signature)).body);
});

const needsDatabase = { skip: !process.env.PMBAH_TEST_DATABASE_URL && 'requires managed PostgreSQL test database' };

test('the migration wipes where records were written from stored records and staged uploads', needsDatabase, async t => {
  const pool = new pg.Pool({ connectionString: process.env.PMBAH_TEST_DATABASE_URL });
  t.after(() => pool.end());
  const migrations = await loadSqlMigrations();
  await applyMigrations(pool, migrations);
  const store = new PostgresRecordStore(pool);
  const api = createIngestApi({ store });
  const saved = await api.postRecord(legacyRecord());
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const hash = saved.body.record_hash;
  // Rows written by earlier releases still hold the details.
  await pool.query('update records set capture_context = $2::jsonb where record_hash = $1', [hash, JSON.stringify(LEGACY_CONTEXT)]);
  const upload = randomUUID(), staged = legacyRecord();
  const begun = await api.handleRequest(new Request('http://local/api/record-uploads', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ upload_id: upload, manifest: staged.manifest }) }));
  assert.equal(begun.status, 200);
  await pool.query(`update record_uploads set manifest = manifest || jsonb_build_object('capture_context', $2::jsonb) where upload_id = $1`, [upload, JSON.stringify(LEGACY_CONTEXT)]);

  const wipe = migrations.find(migration => /capture_context/.test(migration.sql) && /^008_/.test(migration.name));
  assert.ok(wipe, 'migration 008 removes capture context');
  await pool.query(wipe.sql);

  const record = (await pool.query('select capture_context from records where record_hash = $1', [hash])).rows[0];
  assert.equal(record.capture_context, null);
  const stagedRow = (await pool.query('select manifest from record_uploads where upload_id = $1', [upload])).rows[0];
  assert.equal('capture_context' in stagedRow.manifest, false);
  assertNothingAboutWhere((await api.getRecord(hash)).body);
});
