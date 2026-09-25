import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("malformed requests below the HTTP byte limit stay within a 128 MiB heap", () => {
  const child = spawnSync(process.execPath, ["--max-old-space-size=128", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    import { createIngestApi } from './apps/ingest-api/src/index.ts';
    import { createRuntimeServer, DEFAULT_RECORD_BODY_LIMIT_BYTES } from './apps/ingest-api/src/server.ts';
    import { InMemoryRecordStore } from './packages/storage/src/index.ts';
    const store = new InMemoryRecordStore();
    const api = createIngestApi({ store });
    const server = createRuntimeServer({ api, store, db: { query: async () => ({ rows: [] }) } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    const manifest = JSON.stringify(JSON.parse(readFileSync('packages/conformance/vectors/golden-records.json'))[0].record.manifest);
    const wide = '0,'.repeat(2_000_000) + '0';
    const cases = [
      '[' + wide + ']',
      '{"manifest":' + manifest + ',"events":[' + wide + ']}',
      '{"manifest":' + manifest + ',"events":[' + '{} ,'.repeat(100_000) + '{}]}',
      '{"manifest":{"producer":{"capabilities":[' + wide + ']}},"events":[]}',
      '{"manifest":' + manifest + ',"events":[' + '{"text":"x"},'.repeat(100_000) + '{}]}',
      '{"manifest":' + manifest + ',"events":[],' + Array.from({length:20_000}, (_, i) => '"extra' + i + '":0').join(',') + '}',
    ];
    try {
      for (const body of cases) {
        assert.ok(Buffer.byteLength(body) < DEFAULT_RECORD_BODY_LIMIT_BYTES);
        const response = await fetch(base + '/api/records', {method:'POST', body});
        assert.equal(response.status, 400);
        const result = await response.json();
        assert.ok(result.details.length <= 26);
        assert.ok(JSON.stringify(result).length < 10_000);
        assert.equal((await fetch(base + '/health')).status, 200);
      }
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    console.log('bounded-validation-ok');
  `], { encoding: "utf8", timeout: 30_000, maxBuffer: 100_000 });
  assert.equal(child.status, 0, child.stderr || String(child.error));
  assert.match(child.stdout, /bounded-validation-ok/);
});
