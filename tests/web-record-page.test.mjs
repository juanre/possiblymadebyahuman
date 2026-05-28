import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildReplayPoints, verifyRecordChain } from "../apps/web/src/record-utils.ts";

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
      final_text_length: 8,
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
    "ReplayScrubber",
    "SignalList",
    "SignalCard",
    "VerificationPanel",
    "ChainVerificationButton",
    "ManifestDetails",
    "Content-blind replay",
    "Analyzer signals as facts",
  ]) {
    assert.match(source, new RegExp(snippet));
  }
  assert.doesNotMatch(source, /percentage-human|humanness score|certificate of humanity/i);
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

test("content-blind replay points track document length and markers", async () => {
  const record = await recordFixture();
  const points = buildReplayPoints(record.events);
  assert.deepEqual(points.map((point) => point.documentLength), [2, 8, 7, 8]);
  assert.equal(points[1].source, "paste");
  assert.equal(points[1].ins_len, 6);
  assert.equal(points.some((point) => point.isLargeInsert), false);
});
