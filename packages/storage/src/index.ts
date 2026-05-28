import { computeEventHashChain, type B3Hash, type EventLog, type JsonValue, type RecordManifest, type Signal, type WritingRecord } from "../../format/src/index.ts";

export type RecordStats = {
  record_hash: B3Hash;
  event_count: number;
  duration_ms: number;
  observed_final_length: number | null;
  insert_op_count: number;
  delete_op_count: number;
  replace_op_count: number;
  typed_event_count: number;
  paste_event_count: number;
  cut_event_count: number;
  drop_event_count: number;
  ime_event_count: number;
  autocomplete_event_count: number;
  programmatic_event_count: number;
  unknown_source_count: number;
  inserted_codepoints_total: number;
  deleted_codepoints_total: number;
  largest_atomic_insert_codepoints: number;
  inter_event_delay_min_ms: number | null;
  inter_event_delay_p50_ms: number | null;
  inter_event_delay_p90_ms: number | null;
  inter_event_delay_p95_ms: number | null;
  inter_event_delay_p99_ms: number | null;
  inter_event_delay_max_ms: number | null;
  active_time_ms: number;
  idle_time_ms: number;
  long_pause_count: number;
  delay_histogram: Array<{ bucket: string; count: number }>;
};

export type AnalysisResult = Signal & {
  id?: string;
  record_hash: B3Hash;
  created_at?: string;
};

export const OBSERVED_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type ObservationState = "observed" | "partial" | "unobserved" | "not_requested";
export type BoundObservationState = "observed" | "partial";

export type ObservationCommitment = {
  checkpoint_id: string;
  event_count: number;
  chain_tip: B3Hash;
  observed_at: string;
};

export type RecordObservation = {
  state: ObservationState;
  observed_session_id: string | null;
  commitments: ObservationCommitment[];
  checkpoint_count: number;
  first_observed_at: string | null;
  last_observed_at: string | null;
  server_observed_span_ms: number | null;
};

export type ObservedSession = {
  observed_session_id: string;
  token_hash: string;
  finalized_record_hash: B3Hash | null;
  observation_state: ObservationState | null;
  created_at: string;
  finalized_at: string | null;
  checkpoints: ObservationCommitment[];
};

export type AppendObservedCheckpointInput = {
  observed_session_id: string;
  observed_token_hash?: string;
  new_observed_token_hash: string;
  event_count: number;
  chain_tip: B3Hash;
  observed_at?: string;
};

export type AppendObservedCheckpointResult = {
  observed_session_id: string;
  checkpoint: ObservationCommitment;
  session_created: boolean;
  checkpoint_created: boolean;
};

export type ObservationBindingInput = {
  observed_session_id: string;
  observed_token_hash: string;
};

export type BoundRecordObservation = Omit<RecordObservation, "state" | "observed_session_id"> & {
  state: BoundObservationState;
  observed_session_id: string;
};

export type StoredRecord = WritingRecord & {
  short_signature: string;
  stats: RecordStats;
  signals: AnalysisResult[];
  observation: RecordObservation;
  created_at: string;
};

export type SaveRecordInput = {
  record: WritingRecord;
  short_signature: string;
  stats: RecordStats;
  signals?: AnalysisResult[];
  observation?: RecordObservation;
  created_at?: string;
};

export type SaveRecordResult = {
  stored: StoredRecord;
  created: boolean;
};

export interface RecordStore {
  saveRecord(input: SaveRecordInput): Promise<SaveRecordResult>;
  findByRecordHash(recordHash: B3Hash): Promise<StoredRecord | null>;
  findByShortSignature(shortSignature: string): Promise<StoredRecord | null>;
  findByShortSignatureOrHash(id: string): Promise<StoredRecord | null>;
  shortSignatureExists(shortSignature: string): Promise<boolean>;
  appendObservedCheckpoint(input: AppendObservedCheckpointInput): Promise<AppendObservedCheckpointResult>;
  getObservedSessionForBinding(input: ObservationBindingInput): Promise<ObservedSession>;
}

export class DuplicateRecordConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DuplicateRecordConflictError";
  }
}

export class ObservedSessionTokenError extends Error {
  readonly code: "observed_token_required" | "invalid_observed_token" | "observed_session_not_found";

  constructor(code: ObservedSessionTokenError["code"], message: string) {
    super(message);
    this.name = "ObservedSessionTokenError";
    this.code = code;
  }
}

export class ObservedCheckpointConflictError extends Error {
  readonly code:
    | "checkpoint_event_count_not_monotonic"
    | "checkpoint_chain_tip_conflict"
    | "observed_session_finalized"
    | "observation_mismatch";

