import { readFile } from 'node:fs/promises';

const baseUrl = process.env.SMOKE_BASE_URL ?? `http://localhost:${process.env.PMBAH_PORT ?? 8000}`;
const [golden] = JSON.parse(await readFile(new URL('../packages/conformance/vectors/golden-records.json', import.meta.url), 'utf8'));
const record = golden.record;
const plaintextFixtures = [' there', 'Hi ther!'];
const shortPlaintextJsonFixture = '"Hi"';

await checkJson('/health', (body) => {
  assertEqual(body.ok, true, '/health ok');
});

await checkJson('/ready', (body) => {
  assertEqual(body.ok, true, '/ready ok');
  assertEqual(body.database, true, '/ready database');
  assertEqual(body.migrations, true, '/ready migrations');
});

await checkHtml('/', ['possiblymadebyahuman', 'content-blind']);
await checkHtml('/docs/', ['Docs']);
await checkHtml('/blog/', ['Blog']);

const post = await fetch(`${baseUrl}/api/records`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(record),
});
if (![200, 201].includes(post.status)) throw new Error(`POST failed: ${post.status} ${await post.text()}`);
const created = await post.json();
assertEqual(created.record_hash, record.manifest.record_hash, 'created record_hash');
if (!created.short_signature) throw new Error('missing short_signature');
if (!created.url?.endsWith(`/${created.short_signature}`)) throw new Error('created url does not end with short signature');
assertNoPlaintext('POST response', JSON.stringify(created), true);

const fetched = await checkJson(`/api/records/${created.short_signature}`, (body) => {
  assertEqual(body.manifest?.record_hash, record.manifest.record_hash, 'GET record_hash');
  assertEqual(body.manifest?.ingested_server_t !== undefined, true, 'GET ingested_server_t present');
  assertEqual(Array.isArray(body.events), true, 'GET events array');
  assertEqual(body.events.length, record.events.length, 'GET events length');
  assertEqual(body.stats?.event_count, record.events.length, 'GET stats event_count');
  assertEqual(body.stats?.final_text_length, record.manifest.final_text_length, 'GET stats final_text_length');
  assertEqual(body.stats?.paste_event_count, 1, 'GET stats paste_event_count');
  assertEqual(Array.isArray(body.signals), true, 'GET signals array');
  assertEqual(body.signals.length, 2, 'GET signals length');
});
assertNoPlaintext('GET API response', JSON.stringify(fetched), true);

const recordShell = await checkHtml(`/${created.short_signature}`, ['possiblymadebyahuman record', 'id="root"', '/record-assets/']);
const assetMatch = recordShell.match(/src="(\/record-assets\/[^\"]+\.js)"/);
if (!assetMatch) throw new Error('record shell missing Vite JS asset');
const assetResponse = await fetch(`${baseUrl}${assetMatch[1]}`);
if (!assetResponse.ok) throw new Error(`Vite asset failed: ${assetResponse.status} ${await assetResponse.text()}`);
const assetText = await assetResponse.text();
if (!assetText.includes('Writing record')) throw new Error('Vite asset missing record page copy');
if (!assetText.includes('Content-blind replay')) throw new Error('Vite asset missing replay copy');
if (!assetText.includes('not a verdict')) throw new Error('Vite asset missing no-verdict copy');
assertNoPlaintext('Vite asset', assetText);

console.log(JSON.stringify({ ok: true, short_signature: created.short_signature, record_hash: created.record_hash }));

async function checkJson(path, validate) {
  const response = await fetch(`${baseUrl}${path}`);
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${await response.text()}`);
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) throw new Error(`${path} did not return JSON: ${contentType}`);
  const body = await response.json();
  validate(body);
  return body;
}

async function checkHtml(path, expectedSnippets) {
  const response = await fetch(`${baseUrl}${path}`);
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${await response.text()}`);
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/html')) throw new Error(`${path} did not return HTML: ${contentType}`);
  const body = await response.text();
  for (const snippet of expectedSnippets) {
    if (!body.includes(snippet)) throw new Error(`${path} missing expected snippet: ${snippet}`);
  }
  assertNoPlaintext(`${path} HTML`, body);
  return body;
}

function assertNoPlaintext(label, body, includeShortJsonFixture = false) {
  for (const plaintext of plaintextFixtures) {
    if (body.includes(plaintext)) throw new Error(`${label} leaked plaintext fixture: ${plaintext}`);
  }
  if (includeShortJsonFixture && body.includes(shortPlaintextJsonFixture)) {
    throw new Error(`${label} leaked plaintext fixture: ${shortPlaintextJsonFixture}`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
