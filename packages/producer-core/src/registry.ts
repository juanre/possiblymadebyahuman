import {
  computeRecordHash,
  sealRecordHash,
  validateManifest,
  FORMAT_VERSION,
  FORMAT_VERSION_0_2,
  FORMAT_VERSION_0_3,
  verifyEventHashChain,
} from "../../format/src/index.ts";
import type {
  Attestation,
  B3Hash,
  BufferMutation,
  CaptureContext,
  FormatVersion,
  RecordManifest,
  TextBinding,
} from "../../format/src/index.ts";
import type {
  CheckpointAdapter,
  JournalCommit,
  CheckpointResult,
  ClockAdapter,
  StorageAdapter,
  UuidAdapter,
} from "./adapters.ts";
import { redactCaptureContext as applyCaptureContextRedactions, type CaptureContextRedactions } from "./capture-context.ts";
import { resolveSession } from "./session-id.ts";
import { advanceChain, buildNextMutation } from "./timeline.ts";
import { DEFAULT_TTL_MS, DEFAULT_UPLOADED_GRACE_MS, sweepExpired } from "./ttl.ts";
import { sessionEventCount, sessionLastEventTime } from "./types.ts";
import type {
  FieldDescriptor,
  FieldOrigin,
  IngestRecordResponse,
  ObservationLocalState,
  ObservationUploadRequest,
  ObservedCommitment,
  PendingMutation,
  ProducerIdentity,
  SessionId,
  SessionObservation,
  SessionRecord,
  SessionState,
  SignedRecordDraft,
  SignOptions,
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
  checkpoint_timeout_ms?: number;
};

export type SessionRegistryOptions = {
  clock: ClockAdapter;
  uuid: UuidAdapter;
  storage: StorageAdapter;
  producer: ProducerIdentity;
  checkpoint?: CheckpointAdapter;
  cadence?: CadenceOptions;
  /** Produce 0.3 records with a sealed finish time; legacy clients keep 0.2. */
  signedFinishTime?: boolean;
};

export type AppendOptions = {
  reset_idle?: boolean;
  /** Skip the full defensive copy when the caller only needs acknowledgement. */
  snapshot?: boolean;
  /** Time the producer observed the edit, before transport/storage queues. */
  captured_at_wall_ms?: number;
};

