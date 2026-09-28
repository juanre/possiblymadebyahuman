import { expect, test } from './csp-guard.mjs';
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
  const timeline = page.locator('.edit-timeline');
  await expect(timeline).toContainText('bars show when edits happened');
  await expect(timeline.locator('.length-curve')).toHaveCount(0);
  await expect(timeline.locator('.activity-bar')).toHaveCount(5);
  await expect(timeline).not.toContainText('capture started inside existing text');
});

test('a known prefix keeps its length curve and also shows activity in the unknown tail', async ({page, request}) => {
  const record = await activityRecord(request, [ordinary(0, 0), ordinary(1, 1), ordinary(2), ordinary(3)]);
  await page.route(`**/api/records/${slug}`, route => route.fulfill({json: record}));
  await page.goto(`/${slug}`);
  const timeline = page.locator('.edit-timeline');
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
    const before = await page.locator('header.record-header h1').boundingBox();
    const summaryBefore = await page.locator('header.record-header .record-summary').boundingBox();
    release();
    await expect(page.getByRole('heading', {name: 'Signed writing record', exact: true})).toBeVisible();
    const after = await page.locator('header.record-header h1').boundingBox();
    for (const coordinate of ['x', 'y', 'width', 'height']) expect(Math.abs(after[coordinate] - before[coordinate])).toBeLessThan(1);
    const summaryAfter = await page.locator('header.record-header .record-summary').boundingBox();
    for (const coordinate of ['x', 'y', 'width']) expect(Math.abs(summaryAfter[coordinate] - summaryBefore[coordinate])).toBeLessThan(1);
    await expect(page.getByRole('status').first()).toContainText('Writing record loaded.');
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
  await expect(page.locator('.edit-timeline')).toContainText('No edit events');
  await expect(page.locator('.edit-timeline')).not.toContainText('length is unknown');
  await expect(page.locator('.chain-status')).toContainText('could not be verified');
  record = await activityRecord(request, [ordinary(0, 0)]);
  await page.reload();
  await expect(page.locator('.length-single')).toBeVisible();
  await expect(page.locator('.length-single title')).toContainText('1 character after the first edit');
});

for (const elapsed of [60 * 86400000, Number.MAX_SAFE_INTEGER]) {
  test(`long timeline ${elapsed} renders and verifies even outside the inferred calendar range`, async ({page, request}) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const record = await activityRecord(request, [ordinary(0, 0), {...ordinary(1), t: elapsed}]);
    await page.route(`**/api/records/${slug}`, route => route.fulfill({json: record}));
    await page.goto(`/${slug}`);
    await expect(page.getByRole('heading', {name: 'Signed writing record', exact: true})).toBeVisible();
    await expect(page.locator('.chain-status.ok')).toContainText('Hash chain recomputed in your browser.');
    await expect(page.locator('.edit-timeline')).toContainText(`${Math.floor(elapsed / 86400000)}d`);
    await expect(page.locator('.edit-timeline')).not.toContainText(/NaN|Infinity/);
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
    await expect(page.locator('.timeline-break')).toHaveCount(1);
    await expect(page.locator('.axis-label-break')).toHaveText('60d');
    await expect(page.locator('.fp-overflow')).toHaveAttribute('data-count', '1');
    await expect(page.locator('.fp-overflow title')).toHaveText('1 gap longer than 10 seconds');
    await expect(page.locator('.fingerprint-chart')).toContainText('>10s');
    await expect(page.locator('.writing-rhythm')).not.toContainText('100s');
    expect(await page.locator('.fp-bin').evaluateAll(bins => bins.reduce((sum, bin) => sum + Number(bin.dataset.count), 0))).toBe(0);
    await page.locator('details.technical-details > summary').click();
    const timingCounts = page.getByRole('region', {name: 'Timing and counts', exact: true});
    await expect(timingCounts).toContainText('Median and 95th-percentile gap60d 0h and 60d 0h');
    await expect(timingCounts).toContainText('Longest gap60d 0h');
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
  await page.locator('details.technical-details > summary').click();
  await expect(page.locator('.fp-underflow')).toBeVisible();
  await expect(page.locator('.fp-underflow title')).toHaveText('1 gap shorter than 16ms, including simultaneous edits');
  await expect(page.locator('.rhythm-overflow-summary')).toHaveCount(0);
});


