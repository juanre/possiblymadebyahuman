import assert from "node:assert/strict";
import test from "node:test";

import { ELIDED_PAUSE_MS, MAX_ELIDED_PAUSES, buildActivityColumns, buildTimeAxis, formatPauseLength, formatTimelineTick, layoutTimeAxisLabels } from "../apps/web/src/record-utils.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const seconds = (from, to, step = 1000) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, index) => from + index * step);

test("pauses of five minutes or more are cut out of the time axis and keep their length", () => {
  const times = [...seconds(0, MINUTE), ...seconds(2 * HOUR, 2 * HOUR + MINUTE)];
  const axis = buildTimeAxis(times, 2 * HOUR + MINUTE, 1000, 28);
  assert.equal(axis.breaks.length, 1);
  assert.equal(axis.breaks[0].start, MINUTE);
  assert.equal(axis.breaks[0].end, 2 * HOUR);
  assert.equal(axis.x(2 * HOUR) - axis.x(MINUTE), 28);
  assert.equal(axis.x(0), 0);
  assert.equal(axis.x(2 * HOUR + MINUTE), 1000);
  const [first, second] = axis.spans;
  assert.ok(Math.abs((first.x1 - first.x0) - (second.x1 - second.x0)) < 1, "equal writing stretches get equal widths");
});

test("pauses shorter than five minutes stay to scale", () => {
  const axis = buildTimeAxis([0, ELIDED_PAUSE_MS - 1, ELIDED_PAUSE_MS + 1000], ELIDED_PAUSE_MS + 1000, 1000, 28);
  assert.equal(axis.breaks.length, 0);
  assert.equal(axis.spans.length, 1);
  assert.ok(Math.abs(axis.x((ELIDED_PAUSE_MS + 1000) / 2) - 500) < 1e-9);
});

test("long waits before the first edit and before signing are cut too", () => {
  const times = seconds(10 * MINUTE, 11 * MINUTE);
  const axis = buildTimeAxis(times, 11 * MINUTE + DAY, 1000, 28);
  assert.deepEqual(axis.breaks.map(({ start, end }) => [start, end]), [[0, 10 * MINUTE], [11 * MINUTE, 11 * MINUTE + DAY]]);
  assert.equal(axis.x(11 * MINUTE + DAY), 1000);
});

test("only the longest pauses are cut when there are many", () => {
  const times = [0];
  for (let index = 1; index <= 20; index++) times.push(times.at(-1) + ELIDED_PAUSE_MS + index * MINUTE);
  const axis = buildTimeAxis(times, times.at(-1), 2000, 28);
  assert.equal(axis.breaks.length, MAX_ELIDED_PAUSES);
  const shortestCut = Math.min(...axis.breaks.map(gap => gap.end - gap.start));
  assert.equal(shortestCut, ELIDED_PAUSE_MS + (20 - MAX_ELIDED_PAUSES + 1) * MINUTE);
  for (let index = 1; index < axis.breaks.length; index++) assert.ok(axis.breaks[index].start > axis.breaks[index - 1].start);
});

test("a stretch with a single edit still gets visible width on either side of a long pause", () => {
  const axis = buildTimeAxis([0, 60 * DAY], 60 * DAY, 400, 28);
  assert.equal(axis.breaks.length, 1);
  for (const span of axis.spans) assert.ok(span.x1 - span.x0 >= 8);
  assert.ok(axis.x(0) < axis.x(60 * DAY));
  assert.ok(Number.isFinite(axis.x(60 * DAY)));
});

test("the axis stays finite for durations beyond any calendar", () => {
  const axis = buildTimeAxis([0, Number.MAX_SAFE_INTEGER], Number.MAX_SAFE_INTEGER, 400, 28);
  assert.ok(Number.isFinite(axis.x(Number.MAX_SAFE_INTEGER)));
  assert.ok(axis.x(Number.MAX_SAFE_INTEGER) <= 400);
});

test("activity columns never straddle a cut pause and keep every edit", () => {
  const times = [...seconds(0, MINUTE, 100), ...seconds(DAY, DAY + MINUTE, 100)];
  const events = times.map((t, seq) => ({ seq, t, op: "insert", pos: null, del_len: null, ins_len: 1, source: "typing" }));
  const axis = buildTimeAxis(times, times.at(-1), 1000, 28);
  const columns = buildActivityColumns(events, axis, 10);
  assert.equal(columns.reduce((sum, column) => sum + column.count, 0), events.length);
  const cut = axis.breaks[0];
  for (const column of columns) assert.ok(column.end <= cut.start || column.start >= cut.end);
  assert.ok(columns.length <= 1000 / 10);
  for (const column of columns) assert.ok(column.x1 > column.x0);
});

