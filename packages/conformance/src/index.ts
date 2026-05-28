import {
  canonicalizeEvent,
  computeEventHashChain,
  computeObservedLength,
  computeRecordHash,
  verifyRecord,
  type BufferMutation,
  type Capability,
  type WritingRecord,
} from "../../format/src/index.ts";

export const CONFORMANCE_PACKAGE = "@possiblymadebyahuman/conformance";

export type CanonicalizationVector = {
  name: string;
  event: BufferMutation;
  canonical: string;
};

export type HashChainVector = {
  name: string;
  session_id: string;
  format_version: "0.1";
  events: BufferMutation[];
  chain: string[];
  record_hash: string;
};

export type ProcessLengthVector = {
  name: string;
  events: BufferMutation[];
  observed_final_length: number | null;
};

export type GoldenRecordVector = {
  name: string;
  record: WritingRecord;
};

export type CapabilityAccuracyVector = {
  name: string;
  capabilities: Capability[];
  events: BufferMutation[];
  valid: boolean;
  note: string;
};

export type ConformanceVectors = {
  canonicalization?: CanonicalizationVector[];
  hashChains?: HashChainVector[];
  processLengths?: ProcessLengthVector[];
  goldenRecords?: GoldenRecordVector[];
  capabilityAccuracy?: CapabilityAccuracyVector[];
};

export type ConformanceCheckResult = {
  name: string;
  passed: boolean;
  errors: string[];
};

export type ConformanceRunResult = {
  passed: boolean;
  results: ConformanceCheckResult[];
};

export function runConformanceVectors(vectors: ConformanceVectors): ConformanceRunResult {
  const results: ConformanceCheckResult[] = [];

  for (const vector of vectors.canonicalization ?? []) {
    results.push(check(vector.name, () => {
      const actual = canonicalizeEvent(vector.event);
      return actual === vector.canonical ? [] : [`canonical mismatch: expected ${vector.canonical}, got ${actual}`];
    }));
  }

  for (const vector of vectors.hashChains ?? []) {
    results.push(check(vector.name, () => {
      const chain = computeEventHashChain(vector.events, vector.session_id, vector.format_version);
      const recordHash = computeRecordHash(vector.events, vector.session_id, vector.format_version);
      const errors: string[] = [];
      if (JSON.stringify(chain) !== JSON.stringify(vector.chain)) {
        errors.push(`chain mismatch: expected ${JSON.stringify(vector.chain)}, got ${JSON.stringify(chain)}`);
      }
      if (recordHash !== vector.record_hash) {
        errors.push(`record_hash mismatch: expected ${vector.record_hash}, got ${recordHash}`);
      }
      return errors;
    }));
  }

  for (const vector of vectors.processLengths ?? []) {
    results.push(check(vector.name, () => {
      const observed = computeObservedLength(vector.events);
      return observed === vector.observed_final_length
        ? []
        : [`observed_final_length mismatch: expected ${vector.observed_final_length}, got ${observed}`];
    }));
  }

  for (const vector of vectors.goldenRecords ?? []) {
    results.push(check(vector.name, () => verifyRecord(vector.record).errors));
  }

  for (const vector of vectors.capabilityAccuracy ?? []) {
    results.push(check(vector.name, () => {
      const errors = checkCapabilityAccuracy(vector.capabilities, vector.events);
      const actualValid = errors.length === 0;
      return actualValid === vector.valid
        ? []
        : [`capability accuracy mismatch: expected valid=${vector.valid}, errors=${errors.join("; ")}`];
    }));
  }

  return {
    passed: results.every((result) => result.passed),
    results,
  };
}

export function checkCapabilityAccuracy(capabilities: Capability[], events: BufferMutation[]): string[] {
  const errors: string[] = [];
  const hasSourceAttribution = capabilities.includes("source_attribution");
  const hasKeystrokeLevel = capabilities.includes("keystroke_level");

  if (hasSourceAttribution && events.length > 0 && events.every((event) => event.source === "unknown")) {
    errors.push("producer declares source_attribution but all events are unknown");
  }

  if (hasKeystrokeLevel) {
    for (const event of events) {
      if (event.source === "typing" && (event.ins_len ?? 0) > 1) {
        errors.push(`event ${event.seq} is typing with ins_len ${event.ins_len ?? "unknown"} despite keystroke_level capability`);
      }
    }
  }

  return errors;
}

function check(name: string, fn: () => string[]): ConformanceCheckResult {
  try {
    const errors = fn();
    return { name, passed: errors.length === 0, errors };
  } catch (error) {
    return { name, passed: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
}
