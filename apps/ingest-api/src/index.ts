import {
  DEFAULT_IDLE_THRESHOLD_MS as ANALYZER_DEFAULT_IDLE_THRESHOLD_MS,
  runAnalyzers,
  runDefaultAnalyzers,
  type Analyzer,
} from "../../../packages/analyzers/src/index.ts";
import {
  b3HashToBytes,
  isB3Hash,
  verifyRecord,
  type B3Hash,
  type BufferMutation,
  type EventLog,
  type RecordManifest,
  type Signal,
  type WritingRecord,
} from "../../../packages/format/src/index.ts";
import {
  DuplicateRecordConflictError,
  type AnalysisResult,
  type RecordStats,
  type RecordStore,
  type StoredRecord,
} from "../../../packages/storage/src/index.ts";

export const INGEST_API_APP = "@possiblymadebyahuman/ingest-api";
export const DEFAULT_BASE_URL = "https://possiblymadebyahuman.com";
export const DEFAULT_IDLE_THRESHOLD_MS = ANALYZER_DEFAULT_IDLE_THRESHOLD_MS;
export const DEFAULT_SHORT_SIGNATURE_LENGTH = 10;
// Reserved route collisions use a deterministic leading-X rescue candidate in generateShortSignature.
// Do not reserve x/X as a route prefix unless the rescue strategy is changed at the same time.
export const RESERVED_ROUTE_PREFIXES = ["api", "docs", "blog", "assets", "record-assets", "images", "health", "ready", "live"] as const;

export type IngestApiOptions = {
  store: RecordStore;
  baseUrl?: string;
  now?: () => Date;
  idleThresholdMs?: number;
  initialShortSignatureLength?: number;
  analyzers?: Analyzer[];
};

export type IngestRecordInput = {
  manifest: RecordManifest;
  events: EventLog;
};

export type IngestRecordResponse = {
  record_hash: B3Hash;
  short_signature: string;
  url: string;
  created: boolean;
};

export type GetRecordResponse = {
  manifest: RecordManifest;
  events: EventLog;
  stats: RecordStats;
  signals: Signal[];
};

export type ApiSuccess<T> = { status: number; body: T };
export type ApiFailure = { status: number; body: { error: string; details?: string[] } };
export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

export function createIngestApi(options: IngestApiOptions) {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const now = options.now ?? (() => new Date());
  const idleThresholdMs = options.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
  const initialShortSignatureLength = options.initialShortSignatureLength ?? DEFAULT_SHORT_SIGNATURE_LENGTH;

  async function postRecord(input: unknown): Promise<ApiResult<IngestRecordResponse>> {
    const parse = parseIngestInput(input);
    if (!parse.ok) return { status: 400, body: { error: "invalid_record", details: parse.errors } };

    const manifestFieldErrors = validatePublicManifestFields(parse.record.manifest);
    if (manifestFieldErrors.length > 0) {
      return { status: 400, body: { error: "invalid_manifest", details: manifestFieldErrors } };
    }

    const contentErrors = findContentBearingFields(input);
    if (contentErrors.length > 0) {
      return { status: 400, body: { error: "content_not_allowed", details: contentErrors } };
    }

    const stampedRecord: WritingRecord = {
      manifest: {
        ...parse.record.manifest,
        ingested_server_t: now().toISOString(),
      },
      events: parse.record.events,
    };

    const verification = verifyRecord(stampedRecord);
    if (!verification.valid) {
      return { status: 400, body: { error: "verification_failed", details: verification.errors } };
    }

    const short_signature = await generateShortSignature(
      stampedRecord.manifest.record_hash,
      options.store,
      initialShortSignatureLength,
    );
    const stats = computeRecordStats(stampedRecord, idleThresholdMs);
    const analyzerInput = { events: stampedRecord.events, manifest: stampedRecord.manifest };
    const publicSignals = options.analyzers
      ? runAnalyzers(analyzerInput, options.analyzers)
      : runDefaultAnalyzers(analyzerInput, { idleThresholdMs });
    const signals: AnalysisResult[] = publicSignals
      .map((signal) => ({ ...signal, record_hash: stampedRecord.manifest.record_hash }));

    try {
      const save = await options.store.saveRecord({
        record: stampedRecord,
        short_signature,
        stats,
        signals,
        created_at: stampedRecord.manifest.ingested_server_t ?? now().toISOString(),
      });
      return {
        status: save.created ? 201 : 200,
        body: {
          record_hash: save.stored.manifest.record_hash,
          short_signature: save.stored.short_signature,
          url: `${baseUrl}/${save.stored.short_signature}`,
          created: save.created,
        },
      };
    } catch (error) {
      if (error instanceof DuplicateRecordConflictError) {
        return { status: 409, body: { error: "immutable_record_conflict", details: [error.message] } };
      }
      throw error;
    }
  }

  async function getRecord(shortSignatureOrHash: string): Promise<ApiResult<GetRecordResponse>> {
    const stored = await options.store.findByShortSignatureOrHash(shortSignatureOrHash);
    if (!stored) return { status: 404, body: { error: "record_not_found" } };
    return { status: 200, body: toGetRecordResponse(stored) };
  }

  function health(): ApiSuccess<{ ok: true }> {
    return { status: 200, body: { ok: true } };
  }

  async function handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/api/health") return jsonResponse(health());
    if (request.method === "POST" && url.pathname === "/api/records") {
      const body = await request.json().catch(() => undefined);
      return jsonResponse(await postRecord(body));
    }
    const match = url.pathname.match(/^\/api\/records\/(.+)$/);
    if (request.method === "GET" && match) {
      return jsonResponse(await getRecord(decodeURIComponent(match[1] as string)));
    }
    return jsonResponse({ status: 404, body: { error: "not_found" } });
  }

  return { postRecord, getRecord, health, handleRequest };
}

