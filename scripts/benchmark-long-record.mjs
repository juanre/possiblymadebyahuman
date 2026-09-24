// Deterministic plaintext-free full-scale hashing, analysis and reader benchmark.
// Run explicitly: node --expose-gc scripts/benchmark-long-record.mjs [event-count]
import { performance } from "node:perf_hooks";
import {
  advanceEventHash,
  sealRecordHash,
} from "../packages/format/src/index.ts";
import {
  createAnalysisAccumulator,
  appendAnalysisEvent,
} from "../packages/analyzers/src/streaming.ts";
import {
  verifyPagedRecord,
  EVENT_PAGE_SIZE,
} from "../apps/web/src/stream-record.ts";
const count = Number(process.argv[2] ?? 4_000_000);
if (!Number.isSafeInteger(count) || count < 1)
  throw new Error("positive event count required");
const session = "123e4567-e89b-42d3-a456-426614174002";
const duration = 2 * 365 * 24 * 60 * 60 * 1000;
const event = (i) => ({
  seq: i,
  t: Math.floor((duration * i) / count),
  op: "insert",
  pos: i,
  del_len: 0,
  ins_len: 1,
  source: "typing",
});
const state = createAnalysisAccumulator();
let tip = null;
const start = performance.now();
for (let i = 0; i < count; i++) {
  const e = event(i);
  tip = advanceEventHash(tip, e, session, "0.3");
  appendAnalysisEvent(state, e);
}
const hashTime = performance.now() - start;
const manifest = {
  format_version: "0.3",
  session_id: session,
  producer: { id: "benchmark", version: "1", capabilities: ["timing"] },
  event_count: count,
  duration_ms: duration,
  attestations: [],
  record_hash: sealRecordHash(tip, "0.3", undefined, { duration_ms: duration }),
};
globalThis.gc?.();
const baseline = process.memoryUsage().heapUsed;
let peak = baseline,
  previousTip = null,
  pages = 0;
const verifyStart = performance.now();
const result = await verifyPagedRecord(manifest, async (offset, limit) => {
  const events = [];
  const before = previousTip;
  for (let i = offset; i < Math.min(count, offset + limit); i++) {
    const e = event(i);
    events.push(e);
    previousTip = advanceEventHash(previousTip, e, session, "0.3");
  }
  pages++;
  peak = Math.max(peak, process.memoryUsage().heapUsed);
  return {
    events,
    total_events: count,
    next_offset:
      offset + events.length === count ? null : offset + events.length,
    chain_tip_before: before,
    chain_tip_after: previousTip,
  };
});
if (!result.verification.valid)
  throw new Error(result.verification.errors.join("; "));
if (result.overview.bins.reduce((n, b) => n + b.count, 0) !== count)
  throw new Error("overview dropped events");
console.log(
  JSON.stringify(
    {
      events: count,
      simulated_years: 2,
      hash_and_analysis_ms: Math.round(hashTime),
      paged_verification_with_fixture_hashing_ms: Math.round(
        performance.now() - verifyStart,
      ),
      page_count: pages,
      max_page_events: EVENT_PAGE_SIZE,
      analysis_state_bytes: Buffer.byteLength(JSON.stringify(state)),
      overview_bins: result.overview.bins.length,
      peak_heap_growth_bytes: peak - baseline,
      record_hash: manifest.record_hash,
    },
    null,
    2,
  ),
);
