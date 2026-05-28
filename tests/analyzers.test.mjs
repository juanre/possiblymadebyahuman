import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  EDIT_TOPOLOGY_ANALYZER_ID,
  TIMING_DISTRIBUTION_ANALYZER_ID,
  createDefaultAnalyzerRegistry,
  editTopologyAnalyzer,
  runAnalyzers,
  runDefaultAnalyzers,
  timingDistributionAnalyzer,
} from "../packages/analyzers/src/index.ts";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const clone = (value) => JSON.parse(JSON.stringify(value));
const measure = (signal, key) => signal.measures.find((item) => item.key === key)?.value;

async function goldenRecord() {
  const [golden] = await readJson("packages/conformance/vectors/golden-records.json");
  return golden.record;
}

test("default analyzer registry runs timing and topology analyzers", async () => {
  const record = await goldenRecord();
  const signals = createDefaultAnalyzerRegistry().run({ events: record.events, manifest: record.manifest });
  assert.deepEqual(signals.map((signal) => signal.analyzer_id), [
    TIMING_DISTRIBUTION_ANALYZER_ID,
    EDIT_TOPOLOGY_ANALYZER_ID,
  ]);
  assert.equal(signals.every((signal) => typeof signal.explanation === "string"), true);
});

test("timing-distribution reports interval and pause facts for golden record", async () => {
  const record = await goldenRecord();
  const signal = timingDistributionAnalyzer().analyze({ events: record.events, manifest: record.manifest });

  assert.equal(signal.applicable, true);
  assert.equal(signal.analyzer_id, TIMING_DISTRIBUTION_ANALYZER_ID);
  assert.equal(measure(signal, "interval_count"), 3);
  assert.equal(measure(signal, "inter_event_delay_min_ms"), 60);
  assert.equal(measure(signal, "inter_event_delay_p50_ms"), 60);
  assert.equal(measure(signal, "inter_event_delay_max_ms"), 120);
  assert.equal(measure(signal, "long_pause_count"), 0);
  assert.match(signal.explanation, /Measured 3 inter-event intervals/);
  assert.doesNotMatch(signal.explanation, /AI|human verdict|score/i);
});

test("timing-distribution is not applicable without timing capability", async () => {
  const record = await goldenRecord();
  const manifest = {
    ...record.manifest,
    producer: { ...record.manifest.producer, capabilities: ["source_attribution"] },
  };
  const signal = timingDistributionAnalyzer().analyze({ events: record.events, manifest });

  assert.equal(signal.applicable, false);
  assert.deepEqual(signal.measures, []);
  assert.match(signal.explanation, /did not declare timing capability/);
});

test("edit-topology reports small edits, atomic inserts, deletion clusters, and source context", async () => {
  const record = await goldenRecord();
  const signal = editTopologyAnalyzer({ largeAtomicInsertCodepoints: 5 }).analyze({
    events: record.events,
    manifest: record.manifest,
  });

  assert.equal(signal.applicable, true);
  assert.equal(signal.analyzer_id, EDIT_TOPOLOGY_ANALYZER_ID);
  assert.equal(measure(signal, "event_count"), 4);
  assert.equal(measure(signal, "small_edit_count"), 3);
  assert.equal(measure(signal, "large_atomic_insert_count"), 1);
  assert.equal(measure(signal, "atomic_insert_max_len"), 6);
  assert.equal(measure(signal, "deletion_count"), 1);
  assert.equal(measure(signal, "deletion_cluster_count"), 1);
  assert.equal(measure(signal, "inserted_codepoints_total"), 9);
  assert.equal(measure(signal, "deleted_codepoints_total"), 1);
  assert.match(signal.explanation, /Source attribution is present/);
  assert.match(signal.explanation, /paste=1/);
  assert.doesNotMatch(signal.explanation, /likely|suspicious|AI-generated/i);
});

test("edit-topology works without source attribution and explains the degraded context", async () => {
  const record = await goldenRecord();
  const manifest = {
    ...record.manifest,
    producer: { ...record.manifest.producer, capabilities: [] },
  };
  const signal = editTopologyAnalyzer().analyze({ events: record.events, manifest });

  assert.equal(signal.applicable, true);
  assert.match(signal.explanation, /Source attribution was not declared/);
});

