import {
  FORMAT_VERSION,
  computeRecordHash,
  verifyEventHashChain,
} from "../../format/src/index.ts";
import type {
  Attestation,
  BufferMutation,
  RecordManifest,
} from "../../format/src/index.ts";
import type { ClockAdapter, StorageAdapter, UuidAdapter } from "./adapters.ts";
import { resolveSession } from "./session-id.ts";
import { appendBufferMutation, durationMs } from "./timeline.ts";
import { DEFAULT_TTL_MS, DEFAULT_UPLOADED_GRACE_MS, sweepExpired } from "./ttl.ts";
import type {
  FieldDescriptor,
  FieldOrigin,
  FinalTextMetadata,
  IdentityCertainty,
  IngestRecordResponse,
  PendingMutation,
  ProducerIdentity,
  SessionId,
  SessionRecord,
  SessionState,
  SignedRecordDraft,
} from "./types.ts";
import type { CaptureContext } from "../../format/src/index.ts";

export class UnknownSessionError extends Error {
  readonly session_id: SessionId;
  constructor(session_id: SessionId) {
    super(`unknown session_id: ${session_id}`);
    this.name = "UnknownSessionError";
    this.session_id = session_id;
  }
}

export class SessionFrozenError extends Error {
  readonly session_id: SessionId;
  readonly state: SessionState;
  constructor(session_id: SessionId, state: SessionState) {
    super(`session ${session_id} cannot accept mutations while in state ${state}`);
    this.name = "SessionFrozenError";
    this.session_id = session_id;
    this.state = state;
  }
}

export type SessionRegistryOptions = {
  clock: ClockAdapter;
  uuid: UuidAdapter;
  storage: StorageAdapter;
  producer: ProducerIdentity;
};

export type AppendOptions = {
  reset_idle?: boolean;
};

export class SessionRegistry {
  readonly #clock: ClockAdapter;
  readonly #uuid: UuidAdapter;
  readonly #storage: StorageAdapter;
  readonly #producer: ProducerIdentity;
  #sessions = new Map<SessionId, SessionRecord>();

  constructor(options: SessionRegistryOptions) {
    this.#clock = options.clock;
    this.#uuid = options.uuid;
    this.#storage = options.storage;
    this.#producer = options.producer;
  }

  async init(): Promise<void> {
    const snapshot = await this.#storage.read();
    this.load(snapshot);
  }

  load(snapshot: SessionRecord[]): void {
    this.#sessions = new Map();
    for (const record of snapshot) {
      this.#sessions.set(record.session_id, cloneSession(record));
    }
  }

