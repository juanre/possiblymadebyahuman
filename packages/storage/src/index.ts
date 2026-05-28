import type { B3Hash, EventLog, JsonValue, RecordManifest, Signal, WritingRecord } from "../../format/src/index.ts";

export type RecordStats = {
  record_hash: B3Hash;
  event_count: number;
  duration_ms: number;
  final_text_length: number;
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

export type StoredRecord = WritingRecord & {
  short_signature: string;
  stats: RecordStats;
  signals: AnalysisResult[];
  created_at: string;
};

export type SaveRecordInput = {
  record: WritingRecord;
  short_signature: string;
  stats: RecordStats;
  signals?: AnalysisResult[];
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
}

export class DuplicateRecordConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DuplicateRecordConflictError";
  }
}

export class InMemoryRecordStore implements RecordStore {
  readonly #byHash = new Map<B3Hash, StoredRecord>();
  readonly #byShortSignature = new Map<string, B3Hash>();

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

    const stored: StoredRecord = {
      manifest: cloneJson(input.record.manifest),
      events: cloneJson(input.record.events),
      short_signature: input.short_signature,
      stats: cloneJson(input.stats),
      signals: cloneJson(input.signals ?? []),
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
        await client.query(
          `insert into records (
            record_hash, short_signature, format_version, session_id,
            producer_id, producer_version, producer_capabilities, capture_context,
            event_count, duration_ms, final_text_hash, final_text_length,
            created_client_t, ingested_server_t, parent_record_hash, attestations, events, created_at
          ) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18)`,
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
            manifest.final_text_hash,
            manifest.final_text_length,
            manifest.created_client_t ?? null,
            manifest.ingested_server_t ?? new Date().toISOString(),
            manifest.parent_record ?? null,
            JSON.stringify(manifest.attestations),
            JSON.stringify(input.record.events),
            createdAt,
          ],
        );

        await client.query(
          `insert into record_stats (
            record_hash, insert_op_count, delete_op_count, replace_op_count,
            typed_event_count, paste_event_count, cut_event_count, drop_event_count,
            ime_event_count, autocomplete_event_count, programmatic_event_count, unknown_source_count,
            inserted_codepoints_total, deleted_codepoints_total, largest_atomic_insert_codepoints,
            inter_event_delay_min_ms, inter_event_delay_p50_ms, inter_event_delay_p90_ms,
            inter_event_delay_p95_ms, inter_event_delay_p99_ms, inter_event_delay_max_ms,
            active_time_ms, idle_time_ms, long_pause_count, delay_histogram
          ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25::jsonb)`,
          [
            input.stats.record_hash,
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
         r.final_text_hash,
         r.final_text_length,
         r.created_client_t,
         r.ingested_server_t,
         r.parent_record_hash,
         r.attestations,
         r.events,
         r.created_at,
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
    return result.rows[0] ? rowToStoredRecord(result.rows[0]) : null;
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
  final_text_hash: B3Hash;
  final_text_length: number;
  created_client_t: string | null;
  ingested_server_t: string;
  parent_record_hash: B3Hash | null;
  attestations: Array<{ type: string; [key: string]: JsonValue | undefined }>;
  events: EventLog;
  created_at: string;
  delay_histogram: Array<{ bucket: string; count: number }>;
  signals: AnalysisResult[];
};

function rowToStoredRecord(row: RecordRow): StoredRecord {
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
    final_text_hash: row.final_text_hash,
    final_text_length: row.final_text_length,
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
      final_text_length: row.final_text_length,
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
    created_at: row.created_at,
  };
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