  constructor(code: ObservedCheckpointConflictError["code"], message: string) {
    super(message);
    this.name = "ObservedCheckpointConflictError";
    this.code = code;
  }
}

export class InMemoryRecordStore implements RecordStore {
  readonly #byHash = new Map<B3Hash, StoredRecord>();
  readonly #byShortSignature = new Map<string, B3Hash>();
  readonly #observedSessions = new Map<string, ObservedSession>();

  async saveRecord(input: SaveRecordInput): Promise<SaveRecordResult> {
    const recordHash = input.record.manifest.record_hash;
    const existing = this.#byHash.get(recordHash);
    if (existing) {
      if (existing.short_signature !== input.short_signature) {
        throw new DuplicateRecordConflictError("record_hash already exists with a different short_signature");
      }
      return { stored: cloneStoredRecord(existing), created: false };
    }

    const shortOwner = this.#byShortSignature.get(input.short_signature);
    if (shortOwner && shortOwner !== recordHash) {
      throw new DuplicateRecordConflictError("short_signature already belongs to another record");
    }

    let finalObservation = input.observation;
    if (input.observation?.observed_session_id) {
      const session = this.#observedSessions.get(input.observation.observed_session_id);
      if (!session) throw new ObservedSessionTokenError("observed_session_not_found", "observed session not found");
      if (session.finalized_record_hash && session.finalized_record_hash !== recordHash) {
        throw new ObservedCheckpointConflictError("observed_session_finalized", "observed session already finalized");
      }
      finalObservation = validateRecordObservation(input.record, session.observed_session_id, session.checkpoints);
      session.finalized_record_hash = recordHash;
      session.observation_state = finalObservation.state;
      session.finalized_at = input.record.manifest.ingested_server_t ?? input.created_at ?? new Date().toISOString();
    }

    const stored: StoredRecord = {
      manifest: cloneJson(input.record.manifest),
      events: cloneJson(input.record.events),
      short_signature: input.short_signature,
      stats: cloneJson(input.stats),
      signals: cloneJson(input.signals ?? []),
      observation: cloneJson(finalObservation ?? notRequestedObservation()),
      created_at: input.created_at ?? new Date().toISOString(),
    };
    this.#byHash.set(recordHash, stored);
    this.#byShortSignature.set(input.short_signature, recordHash);
    return { stored: cloneStoredRecord(stored), created: true };
  }

  async findByRecordHash(recordHash: B3Hash): Promise<StoredRecord | null> {
    const stored = this.#byHash.get(recordHash);
    return stored ? cloneStoredRecord(stored) : null;
  }

  async findByShortSignature(shortSignature: string): Promise<StoredRecord | null> {
    const recordHash = this.#byShortSignature.get(shortSignature);
    return recordHash ? this.findByRecordHash(recordHash) : null;
  }

  async findByShortSignatureOrHash(id: string): Promise<StoredRecord | null> {
    if (id.startsWith("b3:")) return this.findByRecordHash(id as B3Hash);
    return this.findByShortSignature(id);
  }

  async shortSignatureExists(shortSignature: string): Promise<boolean> {
    return this.#byShortSignature.has(shortSignature);
  }

  async appendObservedCheckpoint(input: AppendObservedCheckpointInput): Promise<AppendObservedCheckpointResult> {
    let session = this.#observedSessions.get(input.observed_session_id);
    let sessionCreated = false;
    const observedAt = input.observed_at ?? new Date().toISOString();
    if (session && isExpiredUnfinalizedObservedSession(session, observedAt)) {
      this.#observedSessions.delete(input.observed_session_id);
      session = undefined;
    }

    if (!session) {
      if (input.observed_token_hash) {
        throw new ObservedSessionTokenError("observed_session_not_found", "observed session not found");
      }
      sessionCreated = true;
      session = {
        observed_session_id: input.observed_session_id,
        token_hash: input.new_observed_token_hash,
        finalized_record_hash: null,
        observation_state: null,
        created_at: observedAt,
        finalized_at: null,
        checkpoints: [],
      };
      this.#observedSessions.set(input.observed_session_id, session);
    } else {
      assertObservedToken(session, input.observed_token_hash);
      if (session.finalized_record_hash) {
        throw new ObservedCheckpointConflictError("observed_session_finalized", "observed session already finalized");
      }
    }

    const existingAtCount = session.checkpoints.find((checkpoint) => checkpoint.event_count === input.event_count);
    if (existingAtCount) {
      if (existingAtCount.chain_tip !== input.chain_tip) {
        throw new ObservedCheckpointConflictError("checkpoint_chain_tip_conflict", "checkpoint already exists with a different chain_tip");
      }
      return {
        observed_session_id: session.observed_session_id,
        checkpoint: cloneJson(existingAtCount),
        session_created: sessionCreated,
        checkpoint_created: false,
      };
    }

    const maxEventCount = Math.max(0, ...session.checkpoints.map((checkpoint) => checkpoint.event_count));
    if (input.event_count < maxEventCount) {
      throw new ObservedCheckpointConflictError("checkpoint_event_count_not_monotonic", "checkpoint event_count must be monotonic");
    }

    const checkpoint: ObservationCommitment = {
      checkpoint_id: crypto.randomUUID(),
      event_count: input.event_count,
      chain_tip: input.chain_tip,
      observed_at: observedAt,
    };
    session.checkpoints.push(checkpoint);
    session.checkpoints.sort((left, right) => left.event_count - right.event_count || left.observed_at.localeCompare(right.observed_at));
    return {
      observed_session_id: session.observed_session_id,
      checkpoint: cloneJson(checkpoint),
      session_created: sessionCreated,
      checkpoint_created: true,
    };
  }