  snapshot(): SessionRecord[] {
    return Array.from(this.#sessions.values(), cloneSession);
  }

  list(): SessionRecord[] {
    return this.snapshot();
  }

  get(session_id: SessionId): SessionRecord | undefined {
    const record = this.#sessions.get(session_id);
    return record ? cloneSession(record) : undefined;
  }

  findOrCreate(
    origin: FieldOrigin,
    descriptor: FieldDescriptor,
    capture: CaptureContext,
  ): SessionRecord {
    const resolution = resolveSession(
      origin,
      descriptor,
      Array.from(this.#sessions.values()),
      () => this.#uuid.uuid(),
    );

    const existing = this.#sessions.get(resolution.session_id);
    if (existing && (resolution.certainty === "resumed" || resolution.certainty === "collision")) {
      existing.identity_certainty = resolution.certainty;
      existing.descriptor = descriptor;
      existing.last_edit_wall_ms = this.#clock.now();
      return cloneSession(existing);
    }

    const now = this.#clock.now();
    const record: SessionRecord = {
      session_id: resolution.session_id,
      format_version: FORMAT_VERSION,
      base_wall_ms: now,
      last_edit_wall_ms: now,
      origin,
      descriptor,
      identity_certainty: resolution.certainty,
      producer: { ...this.#producer, capabilities: [...this.#producer.capabilities] },
      capture_context: capture,
      events: [],
      state: "active",
    };
    this.#sessions.set(record.session_id, record);
    return cloneSession(record);
  }

  appendMutation(session_id: SessionId, mutation: PendingMutation, _options: AppendOptions = {}): SessionRecord {
    const record = this.#requireMutable(session_id);
    const now = this.#clock.now();
    appendBufferMutation(record.events, mutation, now, record.base_wall_ms);
    record.last_edit_wall_ms = now;
    return cloneSession(record);
  }

  sign(session_id: SessionId, final_text: FinalTextMetadata): SignedRecordDraft {
    const record = this.#requireSignable(session_id);
    if (record.events.length === 0) {
      throw new Error(`cannot sign session ${session_id} with no events`);
    }
    const events: BufferMutation[] = record.events.map((event) => ({ ...event }));
    const record_hash = computeRecordHash(events, record.session_id, record.format_version);
    const attestations: Attestation[] = [];
    const manifest: RecordManifest = {
      format_version: record.format_version,
      record_hash,
      session_id: record.session_id,
      producer: { ...record.producer, capabilities: [...record.producer.capabilities] },
      capture_context: record.capture_context,
      event_count: events.length,
      duration_ms: durationMs(events),
      final_text_hash: final_text.hash,
      final_text_length: final_text.length,
      created_client_t: new Date(record.base_wall_ms).toISOString(),
      ingested_server_t: null,
      parent_record: null,
      attestations,
    };

    const verification = verifyEventHashChain({ manifest, events });
    if (!verification.valid) {
      throw new Error(`signed record failed self-verification: ${verification.errors.join("; ")}`);
    }

    record.state = "signing";
    return { manifest, events };
  }

  markUploading(session_id: SessionId): void {
    const record = this.#requireInState(session_id, ["signing", "failed_upload"]);
    record.state = "uploading";
    record.last_failure_reason = undefined;
  }

  markUploaded(session_id: SessionId, response: IngestRecordResponse): void {
    const record = this.#requireInState(session_id, ["uploading"]);
    record.state = "uploaded";
    record.uploaded_response = response;
    record.last_edit_wall_ms = this.#clock.now();
  }

  markFailedUpload(session_id: SessionId, reason: string): void {
    const record = this.#requireInState(session_id, ["uploading", "signing"]);
    record.state = "failed_upload";
    record.last_failure_reason = reason;
  }

  sweep(options?: { ttl_ms?: number; uploaded_grace_ms?: number }): SessionRecord[] {
    const now = this.#clock.now();
    const snapshot = this.snapshot();
    const result = sweepExpired(snapshot, now, {
      ttl_ms: options?.ttl_ms ?? DEFAULT_TTL_MS,
      uploaded_grace_ms: options?.uploaded_grace_ms ?? DEFAULT_UPLOADED_GRACE_MS,
    });
    for (const removed of result.removed) this.#sessions.delete(removed.session_id);
    return result.removed;
  }

  async persist(): Promise<void> {
    await this.#storage.write(this.snapshot());
  }

  #require(session_id: SessionId): SessionRecord {
    const record = this.#sessions.get(session_id);
    if (!record) throw new UnknownSessionError(session_id);
    return record;
  }

  #requireMutable(session_id: SessionId): SessionRecord {
    const record = this.#require(session_id);
    if (record.state !== "active") throw new SessionFrozenError(session_id, record.state);
    return record;
  }

  #requireSignable(session_id: SessionId): SessionRecord {
    const record = this.#require(session_id);
    if (record.state !== "active") throw new SessionFrozenError(session_id, record.state);
    return record;
  }

  #requireInState(session_id: SessionId, allowed: SessionState[]): SessionRecord {
    const record = this.#require(session_id);
    if (!allowed.includes(record.state)) {
      throw new SessionFrozenError(session_id, record.state);
    }
    return record;
  }
}

function cloneSession(record: SessionRecord): SessionRecord {
  return {
    ...record,
    origin: { ...record.origin },
    descriptor: { ...record.descriptor },
    producer: { ...record.producer, capabilities: [...record.producer.capabilities] },
    capture_context: JSON.parse(JSON.stringify(record.capture_context)),
    events: record.events.map((event) => ({ ...event })),
    uploaded_response: record.uploaded_response ? { ...record.uploaded_response } : undefined,
  };
}

export { cloneSession };
