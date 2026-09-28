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
function assertNothingAboutWhere(response) {
  // Read the record as a client does, over JSON.
  const body = JSON.parse(JSON.stringify(response));
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

test('the database keeps no place for where records were written', needsDatabase, async t => {
  const pool = new pg.Pool({ connectionString: process.env.PMBAH_TEST_DATABASE_URL });
  t.after(() => pool.end());
  await applyMigrations(pool, await loadSqlMigrations());
  const column = await pool.query("select 1 from information_schema.columns where table_name = 'records' and column_name = 'capture_context'");
  assert.equal(column.rowCount, 0);
  const api = createIngestApi({ store: new PostgresRecordStore(pool) });
  const saved = await api.postRecord(legacyRecord());
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assertNothingAboutWhere((await api.getRecord(saved.body.record_hash)).body);
  const upload = randomUUID();
  const begun = await api.handleRequest(new Request('http://local/api/record-uploads', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ upload_id: upload, manifest: legacyRecord().manifest }) }));
  assert.equal(begun.status, 200);
  const staged = (await pool.query('select manifest from record_uploads where upload_id = $1', [upload])).rows[0].manifest;
  assert.equal('capture_context' in staged, false);
});
