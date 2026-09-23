import { expect, test } from '@playwright/test';
import { computeRecordHash } from '../../packages/format/src/index.ts';

const slug = process.env.PMBAH_FIXTURE_SLUG ?? 'smoke';

async function activityRecord(request, events) {
  const record = await (await request.get(`/api/records/${slug}`)).json();
  record.events = events;
  delete record.manifest.text_binding;
  record.manifest.format_version = '0.2';
  record.manifest.event_count = events.length;
  record.manifest.duration_ms = events.at(-1)?.t ?? 0;
  // Empty logs cannot be signed; retain the fixture hash to exercise a malformed
  // response's empty-state UI alongside its verification failure.
  if (events.length) record.manifest.record_hash = computeRecordHash(events, record.manifest.session_id, '0.2');
  record.stats.observed_final_length = null;
  record.stats.event_count = events.length;
  record.stats.duration_ms = record.manifest.duration_ms;
  record.observation = { state: 'not_requested', commitments: [], first_observed_at: null, last_observed_at: null, server_observed_span_ms: null };
  return record;
}
const ordinary = (seq, pos = null) => ({seq, t: seq * 100, op: 'insert', pos, del_len: pos === null ? null : 0, ins_len: 1, source: 'typing'});

test('legacy ordinary typing has activity without a fabricated length curve', async ({page, request}) => {
  const record = await activityRecord(request, Array.from({length: 5}, (_, seq) => ordinary(seq)));
  await page.route(`**/api/records/${slug}`, route => route.fulfill({json: record}));
  await page.goto(`/${slug}`);
  const timeline = page.locator('.timeline-card');
  await expect(timeline).toContainText('bars show when edits happened');
  await expect(timeline.locator('.length-curve')).toHaveCount(0);
  await expect(timeline.locator('.activity-bar')).toHaveCount(5);
  await expect(timeline).not.toContainText('capture started inside existing text');
});

test('a known prefix keeps its length curve and also shows activity in the unknown tail', async ({page, request}) => {
  const record = await activityRecord(request, [ordinary(0, 0), ordinary(1, 1), ordinary(2), ordinary(3)]);
  await page.route(`**/api/records/${slug}`, route => route.fulfill({json: record}));
  await page.goto(`/${slug}`);
  const timeline = page.locator('.timeline-card');
  await expect(timeline).toContainText('up to edit 2 of 4');
  await expect(timeline.locator('.length-curve')).toHaveCount(1);
  await expect(timeline.locator('.activity-strip .activity-bar')).toHaveCount(4);
});

for (const width of [390, 1280]) {
  test(`loading uses a stable header without flashing a different title at ${width}px`, async ({page, request}) => {
    await page.setViewportSize({width, height: 900});
    const record = await (await request.get(`/api/records/${slug}`)).json();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route(`**/api/records/${slug}`, async route => { await gate; await route.fulfill({json: record}); });
    await page.goto(`/${slug}`);
    await expect(page.getByRole('status')).toContainText('Loading writing record');
    await expect(page.getByRole('heading', {name: 'Signed writing record', exact: true})).toHaveCount(0);
    const before = await page.locator('header.signet h1').boundingBox();
    release();
    await expect(page.getByRole('heading', {name: 'Signed writing record', exact: true})).toBeVisible();
    const after = await page.locator('header.signet h1').boundingBox();
    for (const coordinate of ['x', 'y', 'width', 'height']) expect(Math.abs(after[coordinate] - before[coordinate])).toBeLessThan(1);
  });
}

test('a failed fetch offers an in-page retry and does not claim a signed record', async ({page, request}) => {
  const record = await (await request.get(`/api/records/${slug}`)).json();
  let failed = true;
  await page.route(`**/api/records/${slug}`, route => failed ? route.fulfill({status: 503, body: 'Unavailable'}) : route.fulfill({json: record}));
  await page.goto(`/${slug}`);
  await expect(page.getByRole('heading', {name: 'Writing record unavailable'})).toBeVisible();
  await expect(page.getByRole('heading', {name: 'Signed writing record', exact: true})).toHaveCount(0);
  failed = false;
  await page.getByRole('button', {name: 'Try again'}).click();
  await expect(page.getByRole('heading', {name: 'Signed writing record', exact: true})).toBeVisible();
});


test('zero edits are explicit and one measurable edit has a visible length point', async ({page, request}) => {
  let record = await activityRecord(request, []);
  await page.route(`**/api/records/${slug}`, route => route.fulfill({json: record}));
  await page.goto(`/${slug}`);
  await expect(page.locator('.timeline-card')).toContainText('No edit events');
  await expect(page.locator('.timeline-card')).not.toContainText('length is unknown');
  await expect(page.locator('.chain-status')).toContainText('could not be verified');
  record = await activityRecord(request, [ordinary(0, 0)]);
  await page.reload();
  await expect(page.locator('.length-single')).toBeVisible();
  await expect(page.locator('.length-single title')).toContainText('1 codepoints');
});