test("activity columns count simultaneous edits and stay bounded for dense logs", () => {
  const event = { seq: 0, t: 0, op: "insert", pos: null, del_len: null, ins_len: 1, source: "typing" };
  const single = buildActivityColumns([event], buildTimeAxis([0], 0, 300, 28), 10);
  assert.equal(single.reduce((sum, column) => sum + column.count, 0), 1);
  const dense = Array.from({ length: 200_000 }, (_, seq) => ({ ...event, seq, t: seq }));
  const columns = buildActivityColumns(dense, buildTimeAxis(dense.map(e => e.t), dense.at(-1).t, 1000, 28), 10);
  assert.ok(columns.length <= 100);
  assert.equal(columns.reduce((sum, column) => sum + column.count, 0), dense.length);
});

test("axis labels name each cut pause's length and never overlap", () => {
  const times = [...seconds(0, 40 * MINUTE, 5000), ...seconds(20 * HOUR, 21 * HOUR, 5000), ...seconds(44 * HOUR, 44 * HOUR + 35 * MINUTE, 5000)];
  const axis = buildTimeAxis(times, times.at(-1), 700, 28);
  const labels = layoutTimeAxisLabels(axis);
  const breaks = labels.filter(label => label.kind === "break").map(label => label.text);
  assert.deepEqual(breaks, ["19h 20m", "23h"]);
  assert.equal(labels.find(label => label.kind === "tick")?.text, "0:00");
  const sorted = [...labels].sort((a, b) => a.x - b.x);
  for (let index = 1; index < sorted.length; index++) {
    assert.ok(sorted[index].left >= sorted[index - 1].right, `${sorted[index - 1].text} overlaps ${sorted[index].text}`);
  }
  for (const label of labels) assert.ok(label.left >= 0 && label.right <= 700, `${label.text} stays inside the axis`);
});

test("pause lengths and tick times read as plain elapsed time", () => {
  assert.equal(formatPauseLength(12 * MINUTE + 20_000), "12m");
  assert.equal(formatPauseLength(HOUR), "1h");
  assert.equal(formatPauseLength(18 * HOUR + 40 * MINUTE), "18h 40m");
  assert.equal(formatPauseLength(60 * DAY), "60d");
  assert.equal(formatPauseLength(DAY + 3 * HOUR), "1d 3h");
  assert.equal(formatTimelineTick(3600), "1h");
  assert.equal(formatTimelineTick(5400), "1h 30m");
  assert.equal(formatTimelineTick(2 * 86400), "2d");
  assert.equal(formatTimelineTick(90_000), "1d 1h");
  assert.equal(formatTimelineTick(90), "1:30");
  assert.equal(formatTimelineTick(26.7), "26.7s");
});

test("the end of the time axis is labelled, and says so when the finish was signed", () => {
  const times = seconds(0, 20_000);
  const axis = buildTimeAxis(times, 26_700, 600, 28);
  const signed = layoutTimeAxisLabels(axis, { endPrefix: "signed at " }).find(label => label.kind === "end");
  assert.equal(signed.text, "signed at 26.7s");
  assert.equal(signed.anchor, "end");
  assert.equal(signed.right, 600);
  assert.equal(layoutTimeAxisLabels(axis).find(label => label.kind === "end").text, "26.7s");
});

test("pause lengths that would collide move to a second row instead of disappearing", () => {
  const times = [...seconds(0, 10 * MINUTE, 5000), ...seconds(5 * HOUR, 5 * HOUR + 2 * MINUTE, 5000), ...seconds(23 * HOUR, 23 * HOUR + 40 * MINUTE, 5000)];
  const axis = buildTimeAxis(times, times.at(-1), 300, 28);
  const labels = layoutTimeAxisLabels(axis);
  const breaks = labels.filter(label => label.kind === "break");
  assert.deepEqual(breaks.map(label => label.text), ["4h 50m", "17h 58m"]);
  assert.deepEqual(breaks.map(label => label.row), [0, 1]);
  for (const row of [0, 1]) {
    const inRow = labels.filter(label => label.row === row).sort((a, b) => a.x - b.x);
    for (let index = 1; index < inRow.length; index++) assert.ok(inRow[index].left >= inRow[index - 1].right);
  }
  assert.ok(labels.filter(label => label.kind === "tick" || label.kind === "resume").every(label => label.row === 0));
});

test("two pauses of the same length are both labelled", () => {
  const times = [...seconds(0, 20 * MINUTE, 5000), ...seconds(30 * MINUTE, 50 * MINUTE, 5000), ...seconds(60 * MINUTE, 80 * MINUTE, 5000)];
  const labels = layoutTimeAxisLabels(buildTimeAxis(times, times.at(-1), 900, 28));
  assert.deepEqual(labels.filter(label => label.kind === "break").map(label => label.text), ["10m", "10m"]);
});

test("the signed finish stays labelled when a long wait before it is cut", () => {
  const times = seconds(0, 2000);
  const axis = buildTimeAxis(times, 60 * DAY, 400, 28);
  const labels = layoutTimeAxisLabels(axis, { endPrefix: "signed at " });
  assert.equal(labels.find(label => label.kind === "break").text, "59d 23h");
  const end = labels.find(label => label.kind === "end");
  assert.equal(end.text, "signed at 60d");
  assert.equal(end.row, 1);
});