  async getObservedSessionForBinding(input: ObservationBindingInput): Promise<ObservedSession> {
    const session = this.#observedSessions.get(input.observed_session_id);
    if (!session) throw new ObservedSessionTokenError("observed_session_not_found", "observed session not found");
    if (isExpiredUnfinalizedObservedSession(session, new Date().toISOString())) {
      this.#observedSessions.delete(input.observed_session_id);
      throw new ObservedSessionTokenError("observed_session_not_found", "observed session not found");
    }
    assertObservedToken(session, input.observed_token_hash);
    return cloneJson(session);
  }
}

export type PostgresQueryable = {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

export type PostgresClient = PostgresQueryable & {
  release?: () => void;
};

export type PostgresDatabase = PostgresQueryable & {
  connect?: () => Promise<PostgresClient>;
};

/**
 * Minimal Postgres-backed RecordStore adapter for the v0 schema in migrations/001_init.sql.
 * Tests use InMemoryRecordStore; this adapter keeps SQL mapping in the storage package without
 * making HTTP/API code depend on a specific Postgres client library.
 */
export class PostgresRecordStore implements RecordStore {
  readonly #db: PostgresDatabase;

  constructor(db: PostgresDatabase) {
    this.#db = db;
  }

  async saveRecord(input: SaveRecordInput): Promise<SaveRecordResult> {
    const manifest = input.record.manifest;
    const createdAt = input.created_at ?? new Date().toISOString();
    const signals = input.signals ?? [];

    const existing = await this.findByRecordHash(manifest.record_hash);
    if (existing) return { stored: existing, created: false };

    try {
      await this.#withTransaction(async (client) => {
        let finalObservation = input.observation;
        if (input.observation?.observed_session_id) {
          const session = (await client.query<ObservedSessionRow>(
            `select observed_session_id, token_hash, finalized_record_hash, observation_state, created_at, finalized_at
             from observed_sessions where observed_session_id = $1 for update`,
            [input.observation.observed_session_id],
          )).rows[0];
          if (!session) throw new ObservedSessionTokenError("observed_session_not_found", "observed session not found");
          if (session.finalized_record_hash && session.finalized_record_hash !== manifest.record_hash) {
            throw new ObservedCheckpointConflictError("observed_session_finalized", "observed session already finalized");
          }
          const checkpoints = (await client.query<ObservedCheckpointRow>(
            `select checkpoint_id, event_count, chain_tip, observed_at
             from observed_checkpoints where observed_session_id = $1 order by event_count, observed_at`,
            [input.observation.observed_session_id],
          )).rows.map(rowToObservationCommitment);
          finalObservation = validateRecordObservation(input.record, session.observed_session_id, checkpoints);
        }

        await client.query(
          `insert into records (
            record_hash, short_signature, format_version, session_id,
            producer_id, producer_version, producer_capabilities, capture_context,
            event_count, duration_ms,
            created_client_t, ingested_server_t, parent_record_hash, attestations, events, created_at, observation_state
          ) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16,$17)`,
          [
            manifest.record_hash,
            input.short_signature,
            manifest.format_version,
            manifest.session_id,
            manifest.producer.id,
            manifest.producer.version,
            JSON.stringify(manifest.producer.capabilities),
            JSON.stringify(manifest.capture_context ?? null),
            manifest.event_count,
            manifest.duration_ms,
            manifest.created_client_t ?? null,
            manifest.ingested_server_t ?? new Date().toISOString(),
            manifest.parent_record ?? null,
            JSON.stringify(manifest.attestations),
            JSON.stringify(input.record.events),
            createdAt,
            finalObservation?.state === "unobserved" ? "unobserved" : "not_requested",
          ],
        );

        await client.query(
          `insert into record_stats (
            record_hash, observed_final_length, insert_op_count, delete_op_count, replace_op_count,
            typed_event_count, paste_event_count, cut_event_count, drop_event_count,
            ime_event_count, autocomplete_event_count, programmatic_event_count, unknown_source_count,
            inserted_codepoints_total, deleted_codepoints_total, largest_atomic_insert_codepoints,
            inter_event_delay_min_ms, inter_event_delay_p50_ms, inter_event_delay_p90_ms,
            inter_event_delay_p95_ms, inter_event_delay_p99_ms, inter_event_delay_max_ms,
            active_time_ms, idle_time_ms, long_pause_count, delay_histogram
          ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26::jsonb)`,
          [
            input.stats.record_hash,
            input.stats.observed_final_length,
            input.stats.insert_op_count,
            input.stats.delete_op_count,
            input.stats.replace_op_count,
            input.stats.typed_event_count,
            input.stats.paste_event_count,
            input.stats.cut_event_count,
            input.stats.drop_event_count,
            input.stats.ime_event_count,
            input.stats.autocomplete_event_count,
            input.stats.programmatic_event_count,
            input.stats.unknown_source_count,
            input.stats.inserted_codepoints_total,
            input.stats.deleted_codepoints_total,
            input.stats.largest_atomic_insert_codepoints,
            input.stats.inter_event_delay_min_ms,
            input.stats.inter_event_delay_p50_ms,
            input.stats.inter_event_delay_p90_ms,
            input.stats.inter_event_delay_p95_ms,
            input.stats.inter_event_delay_p99_ms,
            input.stats.inter_event_delay_max_ms,
            input.stats.active_time_ms,
            input.stats.idle_time_ms,
            input.stats.long_pause_count,
            JSON.stringify(input.stats.delay_histogram),
          ],
        );

        for (const signal of signals) {
          await client.query(
            `insert into analysis_results (
              id, record_hash, analyzer_id, analyzer_version, applicable, measures, human_range, explanation
            ) values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)
            on conflict (record_hash, analyzer_id, analyzer_version) do nothing`,
            [
              signal.id ?? crypto.randomUUID(),
              manifest.record_hash,
              signal.analyzer_id,
              signal.analyzer_version,
              signal.applicable,
              JSON.stringify(signal.measures),
              signal.human_range ? JSON.stringify(signal.human_range) : null,
              signal.explanation,
            ],
          );
        }

        if (input.observation?.observed_session_id) {
          if (!finalObservation || !finalObservation.observed_session_id) throw new ObservedCheckpointConflictError("observation_mismatch", "observed session final observation is missing");
          const result = await client.query(
            `update observed_sessions
             set finalized_record_hash = $1, observation_state = $2, finalized_at = $3
             where observed_session_id = $4
               and (finalized_record_hash is null or finalized_record_hash = $1)`,
            [manifest.record_hash, finalObservation.state, manifest.ingested_server_t ?? createdAt, input.observation.observed_session_id],
          );
          if ("rowCount" in result && (result as { rowCount?: number }).rowCount === 0) {
            throw new ObservedCheckpointConflictError("observed_session_finalized", "observed session already finalized");
          }
        }
      });
      const stored = await this.findByRecordHash(manifest.record_hash);
      if (!stored) throw new Error("record was inserted but could not be read back");
      return { stored, created: true };
    } catch (error) {
      if (isPostgresUniqueViolation(error)) return this.#resolveUniqueViolation(input);
      throw error;
    }
  }

  async #withTransaction<T>(fn: (client: PostgresQueryable) => Promise<T>): Promise<T> {
    const client = this.#db.connect ? await this.#db.connect() : this.#db;
    try {
      await client.query("begin");
      const value = await fn(client);
      await client.query("commit");
      return value;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      if ("release" in client) client.release?.();
    }
  }

  async #resolveUniqueViolation(input: SaveRecordInput): Promise<SaveRecordResult> {
    const recordHash = input.record.manifest.record_hash;
    const existingByHash = await this.findByRecordHash(recordHash);
    if (existingByHash) {
      if (existingByHash.short_signature !== input.short_signature) {
        throw new DuplicateRecordConflictError("record_hash already exists with a different short_signature");
      }
      return { stored: existingByHash, created: false };
    }

    const existingByShortSignature = await this.findByShortSignature(input.short_signature);
    if (existingByShortSignature && existingByShortSignature.manifest.record_hash !== recordHash) {
      throw new DuplicateRecordConflictError("short_signature already belongs to another record");
    }

    throw new DuplicateRecordConflictError("unique constraint conflict while saving record");
  }

  async findByRecordHash(recordHash: B3Hash): Promise<StoredRecord | null> {
    const result = await this.#db.query<RecordRow>(
      `select
         r.record_hash,
         r.short_signature,
         r.format_version,
         r.session_id,
         r.producer_id,
         r.producer_version,
         r.producer_capabilities,
         r.capture_context,
         r.event_count,
         r.duration_ms,
         r.created_client_t,
         r.ingested_server_t,
         r.parent_record_hash,
         r.attestations,
         r.events,
         r.created_at,
         r.observation_state as record_observation_state,
         s.insert_op_count,
         s.delete_op_count,
         s.replace_op_count,
         s.typed_event_count,
         s.paste_event_count,
         s.cut_event_count,
         s.drop_event_count,
         s.ime_event_count,
         s.autocomplete_event_count,
         s.programmatic_event_count,
         s.unknown_source_count,
         s.inserted_codepoints_total,
         s.deleted_codepoints_total,
         s.largest_atomic_insert_codepoints,
         s.observed_final_length,
         s.inter_event_delay_min_ms,
         s.inter_event_delay_p50_ms,
         s.inter_event_delay_p90_ms,
         s.inter_event_delay_p95_ms,
         s.inter_event_delay_p99_ms,
         s.inter_event_delay_max_ms,
         s.active_time_ms,
         s.idle_time_ms,
         s.long_pause_count,
         s.delay_histogram,
         coalesce(a.signals, '[]'::jsonb) as signals
       from records r
       join record_stats s using (record_hash)
       left join (
         select record_hash, jsonb_agg(to_jsonb(analysis_results) order by created_at, analyzer_id, analyzer_version, id) as signals
         from analysis_results group by record_hash
       ) a using (record_hash)
       where r.record_hash = $1`,
      [recordHash],
    );
    if (!result.rows[0]) return null;
    const observation = await this.#findObservationByRecordHash(recordHash, (result.rows[0].record_observation_state ?? "not_requested") as ObservationState);
    return rowToStoredRecord(result.rows[0], observation);
  }

  async #findObservationByRecordHash(recordHash: B3Hash, fallbackState: ObservationState): Promise<RecordObservation> {
    const sessionResult = await this.#db.query<ObservedSessionRow>(
      `select observed_session_id, token_hash, finalized_record_hash, observation_state, created_at, finalized_at
       from observed_sessions where finalized_record_hash = $1`,
      [recordHash],
    );
    const session = sessionResult.rows[0];
    if (!session) return fallbackState === "unobserved" ? unobservedObservation() : notRequestedObservation();
    const checkpointResult = await this.#db.query<ObservedCheckpointRow>(
      `select checkpoint_id, event_count, chain_tip, observed_at
       from observed_checkpoints where observed_session_id = $1 order by event_count, observed_at`,
      [session.observed_session_id],
    );
    return observationFromCheckpoints(
      session.observed_session_id,
      (session.observation_state ?? "partial") as BoundObservationState,
      checkpointResult.rows.map(rowToObservationCommitment),
    );
  }

  async findByShortSignature(shortSignature: string): Promise<StoredRecord | null> {
    const result = await this.#db.query<{ record_hash: B3Hash }>(
      "select record_hash from records where short_signature = $1",
      [shortSignature],
    );
    return result.rows[0] ? this.findByRecordHash(result.rows[0].record_hash) : null;
  }

  async findByShortSignatureOrHash(id: string): Promise<StoredRecord | null> {
    if (id.startsWith("b3:")) return this.findByRecordHash(id as B3Hash);
    return this.findByShortSignature(id);
  }

  async shortSignatureExists(shortSignature: string): Promise<boolean> {
    const result = await this.#db.query<{ exists: boolean }>(
      "select exists(select 1 from records where short_signature = $1) as exists",
      [shortSignature],
    );
    return result.rows[0]?.exists ?? false;
  }

  async appendObservedCheckpoint(input: AppendObservedCheckpointInput): Promise<AppendObservedCheckpointResult> {
    return this.#withTransaction(async (client) => {
      const observedAt = input.observed_at ?? new Date().toISOString();
      await deleteExpiredObservedSession(client, input.observed_session_id, observedAt);
      let session = (await client.query<ObservedSessionRow>(
        `select observed_session_id, token_hash, finalized_record_hash, observation_state, created_at, finalized_at
         from observed_sessions where observed_session_id = $1 for update`,
        [input.observed_session_id],
      )).rows[0];
      let sessionCreated = false;

      if (!session) {
        if (input.observed_token_hash) {
          throw new ObservedSessionTokenError("observed_session_not_found", "observed session not found");
        }
        sessionCreated = true;
        session = (await client.query<ObservedSessionRow>(
          `insert into observed_sessions (observed_session_id, token_hash, created_at)
           values ($1,$2,$3)
           returning observed_session_id, token_hash, finalized_record_hash, observation_state, created_at, finalized_at`,
          [input.observed_session_id, input.new_observed_token_hash, observedAt],
        )).rows[0] as ObservedSessionRow;
      } else {
        assertObservedToken(rowToObservedSession(session, []), input.observed_token_hash);
        if (session.finalized_record_hash) {
          throw new ObservedCheckpointConflictError("observed_session_finalized", "observed session already finalized");
        }
      }

      const existing = (await client.query<ObservedCheckpointRow>(
        `select checkpoint_id, event_count, chain_tip, observed_at
         from observed_checkpoints where observed_session_id = $1 and event_count = $2`,
        [input.observed_session_id, input.event_count],
      )).rows[0];
      if (existing) {
        if (existing.chain_tip !== input.chain_tip) {
          throw new ObservedCheckpointConflictError("checkpoint_chain_tip_conflict", "checkpoint already exists with a different chain_tip");
        }
        return {
          observed_session_id: input.observed_session_id,
          checkpoint: rowToObservationCommitment(existing),
          session_created: sessionCreated,
          checkpoint_created: false,
        };
      }

      const maxResult = await client.query<{ max_event_count: number | string | null }>(
        `select max(event_count) as max_event_count from observed_checkpoints where observed_session_id = $1`,
        [input.observed_session_id],
      );
      const maxEventCount = Number(maxResult.rows[0]?.max_event_count ?? 0);
      if (input.event_count < maxEventCount) {
        throw new ObservedCheckpointConflictError("checkpoint_event_count_not_monotonic", "checkpoint event_count must be monotonic");
      }

      const inserted = (await client.query<ObservedCheckpointRow>(
        `insert into observed_checkpoints (checkpoint_id, observed_session_id, event_count, chain_tip, observed_at)
         values ($1,$2,$3,$4,$5)
         on conflict (observed_session_id, event_count) do nothing
         returning checkpoint_id, event_count, chain_tip, observed_at`,
        [crypto.randomUUID(), input.observed_session_id, input.event_count, input.chain_tip, observedAt],
      )).rows[0];
      if (inserted) {
        return {
          observed_session_id: input.observed_session_id,
          checkpoint: rowToObservationCommitment(inserted),
          session_created: sessionCreated,
          checkpoint_created: true,
        };
      }

      const racedExisting = (await client.query<ObservedCheckpointRow>(
        `select checkpoint_id, event_count, chain_tip, observed_at
         from observed_checkpoints where observed_session_id = $1 and event_count = $2`,
        [input.observed_session_id, input.event_count],
      )).rows[0];
      if (racedExisting && racedExisting.chain_tip === input.chain_tip) {
        return {
          observed_session_id: input.observed_session_id,
          checkpoint: rowToObservationCommitment(racedExisting),
          session_created: sessionCreated,
          checkpoint_created: false,
        };
      }
      throw new ObservedCheckpointConflictError("checkpoint_chain_tip_conflict", "checkpoint already exists with a different chain_tip");
    });
  }

  async getObservedSessionForBinding(input: ObservationBindingInput): Promise<ObservedSession> {
    await deleteExpiredObservedSession(this.#db, input.observed_session_id, new Date().toISOString());
    const session = (await this.#db.query<ObservedSessionRow>(
      `select observed_session_id, token_hash, finalized_record_hash, observation_state, created_at, finalized_at
       from observed_sessions where observed_session_id = $1`,
      [input.observed_session_id],
    )).rows[0];
    if (!session) throw new ObservedSessionTokenError("observed_session_not_found", "observed session not found");
    const checkpoints = (await this.#db.query<ObservedCheckpointRow>(
      `select checkpoint_id, event_count, chain_tip, observed_at
       from observed_checkpoints where observed_session_id = $1 order by event_count, observed_at`,
      [input.observed_session_id],
    )).rows.map(rowToObservationCommitment);
    const observedSession = rowToObservedSession(session, checkpoints);
    assertObservedToken(observedSession, input.observed_token_hash);
    return observedSession;
  }
}

