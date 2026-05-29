import { createHash, randomBytes } from "node:crypto";

import {
  DEFAULT_IDLE_THRESHOLD_MS as ANALYZER_DEFAULT_IDLE_THRESHOLD_MS,
  runAnalyzers,
  runDefaultAnalyzers,
  type Analyzer,
} from "../../../packages/analyzers/src/index.ts";
import {
  b3HashToBytes,
  computeEventHashChain,
  computeObservedLength,
  isB3Hash,
  verifyRecord,
  type B3Hash,
  type EventLog,
  type RecordManifest,
  type Signal,
  type WritingRecord,
} from "../../../packages/format/src/index.ts";
import {
  DuplicateRecordConflictError,
  ObservedCheckpointConflictError,
  ObservedSessionTokenError,
  observationFromCheckpoints,
  unobservedObservation,
  type AnalysisResult,
  type BoundRecordObservation,
  type ObservationBindingInput,
  type ObservationCommitment,
  type RecordObservation,
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
export const RESERVED_ROUTE_PREFIXES = ["api", "docs", "blog", "write", "assets", "record-assets", "images", "health", "ready", "live"] as const;

export type IngestApiOptions = {
  store: RecordStore;
  baseUrl?: string;
  now?: () => Date;
  idleThresholdMs?: number;
  initialShortSignatureLength?: number;
  analyzers?: Analyzer[];
};

export type ObservationBindingRequest =
  | { observed_session_id: string; token: string }
  | { state: "unobserved" };

export type IngestRecordInput = {
  manifest: RecordManifest;
  events: EventLog;
  observation?: ObservationBindingRequest;
};

export type IngestRecordResponse = {
  record_hash: B3Hash;
  short_signature: string;
  url: string;
  created: boolean;
};

export type PostObservedCheckpointResponse = {
  observed_session_id: string;
  token: string;
  checkpoint_id: string;
  event_count: number;
  chain_tip: B3Hash;
  server_t: string;
  created: boolean;
};

export type GetRecordResponse = {
  manifest: RecordManifest;
  events: EventLog;
  stats: RecordStats;
  signals: Signal[];
  observation: RecordObservation;
};

export type ApiSuccess<T> = { status: number; body: T };
export type ApiFailure = { status: number; body: { error: string; details?: string[] } };
export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

export function createIngestApi(options: IngestApiOptions) {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const now = options.now ?? (() => new Date());
  const idleThresholdMs = options.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
  const initialShortSignatureLength = options.initialShortSignatureLength ?? DEFAULT_SHORT_SIGNATURE_LENGTH;

  async function postObservedCheckpoint(
    observedSessionId: string,
    input: unknown,
  ): Promise<ApiResult<PostObservedCheckpointResponse>> {
    if (!isUuid(observedSessionId)) {
      return { status: 400, body: { error: "invalid_payload", details: ["observed_session_id must be a UUIDv4 string"] } };
    }
    const contentErrors = findContentBearingFields(input);
    if (contentErrors.length > 0) return { status: 400, body: { error: "content_not_allowed", details: contentErrors } };

    const parsed = parseCheckpointInput(input);
    if (!parsed.ok) return { status: 400, body: { error: "invalid_payload", details: parsed.errors } };

    const observedToken = parsed.token ?? generateObservedToken();
    const observedAt = now().toISOString();
    const idempotentConflictProbe = await probeIdempotentCheckpointConflict(observedSessionId, parsed);
    if (idempotentConflictProbe) return idempotentConflictProbe;
    try {
      const appended = await options.store.appendObservedCheckpoint({
        observed_session_id: observedSessionId,
        observed_token_hash: parsed.token ? hashObservedToken(parsed.token) : undefined,
        new_observed_token_hash: hashObservedToken(observedToken),
        event_count: parsed.event_count,
        chain_tip: parsed.chain_tip,
        observed_at: observedAt,
      });
      return {
        status: appended.checkpoint_created ? 201 : 200,
        body: {
          observed_session_id: appended.observed_session_id,
          token: observedToken,
          checkpoint_id: appended.checkpoint.checkpoint_id,
          event_count: appended.checkpoint.event_count,
          chain_tip: appended.checkpoint.chain_tip,
          server_t: appended.checkpoint.observed_at,
          created: appended.checkpoint_created,
        },
      };
    } catch (error) {
      return observedCheckpointErrorResult(error);
    }
  }

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

    let observation: RecordObservation | undefined;
    if (parse.observation) {
      if (isUnobservedObservationRequest(parse.observation)) {
        observation = unobservedObservation();
      } else {
        const observationResult = await bindObservation(parse.observation, stampedRecord, verification.computedChain);
        if ("status" in observationResult) return observationResult;
        observation = observationResult;
      }
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
        observation,
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
      if (error instanceof ObservedCheckpointConflictError) {
        return { status: 409, body: { error: error.code, details: [error.message] } };
      }
      throw error;
    }
  }

  async function bindObservation(
    observation: Extract<ObservationBindingRequest, { observed_session_id: string }>,
    record: WritingRecord,
    computedChain: B3Hash[] | undefined,
  ): Promise<BoundRecordObservation | ApiFailure> {
    const bindingErrors = validateObservationBinding(observation);
    if (bindingErrors.length > 0) return { status: 400, body: { error: "invalid_payload", details: bindingErrors } };

    let session;
    try {
      const binding: ObservationBindingInput = {
        observed_session_id: observation.observed_session_id,
        observed_token_hash: hashObservedToken(observation.token),
      };
      session = await options.store.getObservedSessionForBinding(binding);
    } catch (error) {
      if (error instanceof ObservedSessionTokenError) return observationUnavailableResult();
      throw error;
    }

    if (session.finalized_record_hash && session.finalized_record_hash !== record.manifest.record_hash) {
      return { status: 409, body: { error: "observed_session_finalized", details: ["observed session already finalized"] } };
    }
    if (session.checkpoints.length === 0) {
      return { status: 400, body: { error: "invalid_observation", details: ["observed session has no commitments"] } };
    }

    const chain = computedChain ?? computeEventHashChain(record.events, record.manifest.session_id, record.manifest.format_version);
    const sorted = [...session.checkpoints].sort((left, right) => left.event_count - right.event_count || left.observed_at.localeCompare(right.observed_at));
    for (const checkpoint of sorted) {
      if (checkpoint.event_count < 1) {
        return { status: 409, body: { error: "observation_mismatch", details: [`checkpoint ${checkpoint.checkpoint_id} has invalid event_count`] } };
      }
      if (checkpoint.event_count > record.events.length) {
        return { status: 409, body: { error: "observation_mismatch", details: [`checkpoint ${checkpoint.checkpoint_id} event_count exceeds final record`] } };
      }
      const prefixTip = chain[checkpoint.event_count - 1];
      if (prefixTip !== checkpoint.chain_tip) {
        return { status: 409, body: { error: "observation_mismatch", details: [`checkpoint ${checkpoint.checkpoint_id} does not match final record prefix`] } };
      }
    }

    const lastEventCount = sorted.at(-1)?.event_count ?? 0;
    const state = lastEventCount === record.events.length ? "observed" : "partial";
    return observationFromCheckpoints(session.observed_session_id, state, sorted);
  }

  async function probeIdempotentCheckpointConflict(
    observedSessionId: string,
    parsed: Extract<CheckpointParseResult, { ok: true }>,
  ): Promise<ApiFailure | null> {
    if (!parsed.token) return null;
    try {
      const session = await options.store.getObservedSessionForBinding({
        observed_session_id: observedSessionId,
        observed_token_hash: hashObservedToken(parsed.token),
      });
      const checkpoint = session.checkpoints.find((candidate) => candidate.event_count === parsed.event_count);
      if (checkpoint && checkpoint.chain_tip === parsed.chain_tip) return null;
      if (checkpoint && checkpoint.chain_tip !== parsed.chain_tip) return null;
      if (session.checkpoints.length > 0 && parsed.event_count < Math.max(...session.checkpoints.map((candidate) => candidate.event_count))) {
        return { status: 409, body: { error: "checkpoint_stale", details: ["checkpoint event_count is lower than the latest stored commitment"] } };
      }
      return null;
    } catch (error) {
      if (error instanceof ObservedSessionTokenError) return observationUnavailableResult();
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
    const checkpointMatch = url.pathname.match(/^\/api\/observed-sessions\/([^/]+)\/checkpoints$/);
    if (request.method === "POST" && checkpointMatch) {
      const body = await request.json().catch(() => undefined);
      return jsonResponse(await postObservedCheckpoint(decodeURIComponent(checkpointMatch[1] as string), body));
    }
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

  return { postObservedCheckpoint, postRecord, getRecord, health, handleRequest };
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
    observed_final_length: computeObservedLength(events),
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
    inserted_codepoints_total: events.reduce((total, event) => total + (event.ins_len ?? 0), 0),
    deleted_codepoints_total: events.reduce((total, event) => total + (event.del_len ?? 0), 0),
    largest_atomic_insert_codepoints: events.reduce((largest, event) => Math.max(largest, event.ins_len ?? 0), 0),
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
    observation: stored.observation,
  };
}

type ParseResult = { ok: true; record: WritingRecord; observation?: ObservationBindingRequest } | { ok: false; errors: string[] };

type CheckpointParseResult =
  | { ok: true; event_count: number; chain_tip: B3Hash; token?: string }
  | { ok: false; errors: string[] };

function parseIngestInput(input: unknown): ParseResult {
  if (!isPlainObject(input)) return { ok: false, errors: ["body must be an object"] };
  const keys = Object.keys(input);
  const unexpected = keys.filter((key) => key !== "manifest" && key !== "events" && key !== "observation");
  if (unexpected.length > 0) return { ok: false, errors: unexpected.map((key) => `unexpected top-level field ${key}`) };
  return {
    ok: true,
    record: { manifest: input.manifest as RecordManifest, events: input.events as EventLog },
    observation: input.observation as ObservationBindingRequest | undefined,
  };
}

function parseCheckpointInput(input: unknown): CheckpointParseResult {
  if (!isPlainObject(input)) return { ok: false, errors: ["body must be an object"] };
  const errors: string[] = [];
  const unexpected = Object.keys(input).filter((key) => key !== "event_count" && key !== "chain_tip" && key !== "token");
  errors.push(...unexpected.map((key) => `unexpected checkpoint field ${key}`));
  if (!Number.isInteger(input.event_count) || (input.event_count as number) < 1) {
    errors.push("event_count must be an integer >= 1");
  }
  if (!isB3Hash(input.chain_tip)) errors.push("chain_tip must be a b3: hash");
  if (input.token !== undefined && (typeof input.token !== "string" || input.token.length < 32)) {
    errors.push("token must be a bearer token string when present");
  }
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, event_count: input.event_count as number, chain_tip: input.chain_tip as B3Hash, token: input.token as string | undefined };
}

