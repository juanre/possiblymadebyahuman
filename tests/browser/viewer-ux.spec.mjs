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

for (const elapsed of [60 * 86400000, Number.MAX_SAFE_INTEGER]) {
  test(`long timeline ${elapsed} renders and verifies even outside the inferred calendar range`, async ({page, request}) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const record = await activityRecord(request, [ordinary(0, 0), {...ordinary(1), t: elapsed}]);
    await page.route(`**/api/records/${slug}`, route => route.fulfill({json: record}));
    await page.goto(`/${slug}`);
    await expect(page.getByRole('heading', {name: 'Signed writing record', exact: true})).toBeVisible();
    await expect(page.getByText('Hash chain recomputed in your browser.', {exact: true})).toBeVisible();
    await expect(page.locator('.timeline-card')).toContainText(`${Math.floor(elapsed / 86400000)}d`);
    await expect(page.locator('.timeline-card')).not.toContainText(/NaN|Infinity/);
    expect(errors).toEqual([]);
  });
}


for (const width of [390, 1280]) {
  test(`a sixty-day pause stays flat and is separate from the rhythm axis at ${width}px`, async ({page, request}) => {
    await page.setViewportSize({width, height: 900});
    const pause = 60 * 86400000;
    const record = await activityRecord(request, [ordinary(0, 0), {...ordinary(1, 1), t: pause}]);
    for (const percentile of ['p50', 'p95', 'max']) record.stats[`inter_event_delay_${percentile}_ms`] = pause;
    await page.route(`**/api/records/${slug}`, route => route.fulfill({json: record}));
    await page.goto(`/${slug}`);
    const line = page.locator('.length-curve');
    await expect(line).toBeVisible();
    const geometry = await line.evaluate(path => {
      const coords = path.getAttribute('d').match(/-?\d+(?:\.\d+)?/g).map(Number);
      const start = path.getPointAtLength(0);
      const end = path.getPointAtLength(path.getTotalLength());
      const middle = path.getPointAtLength((end.x - start.x) / 2);
      return { coords, start: { x: start.x, y: start.y }, middle: { x: middle.x, y: middle.y }, end: { x: end.x, y: end.y } };
    });
    expect(geometry.middle.y).toBeCloseTo(geometry.start.y, 4);
    expect(geometry.end.y).toBeLessThan(geometry.start.y);
    expect(geometry.coords).toHaveLength(6);
    expect(geometry.coords[1]).toBe(geometry.coords[3]);
    expect(geometry.coords[2]).toBe(geometry.coords[4]);
    await expect(page.locator('.fp-overflow')).toHaveAttribute('data-count', '1');
    await expect(page.locator('.rhythm-overflow-summary')).toContainText('1 gap longer than 100 seconds');
    expect(await page.locator('.fp-bin').evaluateAll(bins => bins.reduce((sum, bin) => sum + Number(bin.dataset.count), 0))).toBe(0);
    for (const label of ['Median gap', '95th-percentile gap', 'Longest pause']) {
      await expect(page.locator('.fingerprint-stats div').filter({has: page.getByText(label, {exact: true})})).toContainText('60d 0h');
    }
    const labels = await page.locator('.fingerprint-chart text').evaluateAll(nodes => nodes.map(node => { const rect = node.getBoundingClientRect(); return {left: rect.left, right: rect.right}; }));
    for (let index = 1; index < labels.length; index++) expect(labels[index].left).toBeGreaterThan(labels[index - 1].right);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test('length stroke and fill end together before an unknown gap, without a false collapse', async ({page, request}) => {
  const record = await activityRecord(request, [ordinary(0, 0), ordinary(1, 1), {...ordinary(2), t: 100_000}]);
  await page.route(`**/api/records/${slug}`, route => route.fulfill({json: record}));
  await page.goto(`/${slug}`);
  const geometry = await page.locator('.timeline-chart').evaluate(chart => {
    const line = chart.querySelector('.length-curve');
    const fill = chart.querySelector('.length-area');
    const end = line.getPointAtLength(line.getTotalLength());
    const fillBox = fill.getBBox();
    return { endX: end.x, endY: end.y, fillRight: fillBox.x + fillBox.width, baseline: fillBox.y + fillBox.height, chartWidth: chart.viewBox.baseVal.width };
  });
  expect(geometry.endX).toBeCloseTo(geometry.fillRight, 4);
  expect(geometry.endY).toBeLessThan(geometry.baseline);
  expect(geometry.endX).toBeLessThan(geometry.chartWidth / 2);
  await expect(page.locator('.activity-strip .activity-bar')).not.toHaveCount(0);
});

test('simultaneous edits remain visible in the explicitly labelled short-gap bucket', async ({page, request}) => {
  const record = await activityRecord(request, [ordinary(0, 0), {...ordinary(1, 1), t: 0}]);
  await page.route(`**/api/records/${slug}`, route => route.fulfill({json: record}));
  await page.goto(`/${slug}`);
  await expect(page.locator('.fp-underflow')).toHaveAttribute('data-count', '1');
  await expect(page.locator('.fp-underflow')).toBeVisible();
  await expect(page.locator('.rhythm-overflow-summary')).toContainText('including gaps of zero milliseconds');
});


test('signed finish displays endpoint waits separately without extending the document-length curve', async ({page, request}) => {
  const record = await activityRecord(request, [{...ordinary(0, 0), t: 1000}, {...ordinary(1, 1), t: 2000}]);
  record.manifest.format_version = '0.3';
  record.manifest.duration_ms = 60 * 86400000 + 2000;
  record.manifest.record_hash = computeRecordHash(record.events, record.manifest.session_id, '0.3', undefined, record.manifest);
  record.stats.duration_ms = record.manifest.duration_ms;
  record.stats.active_time_ms = 1000;
  record.stats.idle_time_ms = 0;
  await page.route(`**/api/records/${slug}`, route => route.fulfill({json: record}));
  await page.goto(`/${slug}`);
  await expect(page.getByText('Hash chain recomputed in your browser.', {exact: true})).toBeVisible();
  await expect(page.locator('.signed-finish-summary')).toContainText('The final 60d 0h contains no captured edits');
  await expect(page.locator('.signed-finish-summary')).toContainText('during the first 1.0s');
  await expect(page.locator('.signed-finish-gap')).toBeVisible();
  await expect(page.locator('.before-first-edit-gap')).toBeVisible();
  const quickFacts = page.locator('section').filter({has: page.getByRole('heading', {name: 'Quick facts', exact: true})});
  await expect(quickFacts).toContainText('Signed duration');
  await expect(quickFacts.locator('.stat').filter({hasText: 'Editing span'})).toContainText('1.0s');
  await expect(quickFacts.locator('.stat').filter({hasText: 'Active / idle between edits'})).toContainText('1.0s / 0ms');
  const geometry = await page.locator('.timeline-chart').evaluate(chart => {
    const line = chart.querySelector('.length-curve');
    const gap = chart.querySelector('.signed-finish-gap');
    return { lineEnd: line.getPointAtLength(line.getTotalLength()).x, gapStart: gap.x.baseVal.value, gapWidth: gap.width.baseVal.value, width: chart.viewBox.baseVal.width };
  });
  expect(geometry.lineEnd).toBeCloseTo(geometry.gapStart, 4);
  expect(geometry.gapWidth).toBeGreaterThan(geometry.width / 2);
  // The exact same legacy duration is still usable but carries no finish seal.
  record.manifest.format_version = '0.2';
  record.manifest.record_hash = computeRecordHash(record.events, record.manifest.session_id, '0.2');
  await page.reload();
  await expect(page.locator('.signed-finish-summary')).toHaveCount(0);
  await expect(page.locator('.signed-finish-gap')).toHaveCount(0);
  await expect(quickFacts).toContainText('Reported duration');
  await expect(quickFacts).not.toContainText('Signed duration');
});
