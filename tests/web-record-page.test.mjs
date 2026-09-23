import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildActivityBins, buildDelayHistogram, buildLengthStepPoints, recordTimingDetails, buildTimelinePoints, checkCandidateAgainstBinding, describeBindingMatch, formatDuration, formatServerObservedSpan, formatUtcMinute, verifyRecordChain } from "../apps/web/src/record-utils.ts";
import { createTextBinding } from "../packages/format/src/index.ts";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const clone = (value) => JSON.parse(JSON.stringify(value));

async function recordFixture() {
  const [golden] = await readJson("packages/conformance/vectors/golden-records.json");
  const record = clone(golden.record);
  return {
    manifest: record.manifest,
    events: record.events,
    stats: {
      record_hash: record.manifest.record_hash,
      event_count: 4,
      duration_ms: 240,
      observed_final_length: 8,
      insert_op_count: 3,
      delete_op_count: 1,
      replace_op_count: 0,
      typed_event_count: 2,
      paste_event_count: 1,
      cut_event_count: 1,
      drop_event_count: 0,
      ime_event_count: 0,
      autocomplete_event_count: 0,
      programmatic_event_count: 0,
      unknown_source_count: 0,
      inserted_codepoints_total: 9,
      deleted_codepoints_total: 1,
      largest_atomic_insert_codepoints: 6,
      inter_event_delay_min_ms: 60,
      inter_event_delay_p50_ms: 60,
      inter_event_delay_p90_ms: 120,
      inter_event_delay_p95_ms: 120,
      inter_event_delay_p99_ms: 120,
      inter_event_delay_max_ms: 120,
      active_time_ms: 240,
      idle_time_ms: 0,
      long_pause_count: 0,
      delay_histogram: [],
    },
    signals: [],
  };
}

test("RecordPage source defines required public record sections without verdict language", async () => {
  const source = await readFile("apps/web/src/components.tsx", "utf8");
  for (const snippet of [
    "DisclaimerBanner",
    "CaptureContextSummary",
    "QuickStatsPanel",
    "EditTimeline",
    "SignalList",
    "SignalCard",
    "VerificationPanel",
    "ManifestDetails",
    "ObservationStatusLine",
    "ObservationCommitmentsList",
    "Edit timeline",
    "Analyzer signals as facts",
    "Server observed checkpoints.",
    "Partially observed.",
    "Not observed.",
    "No observation requested.",
    "Server-observed commitments",
    "Server-observed span:",
    "Server metadata",
  ]) {
    assert.match(source, new RegExp(snippet));
  }
  assert.doesNotMatch(source, /percentage-human|certificate of humanity|humanness/i);
  assert.doesNotMatch(source, new RegExp(`\\b${["hon", "est"].join("")}(ly|y)?\\b`, "i"));
});