function validateObservationBinding(observation: Extract<ObservationBindingRequest, { observed_session_id: string }>): string[] {
  const errors: string[] = [];
  if (!isPlainObject(observation)) return ["observation must be an object"];
  const unexpected = Object.keys(observation).filter((key) => key !== "observed_session_id" && key !== "token");
  errors.push(...unexpected.map((key) => `unexpected observation field ${key}`));
  if (typeof observation.observed_session_id !== "string" || !isUuid(observation.observed_session_id)) {
    errors.push("observed_session_id must be a UUIDv4 string");
  }
  if (typeof observation.token !== "string" || observation.token.length < 32) {
    errors.push("token must be a bearer token string");
  }
  return errors;
}

function isUnobservedObservationRequest(observation: ObservationBindingRequest): observation is { state: "unobserved" } {
  return isPlainObject(observation)
    && "state" in observation
    && observation.state === "unobserved"
    && Object.keys(observation).every((key) => key === "state");
}

const PUBLIC_MANIFEST_FIELDS = new Set([
  "format_version",
  "record_hash",
  "session_id",
  "producer",
  "capture_context",
  "text_binding",
  "event_count",
  "duration_ms",
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
    if (["text", "plaintext", "content", "ins_text", "ins_hash", "final_text", "final_text_hash", "final_text_length"].includes(key)) {
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

function observedCheckpointErrorResult(error: unknown): ApiFailure {
  if (error instanceof ObservedSessionTokenError) return observationUnavailableResult();
  if (error instanceof ObservedCheckpointConflictError) return { status: 409, body: { error: error.code, details: [error.message] } };
  throw error;
}

function observationUnavailableResult(): ApiFailure {
  return { status: 404, body: { error: "observation_unavailable" } };
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

function generateObservedToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashObservedToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
