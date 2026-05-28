import type { EventLog, RecordManifest, Signal, SignalMeasure } from "../../format/src/index.ts";

export const ANALYZERS_PACKAGE = "@possiblymadebyahuman/analyzers";
export const TIMING_DISTRIBUTION_ANALYZER_ID = "timing-distribution";
export const EDIT_TOPOLOGY_ANALYZER_ID = "edit-topology";
export const ANALYZER_VERSION = "0.1.0";
export const DEFAULT_IDLE_THRESHOLD_MS = 30_000;
export const DEFAULT_LARGE_ATOMIC_INSERT_CODEPOINTS = 50;
export const DEFAULT_SMALL_EDIT_CODEPOINTS = 5;

export type AnalyzerInput = {
  events: EventLog;
  manifest: RecordManifest;
};

export type Analyzer = {
  id: string;
  version: string;
  analyze(input: AnalyzerInput): Signal;
};

export type DefaultAnalyzerOptions = {
  idleThresholdMs?: number;
};

export class AnalyzerRegistry {
  readonly #analyzers = new Map<string, Analyzer>();

  register(analyzer: Analyzer): void {
    if (this.#analyzers.has(analyzer.id)) throw new Error(`analyzer already registered: ${analyzer.id}`);
    this.#analyzers.set(analyzer.id, analyzer);
  }

  list(): Analyzer[] {
    return [...this.#analyzers.values()];
  }

  run(input: AnalyzerInput): Signal[] {
    return runAnalyzers(input, this.list());
  }
}

export function createDefaultAnalyzerRegistry(options: DefaultAnalyzerOptions = {}): AnalyzerRegistry {
  const registry = new AnalyzerRegistry();
  registry.register(timingDistributionAnalyzer({ idleThresholdMs: options.idleThresholdMs }));
  registry.register(editTopologyAnalyzer());
  return registry;
}

export function runAnalyzers(input: AnalyzerInput, analyzers: Analyzer[]): Signal[] {
  return analyzers.map((analyzer) => runAnalyzerSafely(input, analyzer));
}

export function runDefaultAnalyzers(input: AnalyzerInput, options: DefaultAnalyzerOptions = {}): Signal[] {
  return createDefaultAnalyzerRegistry(options).run(input);
}

export function runAnalyzerSafely(input: AnalyzerInput, analyzer: Analyzer): Signal {
  try {
    return analyzer.analyze(deepFreeze(cloneAnalyzerInput(input)));
  } catch (error) {
    return analyzerErrorSignal(analyzer, error);
  }
}

export function analyzerErrorSignal(analyzer: Pick<Analyzer, "id" | "version">, error: unknown): Signal {
  const errorName = error instanceof Error ? error.name : typeof error;
  return {
    analyzer_id: analyzer.id,
    analyzer_version: analyzer.version,
    applicable: false,
    measures: [measure("analyzer_error", true), measure("error_type", errorName)],
    explanation: `Analyzer ${analyzer.id} failed while measuring this record, so this signal is unavailable. Other analyzer facts and the stored writing record are unaffected.`,
  };
}

export function timingDistributionAnalyzer(options: { idleThresholdMs?: number } = {}): Analyzer {
  const idleThresholdMs = options.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
  return {
    id: TIMING_DISTRIBUTION_ANALYZER_ID,
    version: ANALYZER_VERSION,
    analyze({ events, manifest }) {
      if (!manifest.producer.capabilities.includes("timing")) {
        return notApplicable(
          TIMING_DISTRIBUTION_ANALYZER_ID,
          "Producer did not declare timing capability, so timing-distribution is not applicable.",
        );
      }
      if (events.length < 2) {
        return notApplicable(
          TIMING_DISTRIBUTION_ANALYZER_ID,
          "Timing distribution needs at least two events to measure inter-event intervals.",
        );
      }

      const delays = interEventDelays(events);
      const sorted = [...delays].sort((left, right) => left - right);
      const idleDelays = delays.filter((delay) => delay >= idleThresholdMs);
      const idleTimeMs = sum(idleDelays);
      const activeTimeMs = Math.max(0, manifest.duration_ms - idleTimeMs);
      const max = sorted.at(-1) ?? 0;
      const measures: SignalMeasure[] = [
        measure("event_count", events.length),
        measure("interval_count", delays.length),
        measure("inter_event_delay_min_ms", sorted[0] ?? 0, "ms"),
        measure("inter_event_delay_p50_ms", percentile(sorted, 0.5), "ms"),
        measure("inter_event_delay_p90_ms", percentile(sorted, 0.9), "ms"),
        measure("inter_event_delay_p95_ms", percentile(sorted, 0.95), "ms"),
        measure("inter_event_delay_max_ms", max, "ms"),
        measure("active_time_ms", activeTimeMs, "ms"),
        measure("idle_time_ms", idleTimeMs, "ms"),
        measure("long_pause_count", idleDelays.length),
      ];

      return {
        analyzer_id: TIMING_DISTRIBUTION_ANALYZER_ID,
        analyzer_version: ANALYZER_VERSION,
        applicable: true,
        measures,
        explanation: `Measured ${delays.length} inter-event intervals. Long pauses are intervals at or above ${idleThresholdMs}ms; the longest interval was ${max}ms, with ${idleDelays.length} long pause(s).`,
      };
    },
  };
}

export function editTopologyAnalyzer(
  options: { largeAtomicInsertCodepoints?: number; smallEditCodepoints?: number } = {},
): Analyzer {
  const largeThreshold = options.largeAtomicInsertCodepoints ?? DEFAULT_LARGE_ATOMIC_INSERT_CODEPOINTS;
  const smallThreshold = options.smallEditCodepoints ?? DEFAULT_SMALL_EDIT_CODEPOINTS;
  return {
    id: EDIT_TOPOLOGY_ANALYZER_ID,
    version: ANALYZER_VERSION,
    analyze({ events, manifest }) {
      if (events.length === 0) {
        return notApplicable(EDIT_TOPOLOGY_ANALYZER_ID, "Edit topology needs at least one event.");
      }

      const sourceAttribution = manifest.producer.capabilities.includes("source_attribution");
      const sizeKnownEvents = events.filter(hasKnownSizes);
      const unknownProcessMeasurementCount = events.filter(
        (event) => event.pos === null || event.del_len === null || event.ins_len === null,
      ).length;
      const smallEditCount = sizeKnownEvents.filter((event) => event.ins_len + event.del_len <= smallThreshold).length;
      const largeAtomicInserts = sizeKnownEvents.filter((event) => event.ins_len >= largeThreshold);
      const deletionEvents = sizeKnownEvents.filter((event) => event.del_len > 0);
      const insertedCodepoints = sum(sizeKnownEvents.map((event) => event.ins_len));
      const deletedCodepoints = sum(sizeKnownEvents.map((event) => event.del_len));
      const largestAtomicInsert = Math.max(0, ...sizeKnownEvents.map((event) => event.ins_len));
      const replaceCount = events.filter((event) => event.op === "replace").length;
      const interleaveRatio = sizeKnownEvents.length === 0 ? 0 : round(smallEditCount / sizeKnownEvents.length, 4);
      const deletedCodepointRatio = insertedCodepoints === 0 ? 0 : round(deletedCodepoints / insertedCodepoints, 4);
      const deletionClusters = countDeletionClusters(events);

      const measures: SignalMeasure[] = [
        measure("event_count", events.length),
        measure("small_edit_count", smallEditCount),
        measure("small_edit_ratio", interleaveRatio),
        measure("unknown_process_measurement_count", unknownProcessMeasurementCount),
        measure("large_atomic_insert_count", largeAtomicInserts.length),
        measure("atomic_insert_max_len", largestAtomicInsert, "codepoints"),
        measure("deletion_count", deletionEvents.length),
        measure("deletion_cluster_count", deletionClusters),
        measure("replacement_count", replaceCount),
        measure("inserted_codepoints_total", insertedCodepoints, "codepoints"),
        measure("deleted_codepoints_total", deletedCodepoints, "codepoints"),
        measure("revision_deleted_codepoint_ratio", deletedCodepointRatio),
      ];

      const sourceExplanation = sourceAttribution
        ? ` Source attribution is present: ${sourceSummary(events)}.`
        : " Source attribution was not declared, so this signal only uses known event sizes, positions, and operations.";

      return {
        analyzer_id: EDIT_TOPOLOGY_ANALYZER_ID,
        analyzer_version: ANALYZER_VERSION,
        applicable: true,
        measures,
        explanation: `Measured edit topology over ${events.length} mutation event(s), using ${sizeKnownEvents.length} event(s) with known sizes and marking ${unknownProcessMeasurementCount} event(s) with unknown process measurements: ${smallEditCount} small edit(s), ${largeAtomicInserts.length} large atomic insert(s), largest insert ${largestAtomicInsert} codepoint(s), and ${deletionEvents.length} deletion event(s) across ${deletionClusters} deletion cluster(s). deletion_count counts every mutation that removes codepoints, including replacement events; events with unknown measurements are counted in unknown_process_measurement_count. replacement_count separately counts op=replace events. Deleted codepoints are reported as a revision/dead-end indicator, not a verdict.${sourceExplanation}`,
      };
    },
  };
}

function hasKnownSizes(event: EventLog[number]): event is EventLog[number] & { del_len: number; ins_len: number } {
  return event.del_len !== null && event.ins_len !== null;
}

function cloneAnalyzerInput(input: AnalyzerInput): AnalyzerInput {
  return JSON.parse(JSON.stringify(input)) as AnalyzerInput;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return value;
}

function notApplicable(analyzerId: string, explanation: string): Signal {
  return {
    analyzer_id: analyzerId,
    analyzer_version: ANALYZER_VERSION,
    applicable: false,
    measures: [],
    explanation,
  };
}

function measure(key: string, value: string | number | boolean, unit?: string): SignalMeasure {
  return unit ? { key, value, unit } : { key, value };
}

function interEventDelays(events: EventLog): number[] {
  return events.slice(1).map((event, index) => event.t - (events[index]?.t ?? 0));
}

function percentile(sortedNumbers: number[], percentileValue: number): number {
  if (sortedNumbers.length === 0) return 0;
  const index = Math.min(sortedNumbers.length - 1, Math.ceil(sortedNumbers.length * percentileValue) - 1);
  return sortedNumbers[index] ?? 0;
}

function countDeletionClusters(events: EventLog): number {
  let clusters = 0;
  let previousWasDeletion = false;
  for (const event of events) {
    const isDeletion = (event.del_len ?? 0) > 0;
    if (isDeletion && !previousWasDeletion) clusters += 1;
    previousWasDeletion = isDeletion;
  }
  return clusters;
}

function sourceSummary(events: EventLog): string {
  const counts = new Map<string, number>();
  for (const event of events) counts.set(event.source, (counts.get(event.source) ?? 0) + 1);
  return [...counts.entries()].map(([source, count]) => `${source}=${count}`).join(", ");
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
