import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  EDIT_TOPOLOGY_ANALYZER_ID,
  TIMING_DISTRIBUTION_ANALYZER_ID,
  createDefaultAnalyzerRegistry,
  editTopologyAnalyzer,
  runDefaultAnalyzers,
  timingDistributionAnalyzer,
} from "../packages/analyzers/src/index.ts";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
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
