import { createHash } from "node:crypto";
import { advanceEventHash, computeEventHashChain, MAX_INTEGER_FIELD_VALUE, MAX_TIME_FIELD_VALUE, sealRecordHash, validateEvent, validateManifest,
  type B3Hash, type EventLog, type RecordManifest } from "../../../packages/format/src/index.ts";
import { appendAnalysisEvent, createAnalysisAccumulator, finalizeAnalysis, type AnalysisAccumulator } from "../../../packages/analyzers/src/streaming.ts";
import { ChunkedUploadError, MAX_EVENT_CHUNK, type UploadObservation, type UploadState } from "../../../packages/storage/src/chunked.ts";
import { analyzerErrorSignal, type Analyzer } from "../../../packages/analyzers/src/index.ts";
import type { RecordStore, StoredRecord } from "../../../packages/storage/src/index.ts";
import { generateShortSignature, toGetRecordResponse, type ApiResult } from "./index.ts";

type Options = { store: RecordStore; baseUrl: string; now: () => Date; idleThresholdMs: number; initialShortSignatureLength: number; analyzers?: Analyzer[];
  validateManifestFields: (value: unknown) => string[]; validateContent: (value: unknown) => string[] };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function invalid(code: string, errors: string[]): never { throw new ChunkedUploadError(400, code, errors.slice(0, 20).join("; ")); }
