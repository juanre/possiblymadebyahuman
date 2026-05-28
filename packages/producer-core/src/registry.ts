import {
  FORMAT_VERSION,
  verifyEventHashChain,
} from "../../format/src/index.ts";
import type {
  Attestation,
  B3Hash,
  BufferMutation,
  CaptureContext,
  RecordManifest,
} from "../../format/src/index.ts";
import type {
  CheckpointAdapter,
  CheckpointResult,
  ClockAdapter,
  StorageAdapter,
  UuidAdapter,
} from "./adapters.ts";
import { resolveSession } from "./session-id.ts";
import { advanceChain, appendBufferMutation, durationMs } from "./timeline.ts";
import { DEFAULT_TTL_MS, DEFAULT_UPLOADED_GRACE_MS, sweepExpired } from "./ttl.ts";
import type {
  FieldDescriptor,
  FieldOrigin,
  IngestRecordResponse,
  ObservationEnvelope,
  ObservationLocalState,
  ObservedCommitment,
  PendingMutation,
  ProducerIdentity,
  SessionId,
  SessionObservation,
  SessionRecord,
  SessionState,
  SignedRecordDraft,
} from "./types.ts";

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

export const DEFAULT_CADENCE_EVERY_N_EVENTS = 50;
export const DEFAULT_CADENCE_EVERY_MS = 60_000;
export const DEFAULT_CHECKPOINT_BACKOFF_INITIAL_MS = 1_000;
export const DEFAULT_CHECKPOINT_BACKOFF_MAX_MS = 60_000;
export const DEFAULT_COMMITMENT_RETENTION = 32;

export type CadenceOptions = {
  every_n_events?: number;
  every_ms?: number;
  backoff_initial_ms?: number;
  backoff_max_ms?: number;
  commitment_retention?: number;
};

export type SessionRegistryOptions = {
  clock: ClockAdapter;
  uuid: UuidAdapter;
  storage: StorageAdapter;
  producer: ProducerIdentity;
  checkpoint?: CheckpointAdapter;
  cadence?: CadenceOptions;
};

export type AppendOptions = {
  reset_idle?: boolean;
};

export class SessionRegistry {
  readonly #clock: ClockAdapter;
  readonly #uuid: UuidAdapter;
  readonly #storage: StorageAdapter;
  readonly #producer: ProducerIdentity;
  readonly #checkpoint: CheckpointAdapter | null;
  readonly #every_n_events: number;
  readonly #every_ms: number;
  readonly #backoff_initial_ms: number;
  readonly #backoff_max_ms: number;
  readonly #commitment_retention: number;
  #sessions = new Map<SessionId, SessionRecord>();
  #inFlight = new Map<SessionId, Promise<void>>();

  constructor(options: SessionRegistryOptions) {
    this.#clock = options.clock;
    this.#uuid = options.uuid;
    this.#storage = options.storage;
    this.#producer = options.producer;
    this.#checkpoint = options.checkpoint ?? null;
    this.#every_n_events = options.cadence?.every_n_events ?? DEFAULT_CADENCE_EVERY_N_EVENTS;
    this.#every_ms = options.cadence?.every_ms ?? DEFAULT_CADENCE_EVERY_MS;
    this.#backoff_initial_ms = options.cadence?.backoff_initial_ms ?? DEFAULT_CHECKPOINT_BACKOFF_INITIAL_MS;
    this.#backoff_max_ms = options.cadence?.backoff_max_ms ?? DEFAULT_CHECKPOINT_BACKOFF_MAX_MS;
    this.#commitment_retention = options.cadence?.commitment_retention ?? DEFAULT_COMMITMENT_RETENTION;
  }

  async init(): Promise<void> {
    const snapshot = await this.#storage.read();
    this.load(snapshot);
  }

