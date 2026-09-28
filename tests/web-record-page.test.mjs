import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildDelayHistogram, buildLengthStepPoints, recordTimingDetails, buildTimelinePoints, checkCandidateAgainstBinding, describeBindingMatch, formatDuration, formatServerObservedSpan, formatUtcMinute, verifyRecordChain } from "../apps/web/src/record-utils.ts";
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
    "RecordHeader",
    "VerificationAlert",
    "TechnicalDetails",
    "TimingAndCounts",
    "EditTimeline",
    "SignalList",
    "SignalCard",
    "VerificationPanel",
    "ManifestDetails",
    "ObservationStatusLine",
    "ObservationCommitmentsList",
    "Edit timeline",
    "Technical details",
    "Analyzer signals",
    "This record shows how the text was edited.",
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

test("delay values render as not measured, without a unit, when unknown", async () => {
  const { formatDelayMs } = await import("../apps/web/src/record-utils.ts");
  assert.equal(formatDelayMs(null), "not measured");
  assert.equal(formatDelayMs(60), "60ms");
});


test("unknown-position edits never invent document lengths", () => {
  const events = Array.from({length: 5}, (_, seq) => ({seq, t: seq * 100, op: "insert", pos: null, del_len: null, ins_len: 1, source: "typing"}));
  assert.ok(buildTimelinePoints(events).every(point => point.documentLength === null));
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
  const delays = [0, 15, 16, 100, 9_999, 10_000, 10_001, 60 * 86400000];
  let elapsed = 0;
  const events = [0, ...delays].map((delay, seq) => ({ seq, t: elapsed += delay, op: "insert", pos: seq, del_len: 0, ins_len: 1, source: "typing" }));
  const histogram = buildDelayHistogram(events);
  assert.equal(histogram.underflow, 2, "zero and sub-16ms gaps are explicitly counted");
  assert.equal(histogram.overflow, 2, "10001ms and sixty days do not masquerade as 10s");
  assert.equal(histogram.bins[0].count, 1, "16ms belongs on the log axis");
  assert.equal(histogram.bins.at(-1).count, 2, "10s is included in the final finite bucket");
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
  assert.equal(formatDelayMs(null), "not measured");
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

async function summaryFixture() {
  const record = await recordFixture();
  record.manifest.format_version = "0.3";
  record.manifest.duration_ms = 24 * 60_000;
  record.manifest.ingested_server_t = "2026-05-28T23:30:00.000Z";
  record.stats.event_count = 312;
  record.stats.paste_event_count = 0;
  record.stats.largest_atomic_insert_codepoints = 12;
  record.stats.observed_final_length = 1204;
  record.stats.active_time_ms = 18 * 60_000;
  record.stats.delete_op_count = 41;
  record.stats.deleted_codepoints_total = 1310;
  record.observation = { state: "observed", observed_session_id: null, commitments: [], checkpoint_count: 12, first_observed_at: null, last_observed_at: null, server_observed_span_ms: 23 * 60_000 };
  return record;
}

test("record summary sentence gives only the span and publication date", async () => {
  const { describeRecordSummary } = await import("../apps/web/src/record-utils.ts");
  const record = await summaryFixture();
  assert.equal(describeRecordSummary(record), "Written over 24 minutes and published 28 May 2026.");
  for (const phrase of [/\bonly\b/i, /\bjust\b/i, /suspicious/i, /natural/i, /simply/i, /\bedits?\b/, /paste/, /Emacs|browser|page/]) {
    assert.doesNotMatch(describeRecordSummary(record), phrase);
  }
});

test("record summary sentence marks estimated spans", async () => {
  const { describeRecordSummary } = await import("../apps/web/src/record-utils.ts");
  const record = await summaryFixture();
  record.manifest.format_version = "0.2";
  record.manifest.ingested_server_t = null;
  assert.equal(describeRecordSummary(record), "Written over an estimated 24 minutes.");
  record.manifest.duration_ms = 240;
  record.manifest.format_version = "0.3";
  assert.equal(describeRecordSummary(record), "Written in under a second.");
});

test("record facts show each measurement once, with writing time that leaves out pauses", async () => {
  const { recordFacts } = await import("../apps/web/src/record-utils.ts");
  const record = await summaryFixture();
  assert.deepEqual(recordFacts(record), [
    { label: "Writing time", value: "18 minutes" },
    { label: "Edits", value: "312" },
    { label: "Deleted", value: "1,310 characters" },
    { label: "Pastes", value: "none" },
    { label: "Largest insertion", value: "12 characters" },
    { label: "Length", value: "1,204 characters" },
  ]);
  record.manifest.text_binding = { scheme: "canon-letters/0.1", commitment: "b3:00", canonical_length: 950 };
  assert.deepEqual(recordFacts(record).at(-1), { label: "Signed text", value: "950 letters and digits" });
  record.manifest.format_version = "0.2";
  record.stats.active_time_ms = 400;
  record.stats.paste_event_count = 2;
  record.stats.largest_atomic_insert_codepoints = null;
  record.stats.observed_final_length = null;
  record.stats.delete_op_count = 1;
  record.stats.deleted_codepoints_total = null;
  const facts = Object.fromEntries(recordFacts(record).map(({ label, value }) => [label, value]));
  assert.equal(facts.Deleted, "not measured");
  assert.equal(facts["Writing time"], "under a second");
  assert.equal(facts.Pastes, "2");
  assert.equal(facts["Largest insertion"], "not measured");
  assert.equal(facts.Length, "not measured");
});

test("the server's part in a record is described in one plain sentence", async () => {
  const { describeObservation } = await import("../apps/web/src/record-utils.ts");
  const observation = { state: "observed", commitments: [], checkpoint_count: 12, first_observed_at: null, last_observed_at: null, server_observed_span_ms: 23 * 60_000 };
  assert.equal(describeObservation(observation), "The server received 12 checkpoints over 23 minutes while it was written.");
  assert.equal(describeObservation({ ...observation, checkpoint_count: 1, server_observed_span_ms: 0 }), "The server received 1 checkpoint while it was written.");
  assert.equal(describeObservation({ ...observation, state: "partial" }), "The server received 12 checkpoints over 23 minutes, covering only part of the writing.");
  assert.equal(describeObservation({ ...observation, state: "unobserved" }), "The server received no checkpoints while it was written.");
  assert.equal(describeObservation({ ...observation, state: "not_requested" }), "The writing tool did not send the server checkpoints.");
});

test("signed text length is phrased as letters and digits", async () => {
  const { formatSignedTextLength } = await import("../apps/web/src/record-utils.ts");
  assert.equal(formatSignedTextLength(95), "95 letters and digits");
  assert.equal(formatSignedTextLength(1204), "1,204 letters and digits");
  assert.equal(formatSignedTextLength(1), "1 letter or digit");
});

test("the rhythm curve is a smooth density over the log scale that keeps every in-range gap", async () => {
  const { buildDelayDensity, RHYTHM_MIN_MS, RHYTHM_MAX_MS, RHYTHM_BIN_COUNT } = await import("../apps/web/src/record-utils.ts");
  let seed = 3; const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const gaps = Array.from({ length: 5000 }, () => Math.round(80 + random() * 140));
  let t = 0;
  const events = [{ seq: 0, t: 0 }, ...gaps.map((gap, index) => ({ seq: index + 1, t: t += gap }))]
    .map(event => ({ ...event, op: "insert", pos: event.seq, del_len: 0, ins_len: 1, source: "typing" }));
  const density = buildDelayDensity(events);
  assert.ok(density.length >= 200, "fine enough to draw a smooth line");
  assert.equal(density[0].ms, RHYTHM_MIN_MS);
  assert.ok(Math.abs(density.at(-1).ms - RHYTHM_MAX_MS) < 1e-6);
  const peak = density.reduce((best, point) => point.value > best.value ? point : best);
  assert.ok(peak.ms > 80 && peak.ms < 220, `peak at ${peak.ms}ms sits among the gaps`);
  // Values are in gaps per rhythm bucket, so they share a scale with the edge bars.
  const step = (Math.log10(RHYTHM_MAX_MS) - Math.log10(RHYTHM_MIN_MS)) / (density.length - 1);
  const bucketWidth = (Math.log10(RHYTHM_MAX_MS) - Math.log10(RHYTHM_MIN_MS)) / RHYTHM_BIN_COUNT;
  const area = density.reduce((sum, point) => sum + point.value, 0) * step / bucketWidth;
  assert.ok(Math.abs(area - gaps.length) / gaps.length < 0.02, `area ${area} matches ${gaps.length} gaps`);
  // No jagged spikes: neighbouring points change gradually.
  for (let index = 1; index < density.length; index++) assert.ok(Math.abs(density[index].value - density[index - 1].value) < peak.value * 0.1);
});

test("the rhythm curve is empty without in-range gaps and ignores gaps outside the scale", async () => {
  const { buildDelayDensity } = await import("../apps/web/src/record-utils.ts");
  const event = (seq, t) => ({ seq, t, op: "insert", pos: seq, del_len: 0, ins_len: 1, source: "typing" });
  assert.deepEqual(buildDelayDensity([]), []);
  assert.deepEqual(buildDelayDensity([event(0, 0), event(1, 0), event(2, 60_000)]), []);
  const single = buildDelayDensity([event(0, 0), event(1, 150)]);
  assert.ok(single.some(point => point.value > 0));
  assert.ok(single.every(point => Number.isFinite(point.value)));
});