function observation(value: unknown): UploadObservation | undefined {
  if (value === undefined) return undefined;
  if (!object(value)) invalid("invalid_observation", ["observation must be an object"]);
  if (value.state === "unobserved" && Object.keys(value).length === 1) return { state: "unobserved" };
  if (Object.keys(value).some(key => !["observed_session_id", "token"].includes(key)) || typeof value.observed_session_id !== "string" || !UUID.test(value.observed_session_id) ||
    typeof value.token !== "string" || value.token.length < 32 || value.token.length > 1024) invalid("invalid_observation", ["invalid observation binding"]);
  return { observed_session_id: value.observed_session_id, observed_token_hash: createHash("sha256").update(value.token).digest("hex") };
}
function assertStats(stats: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(stats)) if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0 || value > (key.endsWith("_ms") ? MAX_TIME_FIELD_VALUE : MAX_INTEGER_FIELD_VALUE))) {
    invalid("invalid_record", [`${key} exceeds the supported storage range`]);
  }
}
export function createChunkedApi(options: Options) {
  const { store } = options;
  const reply = (record_hash: B3Hash, short_signature: string, created: boolean) => ({ record_hash, short_signature, created, url: `${options.baseUrl}/${short_signature}` });
  async function statusView(state: UploadState) {
    const saved = await store.findByRecordHash(state.manifest.record_hash);
    return { upload_id: state.upload_id, next_seq: state.next_seq, max_chunk_events: MAX_EVENT_CHUNK,
      ...(saved ? { completed: reply(saved.manifest.record_hash, saved.short_signature, false) } : {}) };
  }
  async function begin(value: unknown) {
    if (!store.chunked) throw new ChunkedUploadError(503, "chunked_upload_unavailable");
    const contentErrors = options.validateContent(value); if (contentErrors.length) invalid("content_not_allowed", contentErrors);
    if (!object(value) || Object.keys(value).some(key => !["upload_id", "manifest", "observation"].includes(key)) || typeof value.upload_id !== "string" || !UUID.test(value.upload_id)) invalid("invalid_payload", ["upload_id must be a lowercase UUIDv4"]);
    const errors = [...validateManifest(value.manifest), ...options.validateManifestFields(value.manifest)];
    if (errors.length) invalid("invalid_manifest", errors);
    const manifest = value.manifest as RecordManifest;
    if (!manifest.event_count) invalid("invalid_manifest", ["event_count must be positive"]);
    if (manifest.parent_record && !await store.recordExists(manifest.parent_record)) invalid("invalid_manifest", ["parent_record does not refer to a stored record"]);
    const state = await store.chunked.begin({ upload_id: value.upload_id, manifest: { ...manifest, ingested_server_t: options.now().toISOString() },
      observation: observation(value.observation), next_seq: 0, chain_tip: null, last_t: null, observed_length: 0, analysis_state: createAnalysisAccumulator(options.idleThresholdMs) });
    return { status: 200, body: await statusView(state) };
  }
  async function uploadStatus(id: string) {
    const state = UUID.test(id) ? await store.chunked?.status(id) : null;
    if (!state) throw new ChunkedUploadError(404, "upload_not_found");
    return { status: 200, body: await statusView(state) };
  }
  async function append(id: string, value: unknown) {
    if (!UUID.test(id) || !store.chunked) throw new ChunkedUploadError(404, "upload_not_found");
    const contentErrors = options.validateContent(value); if (contentErrors.length) invalid("content_not_allowed", contentErrors);
    if (!object(value) || Object.keys(value).some(key => !["start_seq", "events"].includes(key)) || !Number.isSafeInteger(value.start_seq) || (value.start_seq as number) < 0 ||
      !Array.isArray(value.events) || value.events.length < 1 || value.events.length > MAX_EVENT_CHUNK) invalid("invalid_payload", [`chunks require start_seq and 1–${MAX_EVENT_CHUNK} events`]);
    const events = value.events as EventLog;
    const state = await store.chunked.append(id, value.start_seq as number, events, current => {
      const tips: B3Hash[] = [], delays: number[] = [];
      const analysis = current.analysis_state as AnalysisAccumulator;
      for (const event of events) {
        const errors = validateEvent(event, current.next_seq);
        if (errors.length) invalid("verification_failed", errors);
        if (current.last_t !== null && event.t < current.last_t) invalid("verification_failed", ["event times must be nondecreasing"]);
        if (event.t > current.manifest.duration_ms) invalid("verification_failed", ["event time exceeds signed finish"]);
        if (current.last_t !== null) delays.push(event.t - current.last_t);
        current.chain_tip = advanceEventHash(current.chain_tip, event, current.manifest.session_id, current.manifest.format_version);
        tips.push(current.chain_tip);
        appendAnalysisEvent(analysis, event);
        current.next_seq++; current.last_t = event.t; current.observed_length = analysis.observed_length;
        if (current.observed_length !== null && current.observed_length > MAX_INTEGER_FIELD_VALUE) invalid("verification_failed", ["observed length exceeds supported range"]);
      }
      return { state: current, chain_tips: tips, delays };
    });
    return { status: 200, body: { upload_id: state.upload_id, next_seq: state.next_seq, max_chunk_events: MAX_EVENT_CHUNK } };
  }
  async function finalize(id: string) {
    if (!UUID.test(id) || !store.chunked) throw new ChunkedUploadError(404, "upload_not_found");
    const state = await store.chunked.status(id); if (!state) throw new ChunkedUploadError(404, "upload_not_found");
    for (let attempt = 0; attempt < 3; attempt++) {
      const signature = await generateShortSignature(state.manifest.record_hash, store, options.initialShortSignatureLength);
      try {
        const saved = await store.chunked.finalize(id, (current, percentiles) => {
          if (current.next_seq !== current.manifest.event_count || !current.chain_tip) throw new ChunkedUploadError(409, "upload_incomplete");
          if (sealRecordHash(current.chain_tip, current.manifest.format_version, current.manifest.text_binding, current.manifest) !== current.manifest.record_hash) invalid("verification_failed", ["record_hash mismatch"]);
          const { stats, signals } = finalizeAnalysis(current.analysis_state as AnalysisAccumulator, current.manifest, percentiles);
          assertStats(stats);
          const selectedSignals = options.analyzers ? options.analyzers.map(analyzer => ({ ...analyzerErrorSignal(analyzer, new Error("array-only analyzer")),
            explanation: `Analyzer ${analyzer.id} requires a complete event array and is unavailable for chunked publication. The stored writing record and statistics are unaffected.` })) : signals;
          return { short_signature: signature, stats, signals: selectedSignals.map(signal => ({ ...signal, record_hash: current.manifest.record_hash })) };
        });
        return { status: saved.created ? 201 : 200, body: reply(saved.record_hash, saved.short_signature, saved.created) };
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
          if (attempt < 2) continue;
          throw new ChunkedUploadError(503, "signature_allocation_unavailable");
        }
        throw error;
      }
    }
    throw new ChunkedUploadError(503, "signature_allocation_unavailable");
  }
  async function summary(id: string) {
    const record = await store.findByShortSignatureOrHash(id); if (!record) throw new ChunkedUploadError(404, "record_not_found");
    if (record.event_storage !== "chunks") {
      const response = toGetRecordResponse(record); const { events, ...rest } = response;
      return { status: 200, body: { ...rest, events_page_size: MAX_EVENT_CHUNK, first_event_t: events[0]?.t ?? null, last_event_t: events.at(-1)?.t ?? null } };
    }
    const first = await store.chunked!.page(record, 0, 1);
    const last = await store.chunked!.page(record, Math.max(0, record.manifest.event_count - 1), 1);
    return { status: 200, body: { manifest: record.manifest, stats: record.stats,
      signals: record.signals.map(({ record_hash, id, created_at, ...signal }) => signal), observation: record.observation,
      events_page_size: MAX_EVENT_CHUNK, first_event_t: first.events[0]?.t ?? null, last_event_t: last.events[0]?.t ?? null } };
  }
  async function page(id: string, offset: number, limit: number) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVENT_CHUNK) invalid("invalid_pagination", [`offset must be nonnegative and limit 1–${MAX_EVENT_CHUNK}`]);
    const record = await store.findByShortSignatureOrHash(id); if (!record) throw new ChunkedUploadError(404, "record_not_found");
    if (offset > record.manifest.event_count) invalid("invalid_pagination", ["offset exceeds record length"]);
    return { status: 200, body: await eventPage(record, offset, limit) };
  }
  async function eventPage(record: StoredRecord, offset: number, limit: number) {
    if (record.event_storage === "chunks") return store.chunked!.page(record, offset, limit);
    const tips = computeEventHashChain(record.events, record.manifest.session_id, record.manifest.format_version);
    const events = record.events.slice(offset, offset + limit);
    return { events, next_offset: offset + events.length < record.events.length ? offset + events.length : null, total_events: record.events.length,
      chain_tip_before: tips[offset - 1] ?? null, chain_tip_after: tips[offset + events.length - 1] ?? null };
  }
  async function route(request: Request): Promise<ApiResult<unknown> | null> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/record-uploads" && request.method === "POST") return await begin(await request.json().catch(() => null));
      const upload = url.pathname.match(/^\/api\/record-uploads\/([^/]+)(?:\/(chunks|finalize))?$/);
      if (upload) {
        const id = decodeURIComponent(upload[1]!);
        if (request.method === "GET" && !upload[2]) return await uploadStatus(id);
        if (request.method === "POST" && upload[2] === "chunks") return await append(id, await request.json().catch(() => null));
        if (request.method === "POST" && upload[2] === "finalize") {
          const body = await request.json().catch(() => null);
          if (!object(body) || Object.keys(body).length) invalid("invalid_payload", ["finalize requires an empty object"]);
          return await finalize(id);
        }
      }
      const read = url.pathname.match(/^\/api\/records\/([^/]+)\/(summary|events)$/);
      if (read && request.method === "GET") {
        const id = decodeURIComponent(read[1]!);
        return read[2] === "summary" ? await summary(id) : await page(id, Number(url.searchParams.get("offset") ?? 0), Number(url.searchParams.get("limit") ?? MAX_EVENT_CHUNK));
      }
      return null;
    } catch (error) {
      if (error instanceof ChunkedUploadError) return { status: error.status, body: { error: error.code, details: [error.message] } };
      if (error instanceof URIError) return { status: 400, body: { error: "invalid_path" } };
      throw error;
    }
  }
  return { route, eventPage };
}