type RecordRow = Record<string, unknown> & {
  record_hash: B3Hash;
  short_signature: string;
  format_version: "0.1";
  session_id: string;
  producer_id: string;
  producer_version: string;
  producer_capabilities: string[];
  capture_context: Record<string, JsonValue> | null;
  event_count: number;
  duration_ms: number;
  created_client_t: string | null;
  ingested_server_t: string;
  parent_record_hash: B3Hash | null;
  attestations: Array<{ type: string; [key: string]: JsonValue | undefined }>;
  events: EventLog;
  created_at: string;
  record_observation_state?: string | null;
  observed_final_length: number | null;
  delay_histogram: Array<{ bucket: string; count: number }>;
  signals: AnalysisResult[];
};

type ObservedSessionRow = Record<string, unknown> & {
  observed_session_id: string;
  token_hash: string;
  finalized_record_hash: B3Hash | null;
  observation_state: string | null;
  created_at: string;
  finalized_at: string | null;
};

type ObservedCheckpointRow = Record<string, unknown> & {
  checkpoint_id: string;
  event_count: number;
  chain_tip: B3Hash;
  observed_at: string;
};

function rowToStoredRecord(row: RecordRow, observation: RecordObservation): StoredRecord {
  const manifest: RecordManifest = {
    format_version: row.format_version,
    record_hash: row.record_hash,
    session_id: row.session_id,
    producer: {
      id: row.producer_id,
      version: row.producer_version,
      capabilities: row.producer_capabilities as RecordManifest["producer"]["capabilities"],
    },
    capture_context: row.capture_context,
    event_count: row.event_count,
    duration_ms: row.duration_ms,
    created_client_t: row.created_client_t,
    ingested_server_t: row.ingested_server_t,
    parent_record: row.parent_record_hash,
    attestations: row.attestations,
  };

  return {
    manifest,
    events: row.events,
    short_signature: row.short_signature,
    stats: {
      record_hash: row.record_hash,
      event_count: row.event_count,
      duration_ms: row.duration_ms,
      observed_final_length: nullableNumberFromRow(row.observed_final_length),
      insert_op_count: numberFromRow(row.insert_op_count),
      delete_op_count: numberFromRow(row.delete_op_count),
      replace_op_count: numberFromRow(row.replace_op_count),
      typed_event_count: numberFromRow(row.typed_event_count),
      paste_event_count: numberFromRow(row.paste_event_count),
      cut_event_count: numberFromRow(row.cut_event_count),
      drop_event_count: numberFromRow(row.drop_event_count),
      ime_event_count: numberFromRow(row.ime_event_count),
      autocomplete_event_count: numberFromRow(row.autocomplete_event_count),
      programmatic_event_count: numberFromRow(row.programmatic_event_count),
      unknown_source_count: numberFromRow(row.unknown_source_count),
      inserted_codepoints_total: numberFromRow(row.inserted_codepoints_total),
      deleted_codepoints_total: numberFromRow(row.deleted_codepoints_total),
      largest_atomic_insert_codepoints: numberFromRow(row.largest_atomic_insert_codepoints),
      inter_event_delay_min_ms: nullableNumberFromRow(row.inter_event_delay_min_ms),
      inter_event_delay_p50_ms: nullableNumberFromRow(row.inter_event_delay_p50_ms),
      inter_event_delay_p90_ms: nullableNumberFromRow(row.inter_event_delay_p90_ms),
      inter_event_delay_p95_ms: nullableNumberFromRow(row.inter_event_delay_p95_ms),
      inter_event_delay_p99_ms: nullableNumberFromRow(row.inter_event_delay_p99_ms),
      inter_event_delay_max_ms: nullableNumberFromRow(row.inter_event_delay_max_ms),
      active_time_ms: numberFromRow(row.active_time_ms),
      idle_time_ms: numberFromRow(row.idle_time_ms),
      long_pause_count: numberFromRow(row.long_pause_count),
      delay_histogram: row.delay_histogram,
    },
    signals: row.signals,
    observation,
    created_at: row.created_at,
  };
}

