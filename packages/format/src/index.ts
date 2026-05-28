import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

export const FORMAT_PACKAGE = "@possiblymadebyahuman/format";
export const FORMAT_VERSION = "0.1";
export const HASH_PREFIX = "b3:";
export const BLAKE3_HEX_LENGTH = 64;

export type FormatVersion = typeof FORMAT_VERSION;
export type B3Hash = `${typeof HASH_PREFIX}${string}`;

export const OPERATIONS = ["insert", "delete", "replace"] as const;
export type Operation = (typeof OPERATIONS)[number];

export const SOURCES = [
  "typing",
  "paste",
  "cut",
  "drop",
  "ime",
  "autocomplete",
  "programmatic",
  "unknown",
] as const;
export type Source = (typeof SOURCES)[number];

export const CAPABILITIES = [
  "timing",
  "source_attribution",
  "selection",
  "pause_fidelity",
  "keystroke_level",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export type JsonPrimitive = string | number | boolean | null;
export type JsonObject = { [key: string]: JsonValue | undefined };
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

export type BufferMutation = {
  seq: number;
  t: number;
  op: Operation;
  pos: number;
  del_len: number;
  ins_len: number;
  source: Source;
  ins_hash?: B3Hash;
};

export type EventLog = BufferMutation[];

export type ProducerInfo = {
  id: string;
  version: string;
  capabilities: Capability[];
};

export type CaptureContext = {
  surface?: string;
  label?: string;
  browser?: {
    url?: string;
    title?: string;
    field_kind?: string;
  };
  emacs?: {
    buffer_name?: string;
    major_mode?: string;
  };
  [key: string]: JsonValue | undefined;
};

export type Attestation = {
  type: string;
  [key: string]: JsonValue | undefined;
};

export type RecordManifest = {
  format_version: FormatVersion;
  record_hash: B3Hash;
  session_id: string;
  producer: ProducerInfo;
  capture_context?: CaptureContext | null;
  event_count: number;
  duration_ms: number;
  final_text_hash: B3Hash;
  final_text_length: number;
  created_client_t?: string | null;
  ingested_server_t?: string | null;
  parent_record?: B3Hash | null;
  attestations: Attestation[];
};

export type WritingRecord = {
  manifest: RecordManifest;
  events: EventLog;
};

export type SignalMeasure = {
  key: string;
  value: string | number | boolean;
  unit?: string;
};

export type Signal = {
  analyzer_id: string;
  analyzer_version: string;
  applicable: boolean;
  measures: SignalMeasure[];
  human_range?: Record<string, [number, number]>;
  explanation: string;
};

export type ReplayMutation = BufferMutation & {
  /** Plaintext fixture/local-only insertion text. Never part of a public record. */
  ins_text?: string;
};

export type ReplayTextProvider = (event: BufferMutation) => string;

export type ReplayResult = {
  finalText: string;
  finalTextLength: number;
  finalTextHash: B3Hash;
};

export type VerificationResult = {
  valid: boolean;
  errors: string[];
  computedRecordHash?: B3Hash;
  computedChain?: B3Hash[];
  computedFinalTextLength?: number;
  computedFinalTextHash?: B3Hash;
};

const OPERATION_SET = new Set<string>(OPERATIONS);
const SOURCE_SET = new Set<string>(SOURCES);
const CAPABILITY_SET = new Set<string>(CAPABILITIES);
const EVENT_KEYS = new Set(["seq", "t", "op", "pos", "del_len", "ins_len", "source", "ins_hash"]);

export function canonicalizeJson(value: unknown): string {
  if (value === null) return "null";

  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical JSON cannot encode non-finite numbers");
    }
    if (!Number.isInteger(value)) {
      throw new TypeError("format 0.1 canonical JSON only permits integer numbers");
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(",")}]`;
  }

  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareStringsByCodePoint(left, right));

    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalizeJson(item)}`)
      .join(",")}}`;
  }

  throw new TypeError(`canonical JSON cannot encode ${typeof value}`);
}

export function canonicalizeEvent(event: BufferMutation): string {
  assertValidEvent(event);
  const canonicalEvent: Record<string, JsonValue | undefined> = {
    seq: event.seq,
    t: event.t,
    op: event.op,
    pos: event.pos,
    del_len: event.del_len,
    ins_len: event.ins_len,
    source: event.source,
    ins_hash: event.ins_hash,
  };
  return canonicalizeJson(canonicalEvent);
}

export function canonicalizeEventBytes(event: BufferMutation): Uint8Array {
  return utf8ToBytes(canonicalizeEvent(event));
}

export function b3HashBytes(input: Uint8Array): B3Hash {
  return `${HASH_PREFIX}${bytesToHex(blake3(input))}`;
}

export function b3HashText(input: string): B3Hash {
  return b3HashBytes(utf8ToBytes(input));
}

export function isB3Hash(value: unknown): value is B3Hash {
  return typeof value === "string" && new RegExp(`^${HASH_PREFIX}[0-9a-f]{${BLAKE3_HEX_LENGTH}}$`).test(value);
}

export function b3HashToBytes(hash: B3Hash): Uint8Array {
  if (!isB3Hash(hash)) {
    throw new TypeError(`invalid ${HASH_PREFIX} hash`);
  }
  return hexToBytes(hash.slice(HASH_PREFIX.length));
}

export function computeEventHashChain(
  events: EventLog,
  sessionId: string,
  formatVersion: FormatVersion = FORMAT_VERSION,
): B3Hash[] {
  assertNonEmptyEventLog(events);
  assertValidEventLog(events);

  const chain: B3Hash[] = [];
  for (const event of events) {
    const eventBytes = canonicalizeEventBytes(event);
    const input =
      event.seq === 0
        ? concatBytes(utf8ToBytes(formatVersion), utf8ToBytes(sessionId), eventBytes)
        : concatBytes(b3HashToBytes(chain[event.seq - 1] as B3Hash), eventBytes);
    chain.push(b3HashBytes(input));
  }
  return chain;
}

export function computeRecordHash(
  events: EventLog,
  sessionId: string,
  formatVersion: FormatVersion = FORMAT_VERSION,
): B3Hash {
  return last(computeEventHashChain(events, sessionId, formatVersion));
}

export function verifyEventHashChain(record: WritingRecord): VerificationResult {
  const errors = [...validateManifest(record.manifest), ...validateEventLog(record.events)];
  if (record.events.length === 0) {
    errors.push("event log must contain at least one event to compute a record hash");
  }

  let computedChain: B3Hash[] | undefined;
  let computedRecordHash: B3Hash | undefined;
  if (errors.length === 0) {
    computedChain = computeEventHashChain(
      record.events,
      record.manifest.session_id,
      record.manifest.format_version,
    );
    computedRecordHash = last(computedChain);
    if (record.manifest.record_hash !== computedRecordHash) {
      errors.push(`record_hash mismatch: expected ${record.manifest.record_hash}, computed ${computedRecordHash}`);
    }
  }

  return { valid: errors.length === 0, errors, computedRecordHash, computedChain };
}

export function replayEvents(events: EventLog, getInsertedText: ReplayTextProvider): ReplayResult {
  assertValidEventLog(events);
  const buffer: string[] = [];

  for (const event of events) {
    if (event.pos > buffer.length) {
      throw new RangeError(`event ${event.seq} position ${event.pos} exceeds buffer length ${buffer.length}`);
    }
    if (event.pos + event.del_len > buffer.length) {
      throw new RangeError(`event ${event.seq} deletes beyond buffer length ${buffer.length}`);
    }

    const inserted = event.ins_len > 0 ? getInsertedText(event) : "";
    const insertedCodepoints = codepoints(inserted);
    if (insertedCodepoints.length !== event.ins_len) {
      throw new RangeError(
        `event ${event.seq} inserted text length ${insertedCodepoints.length} does not match ins_len ${event.ins_len}`,
      );
    }

    buffer.splice(event.pos, event.del_len, ...insertedCodepoints);
  }

  const finalText = buffer.join("");
  const metadata = computeFinalTextMetadata(finalText);
  return { finalText, ...metadata };
}

export function replayEventsWithText(events: ReplayMutation[]): ReplayResult {
  return replayEvents(events.map(stripReplayText), (event) => {
    const replayEvent = events[event.seq];
    if (!replayEvent || replayEvent.seq !== event.seq) {
      throw new RangeError(`missing replay fixture for event ${event.seq}`);
    }
    if (event.ins_len > 0 && replayEvent.ins_text === undefined) {
      throw new RangeError(`event ${event.seq} requires local ins_text fixture`);
    }
    return replayEvent.ins_text ?? "";
  });
}

export function computeFinalTextMetadata(text: string): Pick<ReplayResult, "finalTextLength" | "finalTextHash"> {
  return {
    finalTextLength: codepointLength(text),
    finalTextHash: b3HashText(text),
  };
}

export function verifyRecord(record: WritingRecord, options: { getInsertedText?: ReplayTextProvider } = {}): VerificationResult {
  const errors = [...validateManifest(record.manifest), ...validateEventLog(record.events)];

  if (record.events.length === 0) {
    errors.push("event log must contain at least one event to compute a record hash");
  }

  if (record.manifest.event_count !== record.events.length) {
    errors.push(`event_count mismatch: manifest ${record.manifest.event_count}, events ${record.events.length}`);
  }

  const lastEvent = record.events.at(-1);
  if (lastEvent && record.manifest.duration_ms < lastEvent.t) {
    errors.push(`duration_ms ${record.manifest.duration_ms} is less than last event time ${lastEvent.t}`);
  }

  let computedChain: B3Hash[] | undefined;
  let computedRecordHash: B3Hash | undefined;
  if (errors.length === 0) {
    computedChain = computeEventHashChain(
      record.events,
      record.manifest.session_id,
      record.manifest.format_version,
    );
    computedRecordHash = last(computedChain);
    if (record.manifest.record_hash !== computedRecordHash) {
      errors.push(`record_hash mismatch: expected ${record.manifest.record_hash}, computed ${computedRecordHash}`);
    }
  }

  let computedFinalTextLength: number | undefined;
  let computedFinalTextHash: B3Hash | undefined;
  if (options.getInsertedText) {
    try {
      const replay = replayEvents(record.events, options.getInsertedText);
      computedFinalTextLength = replay.finalTextLength;
      computedFinalTextHash = replay.finalTextHash;
      if (record.manifest.final_text_length !== replay.finalTextLength) {
        errors.push(
          `final_text_length mismatch: manifest ${record.manifest.final_text_length}, replay ${replay.finalTextLength}`,
        );
      }
      if (record.manifest.final_text_hash !== replay.finalTextHash) {
        errors.push(`final_text_hash mismatch: expected ${record.manifest.final_text_hash}, computed ${replay.finalTextHash}`);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    computedRecordHash,
    computedChain,
    computedFinalTextLength,
    computedFinalTextHash,
  };
}

export function validateEvent(event: unknown, expectedSeq?: number): string[] {
  const errors: string[] = [];
  if (!isPlainObject(event)) return ["event must be an object"];

  for (const key of Object.keys(event)) {
    if (!EVENT_KEYS.has(key)) errors.push(`event contains unknown field ${key}`);
  }

  const candidate = event as Partial<BufferMutation>;
  validateNonNegativeInteger(candidate.seq, "seq", errors);
  validateNonNegativeInteger(candidate.t, "t", errors);
  validateNonNegativeInteger(candidate.pos, "pos", errors);
  validateNonNegativeInteger(candidate.del_len, "del_len", errors);
  validateNonNegativeInteger(candidate.ins_len, "ins_len", errors);

  if (expectedSeq !== undefined && candidate.seq !== expectedSeq) {
    errors.push(`seq must be gap-free: expected ${expectedSeq}, got ${String(candidate.seq)}`);
  }

  if (typeof candidate.op !== "string" || !OPERATION_SET.has(candidate.op)) {
    errors.push(`op must be one of ${OPERATIONS.join(", ")}`);
  }
  if (typeof candidate.source !== "string" || !SOURCE_SET.has(candidate.source)) {
    errors.push(`source must be one of ${SOURCES.join(", ")}`);
  }
  if (candidate.ins_hash !== undefined && !isB3Hash(candidate.ins_hash)) {
    errors.push(`ins_hash must be a ${HASH_PREFIX} hash when present`);
  }

  const delLen = candidate.del_len;
  const insLen = candidate.ins_len;
  if (
    typeof delLen === "number" &&
    typeof insLen === "number" &&
    Number.isInteger(delLen) &&
    Number.isInteger(insLen) &&
    typeof candidate.op === "string"
  ) {
    if (candidate.op === "insert" && !(delLen === 0 && insLen > 0)) {
      errors.push("insert op requires del_len 0 and ins_len > 0");
    }
    if (candidate.op === "delete" && !(delLen > 0 && insLen === 0)) {
      errors.push("delete op requires del_len > 0 and ins_len 0");
    }
    if (candidate.op === "replace" && !(delLen > 0 && insLen > 0)) {
      errors.push("replace op requires del_len > 0 and ins_len > 0");
    }
  }

  return errors;
}

export function validateEventLog(events: unknown): string[] {
  if (!Array.isArray(events)) return ["event log must be an array"];
  const errors: string[] = [];
  let previousT = -1;
  events.forEach((event, index) => {
    errors.push(...validateEvent(event, index));
    if (isPlainObject(event) && Number.isInteger((event as Partial<BufferMutation>).t)) {
      const t = (event as BufferMutation).t;
      if (t < previousT) errors.push(`event ${index} t must be non-decreasing`);
      previousT = t;
    }
  });
  return errors;
}

export function validateManifest(manifest: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(manifest)) return ["manifest must be an object"];
  const candidate = manifest as Partial<RecordManifest>;

  if (candidate.format_version !== FORMAT_VERSION) errors.push(`format_version must be ${FORMAT_VERSION}`);
  if (!isB3Hash(candidate.record_hash)) errors.push(`record_hash must be a ${HASH_PREFIX} hash`);
  if (typeof candidate.session_id !== "string" || !isUuid(candidate.session_id)) {
    errors.push("session_id must be a UUIDv4 string");
  }
  if (!isPlainObject(candidate.producer)) {
    errors.push("producer must be an object");
  } else {
    if (typeof candidate.producer.id !== "string" || candidate.producer.id.length === 0) {
      errors.push("producer.id must be a non-empty string");
    }
    if (typeof candidate.producer.version !== "string" || candidate.producer.version.length === 0) {
      errors.push("producer.version must be a non-empty string");
    }
    if (!Array.isArray(candidate.producer.capabilities)) {
      errors.push("producer.capabilities must be an array");
    } else {
      for (const capability of candidate.producer.capabilities) {
        if (typeof capability !== "string" || !CAPABILITY_SET.has(capability)) {
          errors.push(`producer capability must be one of ${CAPABILITIES.join(", ")}`);
        }
      }
    }
  }
  if (
    candidate.capture_context !== undefined &&
    candidate.capture_context !== null &&
    !isPlainObject(candidate.capture_context)
  ) {
    errors.push("capture_context must be an object, null, or absent");
  }
  validateNonNegativeInteger(candidate.event_count, "event_count", errors);
  validateNonNegativeInteger(candidate.duration_ms, "duration_ms", errors);
  if (!isB3Hash(candidate.final_text_hash)) errors.push(`final_text_hash must be a ${HASH_PREFIX} hash`);
  validateNonNegativeInteger(candidate.final_text_length, "final_text_length", errors);
  validateNullableString(candidate.created_client_t, "created_client_t", errors);
  validateNullableString(candidate.ingested_server_t, "ingested_server_t", errors);
  if ("parent_record_hash" in candidate) {
    errors.push("parent_record_hash is not a public manifest field; use parent_record");
  }
  validateNullableB3(candidate.parent_record, "parent_record", errors);
  if (!Array.isArray(candidate.attestations)) errors.push("attestations must be an array");

  return errors;
}

export function assertValidEvent(event: unknown, expectedSeq?: number): asserts event is BufferMutation {
  const errors = validateEvent(event, expectedSeq);
  if (errors.length > 0) throw new TypeError(errors.join("; "));
}

export function assertValidEventLog(events: unknown): asserts events is EventLog {
  const errors = validateEventLog(events);
  if (errors.length > 0) throw new TypeError(errors.join("; "));
}

export function assertNonEmptyEventLog(events: EventLog): void {
  if (events.length === 0) throw new TypeError("event log must contain at least one event");
}

export function codepoints(text: string): string[] {
  return Array.from(text);
}

export function codepointLength(text: string): number {
  return codepoints(text).length;
}

function stripReplayText(event: ReplayMutation): BufferMutation {
  const { ins_text: _localOnly, ...publicEvent } = event;
  return publicEvent;
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function compareStringsByCodePoint(left: string, right: string): number {
  const leftCodepoints = Array.from(left);
  const rightCodepoints = Array.from(right);
  const length = Math.min(leftCodepoints.length, rightCodepoints.length);
  for (let index = 0; index < length; index += 1) {
    const leftPoint = leftCodepoints[index]?.codePointAt(0) ?? 0;
    const rightPoint = rightCodepoints[index]?.codePointAt(0) ?? 0;
    if (leftPoint !== rightPoint) return leftPoint - rightPoint;
  }
  return leftCodepoints.length - rightCodepoints.length;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateNonNegativeInteger(value: unknown, name: string, errors: string[]): void {
  if (!Number.isInteger(value) || (value as number) < 0) errors.push(`${name} must be a non-negative integer`);
}

function validateNullableString(value: unknown, name: string, errors: string[]): void {
  if (value !== undefined && value !== null && typeof value !== "string") errors.push(`${name} must be a string, null, or absent`);
}

function validateNullableB3(value: unknown, name: string, errors: string[]): void {
  if (value !== undefined && value !== null && !isB3Hash(value)) errors.push(`${name} must be a ${HASH_PREFIX} hash, null, or absent`);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function last<T>(items: T[]): T {
  const item = items.at(-1);
  if (item === undefined) throw new TypeError("expected a non-empty array");
  return item;
}
