import { aggregateMutationSizes, type EventLog, type RecordManifest, type Signal, type SignalMeasure } from "../../format/src/index.ts";

export const ANALYZERS_PACKAGE = "@possiblymadebyahuman/analyzers";
export * from "./constants.ts";
import { DEFAULT_IDLE_THRESHOLD_MS, DEFAULT_LARGE_ATOMIC_INSERT_CODEPOINTS, DEFAULT_SMALL_EDIT_CODEPOINTS, EDIT_TOPOLOGY_ANALYZER_ID, EDIT_TOPOLOGY_ANALYZER_VERSION, TIMING_ANALYZER_VERSION, TIMING_DISTRIBUTION_ANALYZER_ID } from "./constants.ts";
import { analyzeEventLog } from "./streaming.ts";

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
    version: TIMING_ANALYZER_VERSION,
    analyze({ events, manifest }) {
      return analyzeEventLog(events, manifest, { idleThresholdMs }).signals[0]!;
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
    version: EDIT_TOPOLOGY_ANALYZER_VERSION,
    analyze({ events, manifest }) {
      if (events.length === 0) return notApplicable(EDIT_TOPOLOGY_ANALYZER_ID, "Edit topology needs at least one event.");
      return analyzeEventLog(events, manifest, {
        largeAtomicInsertCodepoints: largeThreshold, smallEditCodepoints: smallThreshold,
      }).signals[1]!;
    },
  };
}

/** Correct derived legacy facts without guessing the original custom thresholds. */
export function upgradeLegacyEditTopologySignal(signal: Signal, events: EventLog): Signal {
  if (signal.analyzer_id !== EDIT_TOPOLOGY_ANALYZER_ID || signal.analyzer_version !== "0.1.0" || !signal.applicable) return signal;
  const sizes = aggregateMutationSizes(events);
  const unknownSizes = events.some(event => !hasKnownSizes(event));
  const corrections: Record<string, number | null> = {
    inserted_codepoints_total: sizes.inserted_codepoints_total,
    deleted_codepoints_total: sizes.deleted_codepoints_total,
    atomic_insert_max_len: sizes.largest_atomic_insert_codepoints,
    revision_deleted_codepoint_ratio: revisionRatio(sizes.inserted_codepoints_total, sizes.deleted_codepoints_total),
    deletion_count: sizes.deleted_codepoints_total === null ? null : events.filter(event => event.del_len! > 0).length,
    deletion_cluster_count: sizes.deleted_codepoints_total === null ? null : countDeletionClusters(events),
    ...(unknownSizes ? { small_edit_count: null, small_edit_ratio: null, large_atomic_insert_count: null } : {}),
  };
  return {
    ...signal,
    analyzer_version: EDIT_TOPOLOGY_ANALYZER_VERSION,
    measures: signal.measures.map(item => Object.hasOwn(corrections, item.key) ? { ...item, value: corrections[item.key] ?? null } : item),
    explanation: "Legacy edit-topology facts corrected from the recorded measurements. Totals and maxima are unavailable when a required size is unknown. Original size-threshold measures are preserved for fully measured logs; they are unavailable for partially measured logs because the original custom thresholds were not stored. This derived view does not change the stored writing record.",
  };
}

function revisionRatio(inserted: number | null, deleted: number | null): number | null {
  return inserted === null || deleted === null || inserted === 0 ? null : round(deleted / inserted, 4);
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
    analyzer_version: analyzerId === TIMING_DISTRIBUTION_ANALYZER_ID ? TIMING_ANALYZER_VERSION : EDIT_TOPOLOGY_ANALYZER_VERSION,
    applicable: false,
    measures: [],
    explanation,
  };
}

function measure(key: string, value: SignalMeasure["value"], unit?: string): SignalMeasure {
  return unit ? { key, value, unit } : { key, value };
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

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