test('a signed finish is labelled at the end of the time axis', async ({page, request}) => {
  const record = await activityRecord(request, [{...ordinary(0, 0), t: 9}, {...ordinary(1, 1), t: 2000}]);
  record.manifest.format_version = '0.3';
  record.manifest.duration_ms = 2400;
  record.manifest.record_hash = computeRecordHash(record.events, record.manifest.session_id, '0.3', undefined, record.manifest);
  record.stats.duration_ms = record.manifest.duration_ms;
  await page.route(`**/api/records/${slug}`, route => route.fulfill({json: record}));
  await page.goto(`/${slug}`);
  await expect(page.locator('.chain-status.ok')).toContainText('Hash chain recomputed in your browser.');
  await expect(page.locator('.axis-label-end')).toHaveText('signed at 2.4s');
  await expect(page.locator('.timeline-break')).toHaveCount(0);
  await expect(page.locator('.timeline-chart')).toHaveAttribute('aria-label', /Signed 400ms after the last edit/);
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
  await expect(page.locator('.chain-status.ok')).toContainText('Hash chain recomputed in your browser.');
  // Sixty days between the last edit and signing are cut from the time axis
  // and labelled; the one-second wait before the first edit stays to scale.
  const cut = page.locator('.timeline-break');
  await expect(cut).toHaveCount(1);
  await expect(cut.locator('title')).toHaveText('No edits for 60d');
  await expect(page.locator('.axis-label-break')).toHaveText('60d');
  await expect(page.locator('.axis-label-end')).toHaveText('signed at 60d');
  // The span in the summary includes the wait before signing; writing time does not.
  await expect(page.locator('.record-summary')).toContainText('over 60 days');
  const writingTime = page.locator('.record-fact').filter({hasText: 'Writing time'}).locator('dd');
  await expect(writingTime).toHaveText('1 second');
  const quickFacts = page.locator('.timing-counts');
  await expect(quickFacts).toContainText('Signed duration');
  await expect(quickFacts).toContainText('Editing span, first to last edit1.0s');
  await expect(quickFacts).toContainText('1.0s active, 0ms in pauses of 30 seconds or more');
  const geometry = await page.locator('.timeline-chart').evaluate(chart => {
    const line = chart.querySelector('.length-curve');
    const cut = chart.querySelector('.timeline-break rect');
    return { lineEnd: line.getPointAtLength(line.getTotalLength()).x, cutStart: cut.x.baseVal.value, cutWidth: cut.width.baseVal.value, width: chart.viewBox.baseVal.width };
  });
  expect(geometry.lineEnd).toBeCloseTo(geometry.cutStart, 4);
  expect(geometry.cutWidth).toBeLessThan(geometry.width / 10);
  // The exact same legacy duration is still usable but carries no finish seal.
  record.manifest.format_version = '0.2';
  record.manifest.record_hash = computeRecordHash(record.events, record.manifest.session_id, '0.2');
  await page.reload();
  await expect(page.locator('.axis-label-break')).toHaveText('60d');
  await expect(page.locator('.edit-timeline')).not.toContainText('signed at');
  await expect(quickFacts).toContainText('Reported duration');
  await expect(quickFacts).not.toContainText('Signed duration');
  await expect(page.locator('.record-summary')).toContainText('over an estimated 60 days');
});

test('the site mark draws without fetching any image', async ({page}) => {
  const imageRequests = [];
  page.on('request', r => { if (r.resourceType() === 'image') imageRequests.push(r.url()); });
  await page.route('**/favicon.svg', route => route.abort());
  await page.goto(`/${slug}`);
  await expect(page.getByRole('heading', {name: 'Signed writing record', exact: true})).toBeVisible();
  for (const mark of [page.locator('.record-home svg'), page.locator('.record-footer-mark svg')]) {
    const box = await mark.boundingBox();
    expect(box.width).toBeGreaterThan(10);
  }
  expect(await page.locator('main img').count()).toBe(0);
  expect(imageRequests.filter(url => !url.endsWith('/favicon.svg') && !url.endsWith('/favicon.ico'))).toEqual([]);
});

test('a continuation says what it continues and draws its length from where the parent ended', async ({page, request}) => {
  const parent = 'b3:' + 'c'.repeat(64);
  const typedAtEnd = Array.from({length: 6}, (_, seq) => ({seq, t: seq * 200, op: 'insert', pos: 500 + seq, del_len: 0, ins_len: 1, source: 'typing'}));
  const record = await activityRecord(request, typedAtEnd);
  record.manifest.format_version = '0.3';
  record.manifest.parent_record = parent;
  record.manifest.duration_ms = 1400;
  record.manifest.record_hash = computeRecordHash(record.events, record.manifest.session_id, '0.3', undefined, record.manifest);
  record.stats.duration_ms = 1400;
  record.stats.starting_length = 500;
  record.stats.observed_final_length = 506;
  await page.route(`**/api/records/${slug}`, route => route.fulfill({json: record}));
  await page.goto(`/${slug}`);
  const continues = page.locator('header.record-header .record-continues');
  await expect(continues).toHaveText('It continues an earlier record, which covers the writing before it.');
  await expect(continues.getByRole('link', {name: 'an earlier record'})).toHaveAttribute('href', `/${parent}`);
  await expect(page.locator('.edit-timeline .length-curve')).toHaveCount(1);
  await expect(page.locator('.edit-timeline text.length-scale')).toHaveText('506 characters');
});