test("ObservationStatusLine source uses only public state names, never producer-core local names", async () => {
  const source = await readFile("apps/web/src/components.tsx", "utf8");
  // Public state values that MAY appear in user-facing strings, JSX class names,
  // and discriminated-union case branches.
  const publicStates = ["observed", "partial", "unobserved", "not_requested"];
  for (const value of publicStates) {
    assert.ok(source.includes(value), `components.tsx must reference public state ${value}`);
  }
  // Producer-core local-state name `diverged` is unique and must never reach the
  // UI: by storage contract the public surface only carries observed / partial /
  // unobserved / not_requested. (The other producer-core local names — known,
  // unknown, disabled — overlap with normal English and a class/case guard is
  // already enforced by the ObservationState TS union at the type boundary.)
  assert.doesNotMatch(source, /["']diverged["']/, "components.tsx must not emit internal state name 'diverged'");
  // Defence in depth: no observation case branches off producer-core local names.
  for (const internal of ["known", "unknown", "disabled", "diverged"]) {
    const switchPattern = new RegExp(`case\\s+["']${internal}["']`);
    assert.doesNotMatch(source, switchPattern, `components.tsx must not branch on internal state name "${internal}"`);
    const classPattern = new RegExp(`observation-status-${internal}`);
    assert.doesNotMatch(source, classPattern, `components.tsx must not emit class observation-status-${internal}`);
  }
});

test("docs page for server-observed commitments anchors the load-bearing span definition", async () => {
  const docPath = "apps/site/content/docs/server-observed-commitments.md";
  const body = await readFile(docPath, "utf8");
  // Verbatim load-bearing definition required by the v5 wording sketch.
  assert.ok(
    body.includes("wall-clock distance between the first and last commitments; it does not count active typing, and it includes any idle gaps between commitments."),
    "load-bearing span definition must appear verbatim",
  );
  // Honest-family ban (already enforced by tests/copy-audit.test.mjs but locked here too).
  assert.doesNotMatch(body, new RegExp(`\\b${["hon", "est"].join("")}(ly|y)?\\b`, "i"));
});

test("ObservationStatusLine UI strings avoid positive-claim phrasings that would mislead", async () => {
  // The UI surface (status line + commitments list) is short and has no
  // negative-claim explanatory paragraphs, so a strict positive-claim ban is
  // appropriate here. The long-form docs page uses the same words in negative
  // form ("they are not a measurement of continuous typing") and is exercised
  // by the load-bearing-sentence test above instead.
  const source = await readFile("apps/web/src/components.tsx", "utf8");
  const positiveClaims = [
    /\bproof of authorship\b/i,
    /\bcontinuous\s+typing\b/i,
    /\btime\s+spent\s+writing\b/i,
    /\bactive\s+writing\s+time\b/i,
    /\bbadge\s+of\s+humanity\b/i,
    /\bcertificate\s+of\s+humanity\b/i,
    /\bhumanness\b/i,
    /\bproves\b/i,
  ];
  for (const pattern of positiveClaims) {
    assert.doesNotMatch(source, pattern, `components.tsx leaked overclaim: ${pattern}`);
  }
});

test("CaptureContextSummary renders browser.title and emacs.major_mode when present", async () => {
  const source = await readFile("apps/web/src/components.tsx", "utf8");
  assert.match(source, /context\.browser\?\.title/);
  assert.match(source, /Page title/);
  assert.match(source, /context\.emacs\?\.major_mode/);
  assert.match(source, /Major mode/);
});

test("browser-side verification helper recomputes the hash chain", async () => {
  const record = await recordFixture();
  const verification = verifyRecordChain(record);
  assert.equal(verification.ok, true);
  assert.equal(verification.computedRecordHash, record.manifest.record_hash);
});

test("browser-side verification helper reports tampering", async () => {
  const record = await recordFixture();
  record.events[0].ins_len = 3;
  const verification = verifyRecordChain(record);
  assert.equal(verification.ok, false);
  assert.ok(verification.messages.some((message) => message.includes("record_hash mismatch") || message.includes("insert op")));
});

test("edit timeline points track document length and markers", async () => {
  const record = await recordFixture();
  const points = buildTimelinePoints(record.events);
  assert.deepEqual(points.map((point) => point.documentLength), [2, 8, 7, 8]);
  assert.equal(points[1].source, "paste");
  assert.equal(points[1].ins_len, 6);
  assert.equal(points.some((point) => point.isLargeInsert), false);
});

test("formatUtcMinute renders an ISO instant as 'YYYY-MM-DD HH:MM UTC'", () => {
  assert.equal(formatUtcMinute("2026-05-28T14:02:11.000Z"), "2026-05-28 14:02 UTC");
});

test("formatServerObservedSpan rounds to seconds, minutes, then hours+minutes", () => {
  assert.equal(formatServerObservedSpan(45_000), "45 seconds");
  assert.equal(formatServerObservedSpan(1_964_000), "33 minutes");
  assert.equal(formatServerObservedSpan(3_600_000), "1 hour");
  assert.equal(formatServerObservedSpan(3_780_000), "1 hour 3 minutes");
});

test("edit timeline points preserve unknown process measurements", () => {
  const points = buildTimelinePoints([
    { seq: 0, t: 0, op: "insert", pos: 0, del_len: 0, ins_len: 3, source: "typing" },
    { seq: 1, t: 10, op: "insert", pos: null, del_len: null, ins_len: null, source: "unknown" },
  ]);
  assert.equal(points[1].pos, null);
  assert.equal(points[1].documentLength, null);
  assert.equal(points[1].isLargeInsert, false);
});

const BIND_SID = "123e4567-e89b-42d3-a456-426614174000";
const LONG_DOC = "We cannot prove a human wrote this but here is the recorded shape of the writing process";

test("checker uses bounded edge windows: whole, near-leading, near-trailing, and near-surrounding match", () => {
  const binding = createTextBinding(LONG_DOC, BIND_SID);
  const check = (candidate) => checkCandidateAgainstBinding(binding, candidate, BIND_SID);
  assert.equal(check(LONG_DOC).kind, "exact");
  assert.equal(check(`On Tuesday someone wrote:\n${LONG_DOC}`).kind, "leading");
  assert.equal(check(`${LONG_DOC}\n-- signature`).kind, "trailing");
  assert.equal(check(`Quoted header.\n${LONG_DOC}\n-- sig`).kind, "surrounding");
  assert.equal(check(`${"x".repeat(161)}${LONG_DOC}${"y".repeat(161)}`).kind, "none");
  assert.equal(check("An entirely different document.").kind, "none");
  assert.equal(check("   \n\t  !!!  ").kind, "none");
});

test("short bindings warn on every successful match, including whole/exact", () => {
  const shortBinding = createTextBinding("ok thanks", BIND_SID);
  for (const candidate of ["ok thanks", "ok thanks, see you", "well, ok thanks"]) {
    const summary = describeBindingMatch(checkCandidateAgainstBinding(shortBinding, candidate, BIND_SID));
    assert.equal(summary.ok, true);
    assert.equal(summary.short, true, `expected short warning for: ${candidate}`);
  }
  // A long binding does not warn even when matched exactly.
  const longSummary = describeBindingMatch(checkCandidateAgainstBinding(createTextBinding(LONG_DOC, BIND_SID), LONG_DOC, BIND_SID));
  assert.equal(longSummary.short, false);
});

test("timeline scale helper handles very long event logs and unknown lengths", async () => {
  const { buildTimelinePoints, timelineLengthScale } = await import("../apps/web/src/record-utils.ts");
  const events = Array.from({ length: 200_000 }, (_, seq) => ({
    seq, t: seq * 10, op: "insert", pos: seq, del_len: 0, ins_len: 1, source: "typing",
  }));
  assert.equal(timelineLengthScale(buildTimelinePoints(events), events.length), 200_000);
  assert.equal(timelineLengthScale(buildTimelinePoints(events), null), 200_000);
  assert.equal(timelineLengthScale([], null), 1);
});

test("timeline document length becomes unknown when events reach beyond the inferred length", () => {
  const points = buildTimelinePoints([
    { seq: 0, t: 0, op: "insert", pos: 5, del_len: 0, ins_len: 3, source: "typing" },
    { seq: 1, t: 10, op: "insert", pos: 0, del_len: 0, ins_len: 1, source: "typing" },
  ]);
  assert.equal(points[0].documentLength, null);
  assert.equal(points[1].documentLength, null);
});

test("text binding disclaimer says plainly it is not a check of exact text", async () => {
  const { TEXT_BINDING_DISCLAIMER } = await import("../apps/web/src/record-utils.ts");
  assert.match(TEXT_BINDING_DISCLAIMER, /not a check of exact text/);
});

test("delay values render as n/a without a unit when unknown", async () => {
  const { formatDelayMs } = await import("../apps/web/src/record-utils.ts");
  assert.equal(formatDelayMs(null), "n/a");
  assert.equal(formatDelayMs(60), "60ms");
});


test("activity preserves ordinary unknown-position edits without inventing document lengths", () => {
  const events = Array.from({length: 5}, (_, seq) => ({seq, t: seq * 100, op: "insert", pos: null, del_len: null, ins_len: 1, source: "typing"}));
  const bins = buildActivityBins(events, 400, 4);
  assert.equal(bins.reduce((sum, bin) => sum + bin.count, 0), 5);
  assert.equal(bins[0].count, 1);
  assert.equal(bins.at(-1).count, 2);
  assert.ok(buildTimelinePoints(events).every(point => point.documentLength === null));
});

test("activity distinguishes empty logs and zero-time edits and bounds dense charts", () => {
  assert.deepEqual(buildActivityBins([], 0), []);
  const event = {seq: 0, t: 0, op: "insert", pos: null, del_len: null, ins_len: 1, source: "typing"};
  assert.equal(buildActivityBins([event], 0).reduce((sum, bin) => sum + bin.count, 0), 1);
  const dense = Array.from({length: 200_000}, (_, seq) => ({...event, seq, t: seq}));
  const bins = buildActivityBins(dense, 0, 1000);
  assert.ok(bins.length <= 200);
  assert.equal(bins.reduce((sum, bin) => sum + bin.count, 0), dense.length);
  assert.ok(bins.at(-1).end >= dense.at(-1).t);
});

test("long session durations and observation spans use days without losing the pause", () => {
  const duration = 60 * 86400000 + 2 * 3600000;
  assert.equal(formatDuration(duration), "60d 2h");
  assert.equal(formatDuration(3 * 3600000 + 5 * 60000), "3h 5m");
  assert.equal(formatServerObservedSpan(duration), "60 days 2 hours");
});


test("length steps do not draw growth during a sixty-day pause or extrapolate into unknown history", () => {
  const pause = 60 * 86400000;
  const events = [
    { seq: 0, t: 1000, op: "insert", pos: 0, del_len: 0, ins_len: 3, source: "typing" },
    { seq: 1, t: pause, op: "insert", pos: 3, del_len: 0, ins_len: 2, source: "typing" },
    { seq: 2, t: pause + 1000, op: "delete", pos: null, del_len: null, ins_len: 0, source: "unknown" },
  ];
  assert.deepEqual(buildLengthStepPoints(buildTimelinePoints(events)), [
    { t: 1000, length: 3 }, { t: pause, length: 3 }, { t: pause, length: 5 },
  ]);
  assert.deepEqual(buildLengthStepPoints(buildTimelinePoints(events.slice(2))), []);
  const simultaneous = events.slice(0, 2).map(event => ({ ...event, t: 0 }));
  assert.deepEqual(buildLengthStepPoints(buildTimelinePoints(simultaneous)).map(point => point.length), [3, 3, 5]);
});

test("dense length geometry has no sloping segments and preserves the final length", () => {
  const events = Array.from({ length: 200_000 }, (_, seq) => ({ seq, t: seq * 10, op: "insert", pos: seq, del_len: 0, ins_len: 1, source: "typing" }));
  const steps = buildLengthStepPoints(buildTimelinePoints(events));
  assert.deepEqual(steps.at(-1), { t: 1_999_990, length: 200_000 });
  for (let index = 1; index < steps.length; index++) {
    assert.ok(steps[index].t === steps[index - 1].t || steps[index].length === steps[index - 1].length, "each segment must be vertical or horizontal");
  }
});

test("rhythm buckets conserve every gap and separate exact thresholds from overflow", () => {
  const delays = [0, 15, 16, 100, 99_999, 100_000, 100_001, 60 * 86400000];
  let elapsed = 0;
  const events = [0, ...delays].map((delay, seq) => ({ seq, t: elapsed += delay, op: "insert", pos: seq, del_len: 0, ins_len: 1, source: "typing" }));
  const histogram = buildDelayHistogram(events);
  assert.equal(histogram.underflow, 2, "zero and sub-16ms gaps are explicitly counted");
  assert.equal(histogram.overflow, 2, "100001ms and sixty days do not masquerade as 100s");
  assert.equal(histogram.bins[0].count, 1, "16ms belongs on the log axis");
  assert.equal(histogram.bins.at(-1).count, 2, "100s is included in the final finite bucket");
  assert.equal(histogram.total, 8);
  assert.equal(histogram.bins.reduce((sum, bin) => sum + bin.count, histogram.underflow + histogram.overflow), histogram.total);
  assert.equal(buildDelayHistogram([]).total, 0);
  assert.equal(buildDelayHistogram(events.slice(0, 1)).total, 0);
});

test("delay summaries use readable units for long gaps and retain null semantics", async () => {
  const { formatDelayMs } = await import("../apps/web/src/record-utils.ts");
  assert.equal(formatDelayMs(60 * 86400000), "60d 0h");
  assert.equal(formatDelayMs(90_000), "1m 30s");
  assert.equal(formatDelayMs(1_500), "1.5s");
  assert.equal(formatDelayMs(0), "0ms");
  assert.equal(formatDelayMs(null), "n/a");
});


test("signed finish separates endpoint waits from the measured editing span", async () => {
  const record = await recordFixture();
  record.manifest.format_version = "0.3";
  record.manifest.duration_ms = 60 * 86400000;
  record.events = record.events.map(event => ({ ...event, t: event.t + 1000 }));
  assert.deepEqual(recordTimingDetails(record), {
    signedFinish: true, editingSpanMs: 240, beforeFirstEditMs: 1000,
    afterLastEditMs: 60 * 86400000 - 1240,
  });
  record.manifest.format_version = "0.2";
  assert.equal(recordTimingDetails(record).signedFinish, false, "legacy duration is not described as hash-sealed finish");
});