  load(snapshot: SessionRecord[]): void {
    this.#sessions = new Map();
    for (const record of snapshot) {
      const normalised = this.#normaliseLoadedRecord(record);
      this.#sessions.set(normalised.session_id, normalised);
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

  getObservationEnvelope(session_id: SessionId): ObservationEnvelope | null {
    const record = this.#sessions.get(session_id);
    if (!record) return null;
    const { observed_session_id, last_observed_token } = record.observation;
    if (!observed_session_id || !last_observed_token) return null;
    return { observed_session_id, token: last_observed_token };
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
      last_event_chain_tip: null,
      state: "active",
      observation: emptyObservation(this.#checkpoint !== null),
    };
    this.#sessions.set(record.session_id, record);
    return cloneSession(record);
  }

  appendMutation(session_id: SessionId, mutation: PendingMutation, _options: AppendOptions = {}): SessionRecord {
    const record = this.#requireMutable(session_id);
    const now = this.#clock.now();
    const event = appendBufferMutation(record.events, mutation, now, record.base_wall_ms);
    record.last_event_chain_tip = advanceChain(
      record.last_event_chain_tip,
      event,
      record.session_id,
      record.format_version,
    );
    record.last_edit_wall_ms = now;
    this.#recomputeObservationState(record);
    this.#maybeTriggerCheckpoint(record);
    return cloneSession(record);
  }

  #recomputeObservationState(record: SessionRecord): void {
    if (!this.#checkpoint) return;
    if (record.observation.state === "diverged") return;
    if (record.observation.last_committed_event_count === 0) {
      record.observation.state = "unknown";
      return;
    }
    record.observation.state = record.observation.last_committed_event_count >= record.events.length
      ? "known"
      : "partial";
  }

  sign(session_id: SessionId): SignedRecordDraft {
    const record = this.#requireSignable(session_id);
    if (record.events.length === 0) {
      throw new Error(`cannot sign session ${session_id} with no events`);
    }
    const events: BufferMutation[] = record.events.map((event) => ({ ...event }));
    const record_hash = record.last_event_chain_tip ?? this.#chainHeadFromEvents(events, record.session_id);
    const attestations: Attestation[] = [];
    const manifest: RecordManifest = {
      format_version: record.format_version,
      record_hash,
      session_id: record.session_id,
      producer: { ...record.producer, capabilities: [...record.producer.capabilities] },
      capture_context: record.capture_context,
      event_count: events.length,
      duration_ms: durationMs(events),
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

  /**
   * Drops a specific session immediately. User-driven (e.g. "discard this draft"
   * from a popup), distinct from the time-based `sweep`. Returns the removed
   * record so callers can persist a tombstone or surface a confirmation.
   * Returns `null` if the session id is not in the registry.
   */
  discard(session_id: SessionId): SessionRecord | null {
    const existing = this.#sessions.get(session_id);
    if (!existing) return null;
    const cloned = cloneSession(existing);
    this.#sessions.delete(session_id);
    this.#inFlight.delete(session_id);
    return cloned;
  }

  sweep(options?: { ttl_ms?: number; uploaded_grace_ms?: number }): SessionRecord[] {
    const now = this.#clock.now();
    const snapshot = this.snapshot();
    const result = sweepExpired(snapshot, now, {
      ttl_ms: options?.ttl_ms ?? DEFAULT_TTL_MS,
      uploaded_grace_ms: options?.uploaded_grace_ms ?? DEFAULT_UPLOADED_GRACE_MS,
    });
    for (const removed of result.removed) {
      this.#sessions.delete(removed.session_id);
      this.#inFlight.delete(removed.session_id);
    }
    return result.removed;
  }

  async persist(): Promise<void> {
    await this.#storage.write(this.snapshot());
  }

  /** Awaits all checkpoint work currently in-flight or queued for a session. Test helper. */
  async awaitObservationIdle(session_id: SessionId): Promise<void> {
    let inflight = this.#inFlight.get(session_id);
    while (inflight) {
      await inflight.catch(() => undefined);
      inflight = this.#inFlight.get(session_id);
    }
  }

  /**
   * Kicks one checkpoint covering uncheckpointed events and awaits it.
   * Producers call this before sign() + upload so the server has a final commitment.
   * Does not retry on transient failure; the consumer reads observation state and
   * decides whether to bind a (possibly stale) envelope on the upload.
   */
  async flushObservation(session_id: SessionId): Promise<void> {
    if (!this.#checkpoint) return;
    const record = this.#sessions.get(session_id);
    if (!record) return;
    if (record.observation.state === "diverged") return;
    const pending = record.events.length - record.observation.last_committed_event_count;
    if (pending <= 0 && !record.observation.in_flight) return;
    if (pending > 0 && !record.observation.in_flight) {
      record.observation.next_backoff_ms = 0;
      this.#kickCheckpoint(record);
    }
    await this.awaitObservationIdle(session_id);
  }

  #normaliseLoadedRecord(record: SessionRecord): SessionRecord {
    const cloned = cloneSession(record);
    if (!cloned.observation) {
      cloned.observation = emptyObservation(this.#checkpoint !== null);
    } else {
      // Reset transient flags on load — in-flight from a previous process is not in-flight now.
      cloned.observation.in_flight = false;
      cloned.observation.queued = false;
      cloned.observation.next_backoff_ms = 0;
    }
    if (cloned.last_event_chain_tip === undefined) cloned.last_event_chain_tip = null;
    return cloned;
  }

  #chainHeadFromEvents(events: BufferMutation[], session_id: SessionId): B3Hash {
    let tip: B3Hash | null = null;
    for (const event of events) {
      tip = advanceChain(tip, event, session_id, FORMAT_VERSION);
    }
    return tip as B3Hash;
  }

  #maybeTriggerCheckpoint(record: SessionRecord): void {
    if (!this.#checkpoint) return;
    if (record.observation.state === "diverged") return;
    const now = this.#clock.now();
    if (!this.#shouldTrigger(record, now)) return;
    if (record.observation.in_flight) {
      record.observation.queued = true;
      return;
    }
    this.#kickCheckpoint(record);
  }

  #shouldTrigger(record: SessionRecord, now: number): boolean {
    const delta = record.events.length - record.observation.last_committed_event_count;
    if (delta <= 0) return false;
    // Honour backoff: do not retry transient failures faster than the schedule.
    if (
      record.observation.next_backoff_ms > 0
      && record.observation.last_attempt_at_wall_ms !== null
      && now - record.observation.last_attempt_at_wall_ms < record.observation.next_backoff_ms
    ) {
      return false;
    }
    if (record.observation.last_committed_event_count === 0) return true; // first-mutation immediate
    if (delta >= this.#every_n_events) return true;
    const sinceLast = record.observation.last_attempt_at_wall_ms === null
      ? Infinity
      : now - record.observation.last_attempt_at_wall_ms;
    if (sinceLast >= this.#every_ms) return true;
    return false;
  }

  #kickCheckpoint(record: SessionRecord): void {
    record.observation.in_flight = true;
    record.observation.queued = false;
    record.observation.last_attempt_at_wall_ms = this.#clock.now();
    const promise = this.#runCheckpointLoop(record.session_id);
    this.#inFlight.set(record.session_id, promise);
    void promise.finally(() => {
      const current = this.#inFlight.get(record.session_id);
      if (current === promise) this.#inFlight.delete(record.session_id);
    });
  }

  async #runCheckpointLoop(session_id: SessionId): Promise<void> {
    // The loop runs the queued checkpoint chain. We re-read the record each iteration
    // because appendMutation may mutate it between awaits.
    while (true) {
      const record = this.#sessions.get(session_id);
      if (!record) return;
      const observed_session_id = record.observation.observed_session_id ?? this.#uuid.uuid();
      const event_count = record.events.length;
      const chain_tip = record.last_event_chain_tip;
      if (!chain_tip) {
        record.observation.in_flight = false;
        return;
      }
      const token = record.observation.last_observed_token;
      let result: CheckpointResult;
      try {
        result = await this.#checkpoint!.postCheckpoint({
          observed_session_id,
          event_count,
          chain_tip,
          token,
        });
      } catch (error) {
        result = {
          ok: false,
          kind: "transient",
          status: 0,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      const liveRecord = this.#sessions.get(session_id);
      if (!liveRecord) return;
      this.#applyCheckpointResult(liveRecord, observed_session_id, event_count, chain_tip, result);
      if (!result.ok) {
        // Failure (transient, rate_limited, conflict, client_bug, unavailable): do not
        // immediately drain queued work — that would bypass `next_backoff_ms`. Future
        // appendMutation triggers will re-evaluate via #shouldTrigger.
        liveRecord.observation.in_flight = false;
        liveRecord.observation.queued = false;
        return;
      }
      if (liveRecord.observation.queued && (liveRecord.events.length - liveRecord.observation.last_committed_event_count) > 0) {
        liveRecord.observation.queued = false;
        liveRecord.observation.last_attempt_at_wall_ms = this.#clock.now();
        continue;
      }
      liveRecord.observation.in_flight = false;
      liveRecord.observation.queued = false;
      return;
    }
  }

  #applyCheckpointResult(
    record: SessionRecord,
    observed_session_id: string,
    sent_event_count: number,
    sent_chain_tip: B3Hash,
    result: CheckpointResult,
  ): void {
    if (result.ok) {
      record.observation.observed_session_id = result.response.observed_session_id;
      record.observation.last_observed_token = result.response.token;
      const newCount = Math.max(record.observation.last_committed_event_count, result.response.event_count);
      record.observation.last_committed_event_count = newCount;
      record.observation.last_failure = null;
      record.observation.next_backoff_ms = 0;
      this.#mergeCommitment(record, {
        checkpoint_id: result.response.checkpoint_id,
        event_count: result.response.event_count,
        chain_tip: result.response.chain_tip,
        observed_at: result.response.server_t,
      });
      record.observation.state = record.observation.last_committed_event_count >= record.events.length
        ? "known"
        : "partial";
      return;
    }
    record.observation.last_failure = { reason: result.reason, status_or_kind: `${result.status}` };
    if (result.kind === "unavailable") {
      this.#resetObservation(record);
      return;
    }
    if (result.kind === "conflict" || result.kind === "client_bug") {
      record.observation.state = "diverged";
      record.observation.next_backoff_ms = 0;
      return;
    }
    // transient / rate_limited: stay in current state, advance backoff
    // (initial on first failure; double on each subsequent failure; capped).
    record.observation.next_backoff_ms = record.observation.next_backoff_ms === 0
      ? this.#backoff_initial_ms
      : Math.min(this.#backoff_max_ms, record.observation.next_backoff_ms * 2);
    if (record.observation.last_committed_event_count === 0) {
      record.observation.state = "unknown";
    } else if (record.observation.last_committed_event_count < record.events.length) {
      record.observation.state = "partial";
    }
    // ignore sent values when failed
    void observed_session_id;
    void sent_event_count;
    void sent_chain_tip;
  }

  #resetObservation(record: SessionRecord): void {
    record.observation.commitments = [];
    record.observation.observed_session_id = null;
    record.observation.last_observed_token = null;
    record.observation.last_committed_event_count = 0;
    record.observation.next_backoff_ms = 0;
    record.observation.in_flight = false;
    record.observation.queued = false;
    record.observation.state = "unknown";
  }

  #mergeCommitment(record: SessionRecord, commitment: ObservedCommitment): void {
    const existing = record.observation.commitments.find((entry) => entry.event_count === commitment.event_count);
    if (existing) {
      existing.checkpoint_id = commitment.checkpoint_id;
      existing.chain_tip = commitment.chain_tip;
      existing.observed_at = commitment.observed_at;
    } else {
      record.observation.commitments.push(commitment);
      record.observation.commitments.sort((left, right) => left.event_count - right.event_count);
    }
    this.#evictOlderCommitments(record);
  }

  #evictOlderCommitments(record: SessionRecord): void {
    const list = record.observation.commitments;
    const watermark = this.#commitment_retention;
    if (list.length <= watermark) return;
    const oldest = list[0]!;
    const tail = list.slice(list.length - (watermark - 1));
    record.observation.commitments = [oldest, ...tail];
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

function emptyObservation(checkpointWired: boolean): SessionObservation {
  return {
    state: checkpointWired ? "unknown" : "disabled",
    commitments: [],
    observed_session_id: null,
    last_observed_token: null,
    last_committed_event_count: 0,
    last_attempt_at_wall_ms: null,
    last_failure: null,
    in_flight: false,
    queued: false,
    next_backoff_ms: 0,
  };
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
    observation: {
      ...record.observation,
      commitments: record.observation.commitments.map((entry) => ({ ...entry })),
      last_failure: record.observation.last_failure ? { ...record.observation.last_failure } : null,
    },
  };
}

export { cloneSession };
export type { ObservationLocalState };