function rowToObservedSession(row: ObservedSessionRow, checkpoints: ObservationCommitment[]): ObservedSession {
  return {
    observed_session_id: row.observed_session_id,
    token_hash: row.token_hash,
    finalized_record_hash: row.finalized_record_hash,
    observation_state: row.observation_state as ObservationState | null,
    created_at: row.created_at,
    finalized_at: row.finalized_at,
    checkpoints,
  };
}

function rowToObservationCommitment(row: ObservedCheckpointRow): ObservationCommitment {
  return {
    checkpoint_id: row.checkpoint_id,
    event_count: numberFromRow(row.event_count),
    chain_tip: row.chain_tip,
    observed_at: row.observed_at,
  };
}

export function observationFromCheckpoints(
  observedSessionId: string,
  state: BoundObservationState,
  checkpoints: ObservationCommitment[],
): BoundRecordObservation {
  const commitments = [...checkpoints].sort((left, right) => left.event_count - right.event_count || left.observed_at.localeCompare(right.observed_at));
  const first = commitments[0]?.observed_at ?? null;
  const last = commitments.at(-1)?.observed_at ?? null;
  return {
    state,
    observed_session_id: observedSessionId,
    commitments,
    checkpoint_count: commitments.length,
    first_observed_at: first,
    last_observed_at: last,
    server_observed_span_ms: first && last ? Math.max(0, Date.parse(last) - Date.parse(first)) : null,
  };
}