test("edit-topology is not applicable for an empty log", async () => {
  const record = await goldenRecord();
  const signal = editTopologyAnalyzer().analyze({ events: [], manifest: record.manifest });
  assert.equal(signal.applicable, false);
});

test("edit-topology documents deletion_count and replacement_count semantics", async () => {
  const record = await goldenRecord();
  const events = [
    { seq: 0, t: 0, op: "insert", pos: 0, del_len: 0, ins_len: 4, source: "typing" },
    { seq: 1, t: 10, op: "replace", pos: 1, del_len: 2, ins_len: 1, source: "typing" },
    { seq: 2, t: 20, op: "delete", pos: 1, del_len: 1, ins_len: 0, source: "cut" },
  ];
  const manifest = { ...record.manifest, event_count: events.length, duration_ms: 20 };
  const signal = editTopologyAnalyzer().analyze({ events, manifest });

  assert.equal(measure(signal, "deletion_count"), 2);
  assert.equal(measure(signal, "replacement_count"), 1);
  assert.match(signal.explanation, /deletion_count counts every mutation that removes codepoints, including replacement events/);
});

test("runAnalyzers isolates thrown analyzer failures and keeps later analyzers running", async () => {
  const record = await goldenRecord();
  const signals = runAnalyzers({ events: record.events, manifest: record.manifest }, [
    {
      id: "buggy-analyzer",
      version: "0.0.0",
      analyze() {
        throw new TypeError("boom");
      },
    },
    timingDistributionAnalyzer(),
  ]);

  assert.equal(signals.length, 2);
  assert.equal(signals[0].analyzer_id, "buggy-analyzer");
  assert.equal(signals[0].applicable, false);
  assert.equal(measure(signals[0], "analyzer_error"), true);
  assert.equal(measure(signals[0], "error_type"), "TypeError");
  assert.match(signals[0].explanation, /signal is unavailable/);
  assert.doesNotMatch(signals[0].explanation, /likely|suspicious|AI-generated|score|verdict/i);
  assert.equal(signals[1].analyzer_id, TIMING_DISTRIBUTION_ANALYZER_ID);
  assert.equal(signals[1].applicable, true);
});

test("runAnalyzers gives each analyzer immutable isolated input", async () => {
  const record = await goldenRecord();
  const originalEvents = clone(record.events);
  const originalManifest = clone(record.manifest);
  const signals = runAnalyzers({ events: record.events, manifest: record.manifest }, [
    {
      id: "mutating-analyzer",
      version: "0.0.0",
      analyze(input) {
        input.events[0].ins_len = 999;
        return { analyzer_id: "mutating-analyzer", analyzer_version: "0.0.0", applicable: true, measures: [], explanation: "mutated" };
      },
    },
    {
      id: "observer-analyzer",
      version: "0.0.0",
      analyze(input) {
        return {
          analyzer_id: "observer-analyzer",
          analyzer_version: "0.0.0",
          applicable: true,
          measures: [{ key: "first_insert_len", value: input.events[0].ins_len }],
          explanation: "Observed input after earlier analyzer failure.",
        };
      },
    },
  ]);

  assert.equal(signals[0].applicable, false);
  assert.equal(measure(signals[0], "analyzer_error"), true);
  assert.equal(signals[1].applicable, true);
  assert.equal(measure(signals[1], "first_insert_len"), originalEvents[0].ins_len);
  assert.deepEqual(record.events, originalEvents);
  assert.deepEqual(record.manifest, originalManifest);
});

test("runDefaultAnalyzers returns descriptive signals only", async () => {
  const record = await goldenRecord();
  const signals = runDefaultAnalyzers({ events: record.events, manifest: record.manifest });
  assert.equal(signals.length, 2);
  for (const signal of signals) {
    assert.equal("score" in signal, false);
    assert.equal("verdict" in signal, false);
    assert.match(signal.explanation, /./);
  }
});