export function computeRecordStats(record: WritingRecord, idleThresholdMs = DEFAULT_IDLE_THRESHOLD_MS): RecordStats {
  const events = record.events;
  const delays = events.slice(1).map((event, index) => event.t - (events[index]?.t ?? 0));
  const sortedDelays = [...delays].sort((left, right) => left - right);
  const idleDelays = delays.filter((delay) => delay >= idleThresholdMs);

  return {
    record_hash: record.manifest.record_hash,
    event_count: events.length,
    duration_ms: record.manifest.duration_ms,
    final_text_length: record.manifest.final_text_length,
    insert_op_count: events.filter((event) => event.op === "insert").length,
    delete_op_count: events.filter((event) => event.op === "delete").length,
    replace_op_count: events.filter((event) => event.op === "replace").length,
    typed_event_count: events.filter((event) => event.source === "typing").length,
    paste_event_count: events.filter((event) => event.source === "paste").length,
    cut_event_count: events.filter((event) => event.source === "cut").length,
    drop_event_count: events.filter((event) => event.source === "drop").length,
    ime_event_count: events.filter((event) => event.source === "ime").length,
    autocomplete_event_count: events.filter((event) => event.source === "autocomplete").length,
    programmatic_event_count: events.filter((event) => event.source === "programmatic").length,
    unknown_source_count: events.filter((event) => event.source === "unknown").length,
    inserted_codepoints_total: events.reduce((total, event) => total + event.ins_len, 0),
    deleted_codepoints_total: events.reduce((total, event) => total + event.del_len, 0),
    largest_atomic_insert_codepoints: events.reduce((largest, event) => Math.max(largest, event.ins_len), 0),
    inter_event_delay_min_ms: sortedDelays[0] ?? null,
    inter_event_delay_p50_ms: percentile(sortedDelays, 0.5),
    inter_event_delay_p90_ms: percentile(sortedDelays, 0.9),
    inter_event_delay_p95_ms: percentile(sortedDelays, 0.95),
    inter_event_delay_p99_ms: percentile(sortedDelays, 0.99),
    inter_event_delay_max_ms: sortedDelays.at(-1) ?? null,
    active_time_ms: Math.max(0, record.manifest.duration_ms - idleDelays.reduce((total, delay) => total + delay, 0)),
    idle_time_ms: idleDelays.reduce((total, delay) => total + delay, 0),
    long_pause_count: idleDelays.length,
    delay_histogram: buildDelayHistogram(delays),
  };
}