function validateRecordObservation(record: WritingRecord, observedSessionId: string, checkpoints: ObservationCommitment[]): BoundRecordObservation {
  const commitments = [...checkpoints].sort((left, right) => left.event_count - right.event_count || left.observed_at.localeCompare(right.observed_at));
  if (commitments.length === 0) {
    throw new ObservedCheckpointConflictError("observation_mismatch", "observed session has no commitments");
  }
  const chain = computeEventHashChain(record.events, record.manifest.session_id, record.manifest.format_version);
  for (const checkpoint of commitments) {
    if (checkpoint.event_count < 1 || checkpoint.event_count > record.events.length) {
      throw new ObservedCheckpointConflictError("observation_mismatch", "checkpoint event_count does not match final record");
    }
    if (chain[checkpoint.event_count - 1] !== checkpoint.chain_tip) {
      throw new ObservedCheckpointConflictError("observation_mismatch", "checkpoint does not match final record prefix");
    }
  }
  const lastEventCount = commitments.at(-1)?.event_count ?? 0;
  return observationFromCheckpoints(observedSessionId, lastEventCount === record.events.length ? "observed" : "partial", commitments);
}

export function unobservedObservation(): RecordObservation {
  return {
    state: "unobserved",
    observed_session_id: null,
    commitments: [],
    checkpoint_count: 0,
    first_observed_at: null,
    last_observed_at: null,
    server_observed_span_ms: null,
  };
}

