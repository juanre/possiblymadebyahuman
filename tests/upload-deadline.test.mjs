import assert from 'node:assert/strict';
import test from 'node:test';
import { withUploadDeadline, validateUploadResponse } from '../packages/producer-core/src/index.ts';
import { createFetchUploadAdapter } from '../apps/browser-extension/src/lib/adapters.ts';

const hash = `b3:${'a'.repeat(64)}`;
const accepted = { record_hash: hash, url: 'https://example.test/record', short_signature: 'record', created: true };

for (const stalledStage of ['fetch', 'body']) {
  test(`upload deadline covers stalled ${stalledStage}, aborts, and permits retry`, async () => {
    let release;
    let signal;
    const stall = new Promise(resolve => { release = resolve; });
    let first = true;
    const response = { ok: true, status: 201, json: async () => accepted };
    const adapter = createFetchUploadAdapter({ records_endpoint: 'https://example.test/api/records', timeout_ms: 15,
      fetch: async (_url, init) => {
        signal = init.signal;
        if (!first) return response;
        first = false;
        return stalledStage === 'fetch' ? stall : { ...response, json: () => stall };
      },
    });
    const payload = { manifest: {record_hash: hash}, events: [] };
    await assert.rejects(adapter.postRecord(payload), /timed out/);
    assert.equal(signal.aborted, true);
    assert.deepEqual(await adapter.postRecord(payload), accepted);
    release(stalledStage === 'fetch' ? response : { url: 'late' });
    await new Promise(resolve => setImmediate(resolve));
  });
}

test('upload deadline propagates failures and successful values without aborting', async () => {
  let signal;
  assert.equal(await withUploadDeadline(async s => { signal = s; return 42; }, 20), 42);
  assert.equal(signal.aborted, false);
  await assert.rejects(withUploadDeadline(async () => { throw new Error('network failure'); }), /network failure/);
});


test('upload success must identify the expected record and a usable public link', () => {
  assert.deepEqual(validateUploadResponse(accepted, hash), accepted);
  for (const response of [null, {}, {...accepted, record_hash: `b3:${'b'.repeat(64)}`},
    {...accepted, url: 'javascript:alert(1)'}, {...accepted, url: 'invalid'},
    {...accepted, short_signature: ''}, {...accepted, created: undefined}]) {
    assert.throws(() => validateUploadResponse(response, hash), /Invalid/);
  }
});