function validateCaptureWallTime(value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError("capture wall time must be a nonnegative safe integer");
  }
}

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
  readonly #checkpoint_timeout_ms: number;
  readonly #signedFinishTime: boolean;
  #persistRunning = false;
  #persistWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
  #dirty = new Set<SessionId>();
  #deleted = new Set<SessionId>();
  #clearEvents = new Set<SessionId>();
  #pendingEvents = new Map<SessionId, BufferMutation[]>();
  #flushing = new Set<SessionId>();
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
    this.#checkpoint_timeout_ms = options.cadence?.checkpoint_timeout_ms ?? 30_000;
    this.#signedFinishTime = options.signedFinishTime ?? false;
  }

  async init(): Promise<void> {
    const snapshot = await this.#storage.read();
    this.load(snapshot);
  }

  load(snapshot: SessionRecord[]): void {
    this.#sessions = new Map();
    this.#pendingEvents.clear();
    this.#dirty.clear();
    this.#deleted.clear();
    this.#clearEvents.clear();
    for (const record of snapshot) {
      const normalised = this.#normaliseLoadedRecord(record);
      this.#sessions.set(normalised.session_id, normalised);
      this.#dirty.add(normalised.session_id);
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

  /**
   * What the upload should say about server observation: `null` when no
   * checkpoint adapter is wired (observation not requested), the bound
   * `(observed_session_id, token)` when a commitment exists and the server's
   * view still matches ours, and `{ state: "unobserved" }` otherwise — a
   * session the server never committed, or one whose checkpoints diverged.
   * A diverged session's token stays local: binding it would only make the
   * server reject the record.
   */
  getObservationEnvelope(session_id: SessionId): ObservationUploadRequest | null {
    const record = this.#sessions.get(session_id);
    if (!record || !this.#checkpoint) return null;
    const { state, observed_session_id, last_observed_token } = record.observation;
    if (state === "diverged" || !observed_session_id || !last_observed_token) return { state: "unobserved" };
    return { observed_session_id, token: last_observed_token };
  }

  getObservationState(session_id: SessionId): ObservationLocalState | null {
    return this.#sessions.get(session_id)?.observation.state ?? null;
  }

  findOrCreate(
    origin: FieldOrigin,
    descriptor: FieldDescriptor,
    capture: CaptureContext,
    options: { fresh?: boolean; initial_content_unknown?: boolean; started_at_wall_ms?: number } = {},
  ): SessionRecord {
    validateCaptureWallTime(options.started_at_wall_ms);
    const resolution = resolveSession(
      origin,
      descriptor,
      options.fresh ? [] : Array.from(this.#sessions.values()),
      () => this.#uuid.uuid(),
    );

    const existing = this.#sessions.get(resolution.session_id);
    if (existing && (resolution.certainty === "resumed" || resolution.certainty === "collision")) {
      existing.identity_certainty = resolution.certainty;
      existing.descriptor = descriptor;
      existing.origin = { ...origin };
      existing.last_edit_wall_ms = this.#clock.now();
      this.#dirty.add(existing.session_id);
      return cloneSession(existing);
    }

    const now = options.started_at_wall_ms ?? this.#clock.now();
    const record: SessionRecord = {
      session_id: resolution.session_id,
      format_version: this.#signedFinishTime ? FORMAT_VERSION_0_3 : FORMAT_VERSION,
      base_wall_ms: now,
      last_edit_wall_ms: now,
      origin,
      descriptor,
      identity_certainty: resolution.certainty,
      producer: { ...this.#producer, capabilities: [...this.#producer.capabilities] },
      capture_context: capture,
      events: [],
      ...(this.#storage.journal ? { journaled: true as const, event_count: 0, last_event_t: 0 } : {}),
      last_event_chain_tip: null,
      state: "active",
      observation: emptyObservation(this.#checkpoint !== null),
      ...(options.initial_content_unknown ? { pending_observation_gap: true } : {}),
    };
    this.#sessions.set(record.session_id, record);
    this.#dirty.add(record.session_id);
    return cloneSession(record);
  }

  /** Explicitly reattach an unsigned draft; its original clock and hash chain survive. */
  resume(session_id: SessionId, origin: FieldOrigin, descriptor: FieldDescriptor, options: { field_is_empty?: boolean } = {}): SessionRecord {
    const record = this.#requireMutable(session_id);
    record.origin = { ...origin };
    record.descriptor = { ...descriptor };
    record.identity_certainty = "resumed";
    record.pending_observation_gap = sessionEventCount(record) > 0 || options.field_is_empty !== true;
    return cloneSession(record);
  }

  appendMutation(session_id: SessionId, mutation: PendingMutation, options: AppendOptions & { snapshot: false }): void;
  appendMutation(session_id: SessionId, mutation: PendingMutation, options?: AppendOptions & { snapshot?: true }): SessionRecord;
  appendMutation(session_id: SessionId, mutation: PendingMutation, options: AppendOptions = {}): SessionRecord | void {
    validateCaptureWallTime(options.captured_at_wall_ms);
    const record = this.#requireMutable(session_id);
    const now = options.captured_at_wall_ms ?? this.#clock.now();
    const observedMutation = record.pending_observation_gap ? { ...mutation, pos: null } : mutation;
    const pending = this.#pendingEvents.get(session_id) ?? [];
    if (this.#storage.journal && pending.length >= 4096) throw new Error("Local journal is not keeping up. Capture stopped before accepting more events; save the pending edits before continuing.");
    const event = buildNextMutation(observedMutation, sessionEventCount(record), sessionLastEventTime(record), now, record.base_wall_ms);
    const chainTip = advanceChain(
      record.last_event_chain_tip,
      event,
      record.session_id,
      record.format_version,
    );
    if (this.#storage.journal) {
      pending.push(event);
      this.#pendingEvents.set(session_id, pending);
      record.event_count = event.seq + 1;
      record.last_event_t = event.t;
    } else record.events.push(event);
    record.last_event_chain_tip = chainTip;
    delete record.pending_observation_gap;
    record.last_edit_wall_ms = Math.max(record.last_edit_wall_ms, now);
    this.#recomputeObservationState(record);
    this.#maybeTriggerCheckpoint(record);
    if (options.snapshot !== false) return cloneSession(record);
  }

  #recomputeObservationState(record: SessionRecord): void {
    if (!this.#checkpoint) return;
    if (record.observation.state === "diverged") return;
    if (record.observation.last_committed_event_count === 0) {
      record.observation.state = "unknown";
      return;
    }
    record.observation.state = record.observation.last_committed_event_count >= sessionEventCount(record)
      ? "known"
      : "partial";
  }

  /**
   * Signs an active session, or re-signs one whose upload failed so the same
   * record can be retried. A retry reuses the binding sealed the first time.
   */
  sign(session_id: SessionId, options: SignOptions = {}): SignedRecordDraft {
    const record = this.#requireInState(session_id, ["active", "failed_upload"]);
    if (sessionEventCount(record) === 0) {
      throw new Error(`cannot sign session ${session_id} with no events`);
    }
    const events: BufferMutation[] = this.#storage.journal ? [] : record.events.map((event) => ({ ...event }));
    const retry = record.state === "failed_upload";
    const textBinding = retry ? record.signed_text_binding : options.textBinding;
    // Upgrade unsigned 0.2 drafts without replacing their event-chain or any
    // server checkpoints. Legacy failed uploads must retry their original hash.
    const formatVersion = this.#signedFinishTime && !retry && record.format_version === FORMAT_VERSION_0_2
      ? FORMAT_VERSION_0_3 : record.format_version;
    const duration = retry && record.signed_duration_ms !== undefined ? record.signed_duration_ms
      : formatVersion === FORMAT_VERSION_0_3 ? Math.max(sessionLastEventTime(record), this.#clock.now() - record.base_wall_ms)
      : sessionLastEventTime(record);
    // When a binding is present the record hash is sealed over it; otherwise
    // it is the plain event-chain tip (the cached tip when available).
    const record_hash = this.#storage.journal
      ? sealRecordHash(record.last_event_chain_tip!, formatVersion, textBinding, { duration_ms: duration, parent_record: record.parent_record })
      : textBinding || formatVersion === FORMAT_VERSION_0_3
      ? computeRecordHash(events, record.session_id, formatVersion, textBinding, { duration_ms: duration, parent_record: record.parent_record })
      : record.last_event_chain_tip ?? this.#chainHeadFromEvents(events, record.session_id, formatVersion);
    const attestations: Attestation[] = [];
    const manifest: RecordManifest = {
      format_version: formatVersion,
      record_hash,
      session_id: record.session_id,
      producer: { ...record.producer, capabilities: [...record.producer.capabilities] },
      capture_context: record.capture_context,
      ...(textBinding ? { text_binding: textBinding } : {}),
      event_count: sessionEventCount(record),
      duration_ms: duration,
      created_client_t: new Date(record.base_wall_ms).toISOString(),
      ingested_server_t: null,
      parent_record: record.parent_record ?? null,
      attestations,
    };

    const verification = this.#storage.journal
      ? { valid: validateManifest(manifest).length === 0, errors: validateManifest(manifest) }
      : verifyEventHashChain({ manifest, events });
    if (!verification.valid) {
      throw new Error(`signed record failed self-verification: ${verification.errors.join("; ")}`);
    }

    record.state = "signing";
    record.format_version = formatVersion;
    record.signed_text_binding = textBinding;
    record.signed_duration_ms = duration;
    if (this.#storage.journal) record.upload_id ??= this.#uuid.uuid();
    return { manifest, events, ...(record.upload_id ? { upload_id: record.upload_id } : {}) };
  }

  /** Applies the signer's capture-context choices before the record is signed. */
  redactCaptureContext(session_id: SessionId, redactions: CaptureContextRedactions): SessionRecord {
    const record = this.#requireInState(session_id, ["active"]);
    record.capture_context = applyCaptureContextRedactions(record.capture_context, redactions);
    return cloneSession(record);
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
   * Records the server's rejection of the observation bound on an upload, so a
   * retry does not bind the same token again. `observation_mismatch` (the
   * stored checkpoints do not match the final record) pins the session
   * `diverged`; `observation_unavailable` (the observed session is gone)
   * resets observation. Either way the retry uploads as unobserved.
   */
  markObservationRejected(session_id: SessionId, code: "observation_mismatch" | "observation_unavailable"): void {
    const record = this.#requireInState(session_id, ["uploading", "failed_upload"]);
    record.observation.last_failure = { reason: code, status_or_kind: code === "observation_mismatch" ? "409" : "404" };
    if (code === "observation_unavailable") {
      this.#resetObservation(record);
      return;
    }
    record.observation.state = "diverged";
    record.observation.next_backoff_ms = 0;
  }

  /**
   * Starts a new session for a field whose previous session was signed and
   * uploaded. The signed session stays frozen with its link; the new session
   * records only the further edits and names the uploaded record as its
   * parent, so a later signature says which record it continues from.
   */
  continueFrom(
    session_id: SessionId,
    location: { origin?: FieldOrigin; descriptor?: FieldDescriptor } = {},
  ): SessionRecord {
    const previous = this.#requireInState(session_id, ["uploaded"]);
    if (!previous.uploaded_response) {
      throw new Error(`uploaded session ${session_id} has no upload response to continue from`);
    }
    const parentHash = previous.uploaded_response.record_hash;
    // Edits arriving before the field learned its continuation id, or a field
    // re-registering while the signed session is still listed, must all land in
    // the one continuation of that record.
    const existing = Array.from(this.#sessions.values()).find(
      (record) => record.state === "active" && record.parent_record === parentHash,
    );
    if (existing) {
      if (location.origin) existing.origin = { ...location.origin };
      if (location.descriptor) existing.descriptor = { ...location.descriptor };
      existing.last_edit_wall_ms = this.#clock.now();
      this.#dirty.add(existing.session_id);
      return cloneSession(existing);
    }
    const now = this.#clock.now();
    // A new explicit segment starts at the previous finish, preserving the
    // pause before the next real edit. Old anchors have no sealed finish;
    // their retained local upload time is the only available legacy boundary.
    const priorFinish = previous.format_version === FORMAT_VERSION_0_3 && previous.signed_duration_ms !== undefined
      ? previous.base_wall_ms + previous.signed_duration_ms : previous.last_edit_wall_ms;
    const record: SessionRecord = {
      session_id: this.#uuid.uuid(),
      format_version: this.#signedFinishTime ? FORMAT_VERSION_0_3 : FORMAT_VERSION,
      base_wall_ms: this.#signedFinishTime ? priorFinish : now,
      last_edit_wall_ms: now,
      origin: { ...(location.origin ?? previous.origin) },
      descriptor: { ...(location.descriptor ?? previous.descriptor) },
      identity_certainty: "resumed",
      producer: { ...this.#producer, capabilities: [...this.#producer.capabilities] },
      capture_context: JSON.parse(JSON.stringify(previous.capture_context)),
      events: [],
      ...(this.#storage.journal ? { journaled: true as const, event_count: 0, last_event_t: 0 } : {}),
      last_event_chain_tip: null,
      state: "active",
      parent_record: parentHash,
      ...(this.#signedFinishTime ? { pending_observation_gap: true } : {}),
      observation: emptyObservation(this.#checkpoint !== null),
    };
    this.#sessions.set(record.session_id, record);
    this.#dirty.add(record.session_id);
    return cloneSession(record);
  }

  /**
   * Drops a specific session immediately. User-driven (e.g. "discard this draft"
   * from a popup), distinct from the time-based `sweep`. Returns the removed
   * record so callers can persist a tombstone or surface a confirmation.
   * Returns `null` if the session id is not in the registry.
   *
   * In-flight checkpoint caveat: if a checkpoint POST was in flight at the
   * moment of discard, the request continues on the server side and may
   * succeed, leaving server-side checkpoint metadata after local discard.
   * The local registry stays consistent: no further checkpoints will fire.
   * Local discard does not delete server data. The retained metadata contains only
   * (observed_session_id, event_count, chain_tip) — no text or text-derived
   * hashes are involved.
   */
  discard(session_id: SessionId): SessionRecord | null {
    const existing = this.#sessions.get(session_id);
    if (!existing) return null;
    const cloned = cloneSession(existing);
    this.#sessions.delete(session_id);
    this.#deleted.add(session_id);
    this.#dirty.delete(session_id);
    this.#pendingEvents.delete(session_id);
    this.#inFlight.delete(session_id);
    return cloned;
  }

  /** Remove local records only after storage accepts the change; retain links on failure. */
  async discardPersisted(session_ids: SessionId[]): Promise<void> {
    // Settle accepted prefixes before detaching their queues. Rollback must
    // never reintroduce events whose earlier transaction already committed.
    await this.persist();
    const pending = new Map(session_ids.map(id => [id, this.#pendingEvents.get(id)]));
    const removed = session_ids.map((id) => this.discard(id)).filter((record): record is SessionRecord => record !== null);
    try {
      await this.persist();
    } catch (error) {
      // Restore only the removed records. Edits to other sessions that arrived
      // while storage was pending must not be overwritten by an old snapshot.
      for (const record of removed) {
        if (!this.#sessions.has(record.session_id)) {
          this.#sessions.set(record.session_id, record);
          this.#deleted.delete(record.session_id);
          this.#dirty.add(record.session_id);
          const events = pending.get(record.session_id);
          if (events) this.#pendingEvents.set(record.session_id, events);
        }
      }
      // A concurrent checkpoint may have queued a snapshot while the records
      // were absent. Queue the restored view after it before surfacing failure.
      await this.persist().catch(() => undefined);
      throw error;
    }
  }

  sweep(options?: { ttl_ms?: number; uploaded_grace_ms?: number; retain_uploaded_anchors?: boolean }): SessionRecord[] {
    const now = this.#clock.now();
    const snapshot = this.snapshot();
    const result = sweepExpired(snapshot, now, {
      ttl_ms: options?.ttl_ms ?? DEFAULT_TTL_MS,
      uploaded_grace_ms: options?.uploaded_grace_ms ?? DEFAULT_UPLOADED_GRACE_MS,
    });
    const removedLogs: SessionRecord[] = [];
    for (const removed of result.removed) {
      if (options?.retain_uploaded_anchors && removed.state === "uploaded"
        && now - removed.last_edit_wall_ms < (options.ttl_ms ?? DEFAULT_TTL_MS)) {
        // Keep identity, public link and binding outcome for the browser
        // result view. Event logs and private observation tokens are purged.
        this.#sessions.set(removed.session_id, {
          ...removed,
          events: [],
          continuation_anchor: true,
          last_event_chain_tip: null,
          observation: emptyObservation(this.#checkpoint !== null),
        });
        this.#clearEvents.add(removed.session_id);
        this.#dirty.add(removed.session_id);
        continue;
      }
      removedLogs.push(removed);
      this.#sessions.delete(removed.session_id);
      this.#deleted.add(removed.session_id);
      this.#dirty.delete(removed.session_id);
      this.#pendingEvents.delete(removed.session_id);
      this.#inFlight.delete(removed.session_id);
    }
    return removedLogs;
  }

  persist(): Promise<void> {
    const result = new Promise<void>((resolve, reject) => { this.#persistWaiters.push({ resolve, reject }); });
    if (!this.#persistRunning) {
      this.#persistRunning = true;
      void this.#drainPersistence();
    }
    return result;
  }

  async #drainPersistence(): Promise<void> {
    try {
      while (this.#persistWaiters.length) {
        const waiters = this.#persistWaiters.splice(0);
        try {
          // Snapshot when the serialized write starts. Calls arriving during
          // it share the next snapshot, never retain queued history copies.
          if (this.#storage.journal) await this.#persistJournal();
          else await this.#storage.write(this.snapshot());
          for (const waiter of waiters) waiter.resolve();
        } catch (error) {
          for (const waiter of waiters) waiter.reject(error);
        }
      }
    } finally { this.#persistRunning = false; }
  }

  async #persistJournal(): Promise<void> {
    const ids = [...this.#dirty];
    const deleted = [...this.#deleted];
    const clear_events = [...this.#clearEvents];
    if (!ids.length && !deleted.length && !clear_events.length) return;
    const batch: JournalCommit = {
      sessions: ids.flatMap(id => { const session = this.#sessions.get(id); return session ? [cloneSession(session)] : []; }),
      appends: ids.flatMap(id => { const events = this.#pendingEvents.get(id); return events?.length ? [{ session_id: id, events: events.slice() }] : []; }),
      deleted, clear_events,
    };
    for (const id of ids) this.#dirty.delete(id);
    for (const id of deleted) this.#deleted.delete(id);
    for (const id of clear_events) this.#clearEvents.delete(id);
    try {
      await this.#storage.journal!.commit(batch);
      for (const append of batch.appends) this.#pendingEvents.get(append.session_id)?.splice(0, append.events.length);
    } catch (error) {
      for (const id of ids) this.#dirty.add(id);
      for (const id of deleted) this.#deleted.add(id);
      for (const id of clear_events) this.#clearEvents.add(id);
      throw error;
    }
  }

  /** Bounded history access for publication/export. UI uses metadata get/list. */
  async readEvents(session_id: SessionId, start_seq: number, limit = 512): Promise<BufferMutation[]> {
    if (!Number.isSafeInteger(start_seq) || start_seq < 0 || !Number.isInteger(limit) || limit < 1 || limit > 4096) throw new RangeError("invalid event page");
    const record = this.#sessions.get(session_id);
    if (!record) throw new UnknownSessionError(session_id);
    if (this.#storage.journal) {
      await this.persist();
      return this.#storage.journal.readEvents(session_id, start_seq, limit);
    }
    return record.events.slice(start_seq, start_seq + limit).map(event => ({ ...event }));
  }

  get journaled(): boolean { return !!this.#storage.journal; }

  /** Awaits all checkpoint work currently in-flight or queued for a session. Test helper. */
  async awaitObservationIdle(session_id: SessionId): Promise<void> {
    let inflight = this.#inFlight.get(session_id);
    while (inflight) {
      await inflight.catch(() => undefined);
      inflight = this.#inFlight.get(session_id);
    }
  }

  /**
   * Completes server observation of an already-observed session before
   * sign() + upload, so the final commitment covers every event. The first
   * round awaits the in-flight checkpoint or kicks one for the uncommitted
   * tail; a second round covers events that arrived while the first was in
   * flight. A session the server has never committed is left alone: a
   * commitment minted at sign time would observe nothing of the writing, and
   * the upload carries `{ state: "unobserved" }` instead. A checkpoint this
   * flush kicked is not retried on failure (an inherited in-flight one that
   * fails still gets the flush's own attempt); the consumer reads
   * `getObservationEnvelope()` for what to bind.
   */
  async flushObservation(session_id: SessionId): Promise<void> {
    if (!this.#checkpoint) return;
    this.#flushing.add(session_id);
    try {
      let kicked = false;
      for (let round = 0; round < 2; round++) {
        const record = this.#sessions.get(session_id);
        if (!record || record.observation.state === "diverged") return;
        if (kicked && record.observation.last_failure) return;
        if (!record.observation.in_flight) {
          if (record.observation.last_committed_event_count === 0) return;
          if (sessionEventCount(record) <= record.observation.last_committed_event_count) return;
          record.observation.next_backoff_ms = 0;
          this.#kickCheckpoint(record);
          kicked = true;
        }
        await this.awaitObservationIdle(session_id);
      }
    } finally {
      this.#flushing.delete(session_id);
    }
  }

  #normaliseLoadedRecord(record: SessionRecord): SessionRecord {
    const cloned = cloneSession(record);
    // These states describe work owned by the previous process. Its outcome
    // may be unknown, so keep the signed events/binding frozen for an exact
    // idempotent retry rather than leave the draft permanently busy or reopen it.
    if (cloned.state === "signing" || cloned.state === "uploading") {
      cloned.state = "failed_upload";
      cloned.last_failure_reason = "Saving was interrupted. Retry to recover the same signed record.";
    }
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

  #chainHeadFromEvents(events: BufferMutation[], session_id: SessionId, formatVersion: FormatVersion): B3Hash {
    let tip: B3Hash | null = null;
    for (const event of events) {
      tip = advanceChain(tip, event, session_id, formatVersion);
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
    const delta = sessionEventCount(record) - record.observation.last_committed_event_count;
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
    this.#dirty.add(record.session_id);
    record.observation.in_flight = true;
    record.observation.queued = false;
    record.observation.last_attempt_at_wall_ms = this.#clock.now();
    const promise = this.#runCheckpointLoop(record.session_id);
    this.#inFlight.set(record.session_id, promise);
    void promise.catch(() => undefined).finally(() => {
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
      const event_count = sessionEventCount(record);
      const chain_tip = record.last_event_chain_tip;
      if (!chain_tip) {
        record.observation.in_flight = false;
        return;
      }
      const token = record.observation.last_observed_token;
      let result: CheckpointResult;
      try {
        result = await this.#postCheckpoint({
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
      this.#dirty.add(session_id);
      this.#applyCheckpointResult(liveRecord, observed_session_id, event_count, chain_tip, result);
      if (!result.ok) {
        // Failure (transient, rate_limited, conflict, client_bug, unavailable): do not
        // immediately drain queued work — that would bypass `next_backoff_ms`. Future
        // appendMutation triggers will re-evaluate via #shouldTrigger.
        liveRecord.observation.in_flight = false;
        liveRecord.observation.queued = false;
        await this.persist();
        return;
      }
      if (!this.#flushing.has(session_id) && liveRecord.observation.queued && (sessionEventCount(liveRecord) - liveRecord.observation.last_committed_event_count) > 0) {
        liveRecord.observation.queued = false;
        liveRecord.observation.last_attempt_at_wall_ms = this.#clock.now();
        await this.persist();
        continue;
      }
      liveRecord.observation.in_flight = false;
      liveRecord.observation.queued = false;
      await this.persist();
      return;
    }
  }

  async #postCheckpoint(request: Parameters<CheckpointAdapter["postCheckpoint"]>[0]): Promise<CheckpointResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<CheckpointResult>((resolve) => {
      timer = setTimeout(() => {
        resolve({ ok: false, kind: "transient", status: 0, reason: "checkpoint_timeout" });
        controller.abort();
      }, this.#checkpoint_timeout_ms);
    });
    try {
      // Racing the whole adapter also bounds reading a stalled response body.
      // A late response cannot mutate the session after the deadline wins.
      return await Promise.race([this.#checkpoint!.postCheckpoint(request, controller.signal), deadline]);
    } finally {
      clearTimeout(timer);
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
      record.observation.state = record.observation.last_committed_event_count >= sessionEventCount(record)
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
    } else if (record.observation.last_committed_event_count < sessionEventCount(record)) {
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
    this.#dirty.add(session_id);
    return record;
  }

  #requireMutable(session_id: SessionId): SessionRecord {
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