export function notRequestedObservation(): RecordObservation {
  return {
    state: "not_requested",
    observed_session_id: null,
    commitments: [],
    checkpoint_count: 0,
    first_observed_at: null,
    last_observed_at: null,
    server_observed_span_ms: null,
  };
}

function isExpiredUnfinalizedObservedSession(session: Pick<ObservedSession, "finalized_record_hash" | "created_at" | "checkpoints">, nowIso: string): boolean {
  if (session.finalized_record_hash) return false;
  const lastActivity = session.checkpoints.reduce(
    (latest, checkpoint) => checkpoint.observed_at > latest ? checkpoint.observed_at : latest,
    session.created_at,
  );
  return Date.parse(lastActivity) + OBSERVED_SESSION_TTL_MS < Date.parse(nowIso);
}

async function deleteExpiredObservedSession(db: PostgresQueryable, observedSessionId: string, nowIso: string): Promise<void> {
  const cutoff = new Date(Date.parse(nowIso) - OBSERVED_SESSION_TTL_MS).toISOString();
  await db.query(
    `delete from observed_sessions
     where observed_session_id = $1
       and finalized_record_hash is null
       and coalesce(
         (select max(observed_at) from observed_checkpoints where observed_session_id = $1),
         created_at
       ) < $2`,
    [observedSessionId, cutoff],
  );
}

function assertObservedToken(session: Pick<ObservedSession, "token_hash">, tokenHash: string | undefined): void {
  if (!tokenHash) throw new ObservedSessionTokenError("observed_token_required", "observed_token is required");
  if (tokenHash !== session.token_hash) throw new ObservedSessionTokenError("invalid_observed_token", "observed_token is invalid");
}

function cloneStoredRecord(record: StoredRecord): StoredRecord {
  return cloneJson(record);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function numberFromRow(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function nullableNumberFromRow(value: unknown): number | null {
  return value === null || value === undefined ? null : numberFromRow(value);
}

function isPostgresUniqueViolation(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "23505";
}