export async function generateShortSignature(
  recordHash: B3Hash,
  store: Pick<RecordStore, "findByShortSignature" | "shortSignatureExists">,
  initialLength = DEFAULT_SHORT_SIGNATURE_LENGTH,
): Promise<string> {
  const encoded = base58Encode(b3HashToBytes(recordHash));
  const candidates = [encoded, `X${encoded}`];
  for (const candidateSource of candidates) {
    for (let length = initialLength; length <= candidateSource.length; length += 1) {
      const candidate = candidateSource.slice(0, length);
      if (isReservedShortSignature(candidate)) continue;
      const existing = await store.findByShortSignature(candidate);
      if (!existing || existing.manifest.record_hash === recordHash) return candidate;
    }
  }
  throw new Error("could not generate unique short signature");
}

export function isReservedShortSignature(candidate: string): boolean {
  const lower = candidate.toLowerCase();
  return RESERVED_ROUTE_PREFIXES.some((reserved) => lower.startsWith(reserved));
}

export function toGetRecordResponse(stored: StoredRecord): GetRecordResponse {
  return {
    manifest: stored.manifest,
    events: stored.events,
    stats: stored.stats,
    signals: stored.signals.map(stripAnalysisResultStorageFields),
  };
}

type ParseResult = { ok: true; record: WritingRecord } | { ok: false; errors: string[] };

function parseIngestInput(input: unknown): ParseResult {
  if (!isPlainObject(input)) return { ok: false, errors: ["body must be an object"] };
  const keys = Object.keys(input);
  const unexpected = keys.filter((key) => key !== "manifest" && key !== "events");
  if (unexpected.length > 0) return { ok: false, errors: unexpected.map((key) => `unexpected top-level field ${key}`) };
  return { ok: true, record: { manifest: input.manifest as RecordManifest, events: input.events as EventLog } };
}

const PUBLIC_MANIFEST_FIELDS = new Set([
  "format_version",
  "record_hash",
  "session_id",
  "producer",
  "capture_context",
  "event_count",
  "duration_ms",
  "final_text_hash",
  "final_text_length",
  "created_client_t",
  "ingested_server_t",
  "parent_record",
  "attestations",
]);

function validatePublicManifestFields(manifest: unknown): string[] {
  if (!isPlainObject(manifest)) return ["manifest must be an object"];
  return Object.keys(manifest)
    .filter((key) => !PUBLIC_MANIFEST_FIELDS.has(key))
    .map((key) => `manifest contains unexpected public field ${key}`);
}

function findContentBearingFields(input: unknown): string[] {
  const errors: string[] = [];
  visit(input, "$", (path, key) => {
    if (["text", "plaintext", "content", "ins_text", "final_text"].includes(key)) {
      errors.push(`${path} is not allowed in public content-blind records`);
    }
  });
  return errors;
}

function visit(value: unknown, path: string, onKey: (path: string, key: string) => void): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => visit(item, `${path}[${index}]`, onKey));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    onKey(childPath, key);
    visit(child, childPath, onKey);
  }
}

function stripAnalysisResultStorageFields(signal: AnalysisResult): Signal {
  const { id: _id, record_hash: _recordHash, created_at: _createdAt, ...publicSignal } = signal;
  return publicSignal;
}

function jsonResponse(result: ApiResult<unknown>): Response {
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { "content-type": "application/json" },
  });
}

function percentile(sortedNumbers: number[], percentileValue: number): number | null {
  if (sortedNumbers.length === 0) return null;
  const index = Math.min(sortedNumbers.length - 1, Math.ceil(sortedNumbers.length * percentileValue) - 1);
  return sortedNumbers[index] as number;
}

function buildDelayHistogram(delays: number[]): Array<{ bucket: string; count: number }> {
  const buckets = [
    { bucket: "0-999ms", max: 999, count: 0 },
    { bucket: "1s-4.999s", max: 4_999, count: 0 },
    { bucket: "5s-29.999s", max: 29_999, count: 0 },
    { bucket: "30s-299.999s", max: 299_999, count: 0 },
    { bucket: "5m+", max: Number.POSITIVE_INFINITY, count: 0 },
  ];
  for (const delay of delays) {
    const target = buckets.find((bucket) => delay <= bucket.max);
    if (target) target.count += 1;
  }
  return buckets.map(({ bucket, count }) => ({ bucket, count }));
}

function base58Encode(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) + BigInt(byte);
  let output = "";
  while (value > 0n) {
    const remainder = Number(value % 58n);
    output = alphabet[remainder] + output;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte === 0) output = alphabet[0] + output;
    else break;
  }
  return output || alphabet[0];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
