import {
  SOURCES,
  type BufferMutation,
  type RecordManifest,
  type Signal,
  type SignalMeasure,
  type Source,
} from "../../format/src/index.ts";
import type { RecordStats } from "../../storage/src/index.ts";
import {
  DEFAULT_IDLE_THRESHOLD_MS,
  DEFAULT_LARGE_ATOMIC_INSERT_CODEPOINTS,
  DEFAULT_SMALL_EDIT_CODEPOINTS,
  EDIT_TOPOLOGY_ANALYZER_ID,
  EDIT_TOPOLOGY_ANALYZER_VERSION,
  TIMING_ANALYZER_VERSION,
  TIMING_DISTRIBUTION_ANALYZER_ID,
} from "./constants.ts";

/** Fixed-size, JSON-serializable state. Exact quantiles are computed separately
 * from disk-backed delay counts, never from an in-memory array of all delays. */
export type AnalysisAccumulator = {
  version: 1;
  small_threshold: number;
  large_threshold: number;
  count: number;
  first_t: number | null;
  last_t: number | null;
  idle_threshold_ms: number;
  observed_length: number | null;
  inserted: number | null;
  deleted: number | null;
  largest: number | null;
  inserts: number;
  deletes: number;
  replaces: number;
  sources: Record<Source, number>;
  source_order: Source[];
  known_sizes: number;
  unknown_measurements: number;
  small: number;
  large: number;
  deletion_events: number;
  deletion_clusters: number;
  previous_deletion: boolean;
  min_delay: number | null;
  max_delay: number | null;
  active: number;
  idle: number;
  long_pauses: number;
  histogram: number[];
};
export type ExactDelayPercentiles = {
  p50: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
};
const HISTOGRAM = [
  ["0-999ms", 999],
  ["1s-4.999s", 4999],
  ["5s-29.999s", 29999],
  ["30s-299.999s", 299999],
  ["5m+", Infinity],
] as const;
export type AnalysisOptions = {
  idleThresholdMs?: number;
  smallEditCodepoints?: number;
  largeAtomicInsertCodepoints?: number;
};
export function createAnalysisAccumulator(
  idleThresholdMs = DEFAULT_IDLE_THRESHOLD_MS,
  options: AnalysisOptions = {},
): AnalysisAccumulator {
  if (!Number.isSafeInteger(idleThresholdMs) || idleThresholdMs < 0)
    throw new TypeError("invalid idle threshold");
  return {
    version: 1,
    small_threshold:
      options.smallEditCodepoints ?? DEFAULT_SMALL_EDIT_CODEPOINTS,
    large_threshold:
      options.largeAtomicInsertCodepoints ??
      DEFAULT_LARGE_ATOMIC_INSERT_CODEPOINTS,
    count: 0,
    first_t: null,
    last_t: null,
    idle_threshold_ms: idleThresholdMs,
    observed_length: 0,
    inserted: 0,
    deleted: 0,
    largest: 0,
    inserts: 0,
    deletes: 0,
    replaces: 0,
    sources: Object.fromEntries(SOURCES.map((source) => [source, 0])) as Record<
      Source,
      number
    >,
    source_order: [],
    known_sizes: 0,
    unknown_measurements: 0,
    small: 0,
    large: 0,
    deletion_events: 0,
    deletion_clusters: 0,
    previous_deletion: false,
    min_delay: null,
    max_delay: null,
    active: 0,
    idle: 0,
    long_pauses: 0,
    histogram: [0, 0, 0, 0, 0],
  };
}
/** Input must already have passed event and cross-chunk sequence validation. */
export function appendAnalysisEvent(
  s: AnalysisAccumulator,
  e: BufferMutation,
): void {
  if (s.version !== 1)
    throw new TypeError("Unsupported analysis accumulator version");
  if (e.seq !== s.count || (s.last_t !== null && e.t < s.last_t))
    throw new TypeError("analysis events must be contiguous and chronological");
  if (s.last_t !== null) {
    const delay = e.t - s.last_t;
    s.min_delay = Math.min(s.min_delay ?? delay, delay);
    s.max_delay = Math.max(s.max_delay ?? delay, delay);
    if (delay >= s.idle_threshold_ms) {
      s.idle += delay;
      s.long_pauses++;
    } else s.active += delay;
    s.histogram[HISTOGRAM.findIndex(([, max]) => delay <= max)]!++;
  }
  s.first_t ??= e.t;
  s.last_t = e.t;
  s.count++;
  if (s.sources[e.source]++ === 0) s.source_order.push(e.source);
  if (e.op === "insert") s.inserts++;
  else if (e.op === "delete") s.deletes++;
  else s.replaces++;
  s.inserted =
    s.inserted === null || e.ins_len === null ? null : s.inserted + e.ins_len;
  s.deleted =
    s.deleted === null || e.del_len === null ? null : s.deleted + e.del_len;
  s.largest =
    s.largest === null || e.ins_len === null
      ? null
      : Math.max(s.largest, e.ins_len);
  if (e.ins_len !== null && e.del_len !== null) {
    s.known_sizes++;
    if (e.ins_len + e.del_len <= s.small_threshold) s.small++;
  }
  if (e.pos === null || e.ins_len === null || e.del_len === null)
    s.unknown_measurements++;
  if (e.ins_len !== null && e.ins_len >= s.large_threshold) s.large++;
  const deletion = e.del_len !== null && e.del_len > 0;
  if (deletion) {
    s.deletion_events++;
    if (!s.previous_deletion) s.deletion_clusters++;
  }
  s.previous_deletion = deletion;
  s.observed_length =
    s.observed_length === null ||
    e.pos === null ||
    e.del_len === null ||
    e.ins_len === null ||
    e.pos + e.del_len > s.observed_length
      ? null
      : s.observed_length - e.del_len + e.ins_len;
}
const measure = (
  key: string,
  value: SignalMeasure["value"],
  unit?: string,
): SignalMeasure => (unit ? { key, value, unit } : { key, value });
const round = (n: number) => Math.round(n * 10000) / 10000;
export function finalizeAnalysis(
  s: AnalysisAccumulator,
  manifest: RecordManifest,
  percentiles: ExactDelayPercentiles,
): { stats: RecordStats; signals: Signal[] } {
  if (s.version !== 1)
    throw new TypeError("Unsupported analysis accumulator version");
  if (s.count !== manifest.event_count)
    throw new TypeError("analysis does not cover manifest");
  const stats: RecordStats = {
    record_hash: manifest.record_hash,
    event_count: s.count,
    duration_ms: manifest.duration_ms,
    observed_final_length: s.observed_length,
    insert_op_count: s.inserts,
    delete_op_count: s.deletes,
    replace_op_count: s.replaces,
    typed_event_count: s.sources.typing,
    paste_event_count: s.sources.paste,
    cut_event_count: s.sources.cut,
    drop_event_count: s.sources.drop,
    ime_event_count: s.sources.ime,
    autocomplete_event_count: s.sources.autocomplete,
    programmatic_event_count: s.sources.programmatic,
    unknown_source_count: s.sources.unknown,
    inserted_codepoints_total: s.inserted,
    deleted_codepoints_total: s.deleted,
    largest_atomic_insert_codepoints: s.largest,
    inter_event_delay_min_ms: s.min_delay,
    inter_event_delay_max_ms: s.max_delay,
    inter_event_delay_p50_ms: percentiles.p50,
    inter_event_delay_p90_ms: percentiles.p90,
    inter_event_delay_p95_ms: percentiles.p95,
    inter_event_delay_p99_ms: percentiles.p99,
    active_time_ms: s.active,
    idle_time_ms: s.idle,
    long_pause_count: s.long_pauses,
    delay_histogram: HISTOGRAM.map(([bucket], i) => ({
      bucket,
      count: s.histogram[i]!,
    })),
  };
  const timingApplicable =
    manifest.producer.capabilities.includes("timing") && s.count >= 2;
  const timing: Signal = {
    analyzer_id: TIMING_DISTRIBUTION_ANALYZER_ID,
    analyzer_version: TIMING_ANALYZER_VERSION,
    applicable: timingApplicable,
    measures: timingApplicable
      ? [
          measure("event_count", s.count),
          measure("interval_count", s.count - 1),
          measure("inter_event_delay_min_ms", s.min_delay, "ms"),
          measure("inter_event_delay_p50_ms", percentiles.p50, "ms"),
          measure("inter_event_delay_p90_ms", percentiles.p90, "ms"),
          measure("inter_event_delay_p95_ms", percentiles.p95, "ms"),
          measure("inter_event_delay_max_ms", s.max_delay, "ms"),
          measure("active_time_ms", s.active, "ms"),
          measure("idle_time_ms", s.idle, "ms"),
          measure("long_pause_count", s.long_pauses),
        ]
      : [],
    explanation: timingApplicable
      ? `Measured ${s.count - 1} inter-event intervals. Long pauses are intervals at or above ${s.idle_threshold_ms}ms; the longest interval was ${s.max_delay}ms, with ${s.long_pauses} long pause(s).`
      : !manifest.producer.capabilities.includes("timing")
        ? "Producer did not declare timing capability, so timing-distribution is not applicable."
        : "Timing distribution needs at least two events to measure inter-event intervals.",
  };
  const small = s.known_sizes === s.count ? s.small : null;
  const sourceExplanation = manifest.producer.capabilities.includes(
    "source_attribution",
  )
    ? ` Source attribution is present: ${s.source_order.map((source) => `${source}=${s.sources[source]}`).join(", ")}.`
    : " Source attribution was not declared, so this signal only uses known event sizes, positions, and operations.";
  const edit: Signal = {
    analyzer_id: EDIT_TOPOLOGY_ANALYZER_ID,
    analyzer_version: EDIT_TOPOLOGY_ANALYZER_VERSION,
    applicable: true,
    measures: [
      measure("event_count", s.count),
      measure("small_edit_count", small),
      measure(
        "small_edit_ratio",
        small === null ? null : round(small / s.count),
      ),
      measure("unknown_process_measurement_count", s.unknown_measurements),
      measure(
        "small_edit_threshold_codepoints",
        s.small_threshold,
        "codepoints",
      ),
      measure(
        "large_atomic_insert_threshold_codepoints",
        s.large_threshold,
        "codepoints",
      ),
      measure(
        "large_atomic_insert_count",
        s.inserted === null ? null : s.large,
      ),
      measure("atomic_insert_max_len", s.largest, "codepoints"),
      measure("deletion_count", s.deleted === null ? null : s.deletion_events),
      measure(
        "deletion_cluster_count",
        s.deleted === null ? null : s.deletion_clusters,
      ),
      measure("replacement_count", s.replaces),
      measure("inserted_codepoints_total", s.inserted, "codepoints"),
      measure("deleted_codepoints_total", s.deleted, "codepoints"),
      measure(
        "revision_deleted_codepoint_ratio",
        s.inserted === null || s.deleted === null || s.inserted === 0
          ? null
          : round(s.deleted / s.inserted),
      ),
    ],
    explanation: `Measured edit topology over ${s.count} mutation event(s), with ${s.known_sizes} event(s) with known sizes and ${s.unknown_measurements} event(s) with unknown process measurements. A measure is unavailable when a missing size prevents its calculation; unknown positions alone do not hide known sizes. Small edits contain at most ${s.small_threshold} inserted and deleted codepoints combined; large atomic inserts contain at least ${s.large_threshold} codepoints. deletion_count counts every mutation that removes codepoints, including replacement events. replacement_count separately counts op=replace events. Deleted codepoints are reported as a revision/dead-end indicator, not a verdict.${sourceExplanation}`,
  };
  return { stats, signals: [timing, edit] };
}

/** Compatibility for explicit, bounded array callers. Production chunk ingest
 * uses appendAnalysisEvent and supplies exact disk-backed percentiles instead. */
export function analyzeEventLog(
  events: BufferMutation[],
  manifest: RecordManifest,
  options: AnalysisOptions = {},
): { stats: RecordStats; signals: Signal[] } {
  const state = createAnalysisAccumulator(options.idleThresholdMs, options);
  const delays: number[] = [];
  for (const event of events) {
    if (state.last_t !== null) delays.push(event.t - state.last_t);
    appendAnalysisEvent(state, event);
  }
  delays.sort((a, b) => a - b);
  const percentile = (p: number) =>
    delays.length ? delays[Math.ceil(delays.length * p) - 1]! : null;
  return finalizeAnalysis(
    state,
    { ...manifest, event_count: events.length },
    {
      p50: percentile(0.5),
      p90: percentile(0.9),
      p95: percentile(0.95),
      p99: percentile(0.99),
    },
  );
}
