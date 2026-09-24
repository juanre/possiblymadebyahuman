import { canonicalizeJson, type B3Hash, type EventLog, type RecordManifest } from "../../format/src/index.ts";
import { insertRecordData, notRequestedObservation, observationFromCheckpoints, unobservedObservation,
  type AnalysisResult, type ObservedSession, type ObservationCommitment, type PostgresDatabase,
  type PostgresQueryable, type RecordObservation, type RecordStats, type StoredRecord } from "./index.ts";

export const MAX_EVENT_CHUNK = 4096;
export type UploadObservation = { state: "unobserved" } | { observed_session_id: string; observed_token_hash: string };
export type UploadState = {
  upload_id: string; manifest: RecordManifest; observation?: UploadObservation;
  next_seq: number; chain_tip: B3Hash | null; last_t: number | null;
  observed_length: number | null; analysis_state: unknown; finalized_record_hash?: B3Hash | null; published_owner?: boolean;
};
export type ChunkTransition = { state: UploadState; chain_tips: B3Hash[]; delays: number[] };
export type Percentiles = { p50: number | null; p90: number | null; p95: number | null; p99: number | null };
export type EventPage = { events: EventLog; next_offset: number | null; total_events: number; chain_tip_before: B3Hash | null; chain_tip_after: B3Hash | null };
export type FinalizeData = { short_signature: string; stats: RecordStats; signals: AnalysisResult[] };
export interface ChunkedStore {
  begin(state: UploadState): Promise<UploadState>;
  status(id: string): Promise<UploadState | null>;
  append(id: string, offset: number, events: EventLog, transition: (state: UploadState) => ChunkTransition): Promise<UploadState>;
  finalize(id: string, derive: (state: UploadState, percentiles: Percentiles) => FinalizeData): Promise<{ record_hash: B3Hash; short_signature: string; created: boolean }>;
  page(record: StoredRecord, offset: number, limit: number): Promise<EventPage>;
}
export class ChunkedUploadError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string = code) { super(message); this.status = status; this.code = code; }
}
function identity(manifest: RecordManifest): string { return canonicalizeJson({ ...manifest, ingested_server_t: null }); }
function assertSameManifest(a: UploadState, b: UploadState): void {
  if (identity(a.manifest) !== identity(b.manifest)) throw new ChunkedUploadError(409, "upload_manifest_conflict");
}
function assertAppend(state: UploadState, offset: number, count: number): void {
  if (state.finalized_record_hash) throw new ChunkedUploadError(409, "upload_already_finalized");
  if (offset !== state.next_seq) throw new ChunkedUploadError(409, "upload_offset_conflict");
  if (offset + count > state.manifest.event_count) throw new ChunkedUploadError(400, "upload_event_count_exceeded");
}
function percentileValues(entries: Array<[number, number]>): Percentiles {
  const total = entries.reduce((sum, entry) => sum + entry[1], 0);
  const result: Percentiles = { p50: null, p90: null, p95: null, p99: null };
  let cumulative = 0;
  for (const [delay, count] of entries.sort((a, b) => a[0] - b[0])) {
    cumulative += count;
    for (const [key, fraction] of [["p50", .5], ["p90", .9], ["p95", .95], ["p99", .99]] as const) {
      if (result[key] === null && cumulative >= Math.ceil(total * fraction)) result[key] = delay;
    }
  }
  return result;
}
function observationView(state: UploadState, session: ObservedSession | null, tipAt: (index: number) => B3Hash | undefined): RecordObservation {
  if (!state.observation) return notRequestedObservation();
  if ("state" in state.observation) return unobservedObservation();
  if (!session || session.token_hash !== state.observation.observed_token_hash) throw new ChunkedUploadError(404, "observation_unavailable");
  if (session.finalized_record_hash && session.finalized_record_hash !== state.manifest.record_hash) throw new ChunkedUploadError(409, "observed_session_finalized");
  if (!session.checkpoints.length || session.checkpoints.some(checkpoint => tipAt(checkpoint.event_count - 1) !== checkpoint.chain_tip)) throw new ChunkedUploadError(409, "observation_mismatch");
  return observationFromCheckpoints(session.observed_session_id,
    session.checkpoints.at(-1)!.event_count === state.next_seq ? "observed" : "partial", session.checkpoints);
}

/** Test/reference adapter. Production event pages and delay counts live in PostgreSQL. */
export class InMemoryChunkedStore implements ChunkedStore {
  #uploads = new Map<string, UploadState>();
  #chunks = new Map<string, Map<number, { events: EventLog; tips: B3Hash[] }>>();
  #delays = new Map<string, Map<number, number>>();
  #completed = new Map<B3Hash, StoredRecord>();
  private sessions: Map<string, ObservedSession>;
  private lookup: (id: string) => Promise<StoredRecord | null>;
  constructor(sessions: Map<string, ObservedSession>, lookup: (id: string) => Promise<StoredRecord | null>) { this.sessions = sessions; this.lookup = lookup; }
  findCompleted(id: string): StoredRecord | null {
    const record = this.#completed.get(id as B3Hash) ?? [...this.#completed.values()].find(record => record.short_signature === id);
    return record ? structuredClone(record) : null;
  }
  async begin(state: UploadState): Promise<UploadState> {
    const existing = this.#uploads.get(state.upload_id);
    if (existing) { assertSameManifest(existing, state); if (!existing.finalized_record_hash) existing.observation = state.observation; return structuredClone(existing); }
    this.#uploads.set(state.upload_id, structuredClone(state)); this.#chunks.set(state.upload_id, new Map()); this.#delays.set(state.upload_id, new Map());
    return structuredClone(state);
  }
  async status(id: string): Promise<UploadState | null> { return structuredClone(this.#uploads.get(id) ?? null); }
  async append(id: string, offset: number, events: EventLog, transition: (state: UploadState) => ChunkTransition): Promise<UploadState> {
    const state = this.#uploads.get(id); if (!state) throw new ChunkedUploadError(404, "upload_not_found");
    const chunks = this.#chunks.get(id); if (!chunks) throw new ChunkedUploadError(409, "upload_already_finalized"); const prior = chunks.get(offset);
    if (prior) {
      if (canonicalizeJson(prior.events) !== canonicalizeJson(events)) throw new ChunkedUploadError(409, "upload_chunk_conflict");
      return structuredClone(state);
    }
    assertAppend(state, offset, events.length);
    const next = transition(structuredClone(state));
    chunks.set(offset, { events: structuredClone(events), tips: next.chain_tips });
    for (const delay of next.delays) this.#delays.get(id)!.set(delay, (this.#delays.get(id)!.get(delay) ?? 0) + 1);
    this.#uploads.set(id, structuredClone(next.state));
    return structuredClone(next.state);
  }
  async finalize(id: string, derive: (state: UploadState, percentiles: Percentiles) => FinalizeData) {
    const state = this.#uploads.get(id); if (!state) throw new ChunkedUploadError(404, "upload_not_found");
    const existing = (await this.lookup(state.manifest.record_hash)) ?? this.findCompleted(state.manifest.record_hash);
    if (existing) { state.finalized_record_hash = existing.manifest.record_hash; this.#delays.delete(id); if (!state.published_owner) this.#chunks.delete(id); return { record_hash: existing.manifest.record_hash, short_signature: existing.short_signature, created: false }; }
    const data = derive(structuredClone(state), percentileValues([...this.#delays.get(id)!]));
    const chunks = this.#chunks.get(id)!;
    const observed = state.observation && "observed_session_id" in state.observation ? this.sessions.get(state.observation.observed_session_id) ?? null : null;
    const observation = observationView(state, observed, index => {
      for (const [start, chunk] of chunks) if (index >= start && index < start + chunk.tips.length) return chunk.tips[index - start];
      return undefined;
    });
    if (observed && observation.observed_session_id) { observed.finalized_record_hash = state.manifest.record_hash; observed.observation_state = observation.state; }
    this.#completed.set(state.manifest.record_hash, { manifest: state.manifest, events: [], event_storage: "chunks", short_signature: data.short_signature,
      stats: data.stats, signals: data.signals, observation, created_at: state.manifest.ingested_server_t! });
    state.finalized_record_hash = state.manifest.record_hash; state.published_owner = true; this.#delays.delete(id);
    return { record_hash: state.manifest.record_hash, short_signature: data.short_signature, created: true };
  }
  async page(record: StoredRecord, offset: number, limit: number): Promise<EventPage> {
    const state = [...this.#uploads.values()].find(upload => upload.published_owner && upload.finalized_record_hash === record.manifest.record_hash && upload.next_seq === record.manifest.event_count);
    if (!state) throw new ChunkedUploadError(404, "record_not_found");
    const events: EventLog = []; let before: B3Hash | null = null, after: B3Hash | null = null;
    for (const [start, chunk] of this.#chunks.get(state.upload_id)!) {
      if (offset > start && offset <= start + chunk.tips.length) before = chunk.tips[offset - start - 1]!;
      for (let index = Math.max(0, offset - start); index < chunk.events.length && start + index < offset + limit; index++) {
        events.push(chunk.events[index]!); after = chunk.tips[index]!;
      }
    }
    return { events: structuredClone(events), next_offset: offset + events.length < state.next_seq ? offset + events.length : null,
      total_events: state.next_seq, chain_tip_before: before, chain_tip_after: after ?? before };
  }
}

export class PostgresChunkedStore implements ChunkedStore {
  private db: PostgresDatabase;
  constructor(db: PostgresDatabase) { this.db = db; }
  async #transaction<T>(work: (client: PostgresQueryable) => Promise<T>): Promise<T> {
    const client = this.db.connect ? await this.db.connect() : this.db;
    try { await client.query("begin"); const result = await work(client); await client.query("commit"); return result; }
    catch (error) { await client.query("rollback").catch(() => undefined); throw error; }
    finally { if ("release" in client) client.release?.(); }
  }
  async #read(client: PostgresQueryable, id: string, lock = false): Promise<UploadState | null> {
    const row = (await client.query<any>(`select upload_id, manifest, observation, next_seq, chain_tip, last_t, observed_length, analysis_state, finalized_record_hash, published_owner from record_uploads where upload_id=$1${lock ? " for update" : ""}`, [id])).rows[0];
    return row ? { ...row, last_t: row.last_t === null ? null : Number(row.last_t), observation: row.observation ?? undefined } : null;
  }
  async begin(state: UploadState): Promise<UploadState> {
    return this.#transaction(async client => {
      await client.query(`insert into record_uploads(upload_id,manifest,observation,analysis_state) values($1,$2::jsonb,$3::jsonb,$4::jsonb) on conflict(upload_id) do nothing`,
        [state.upload_id, JSON.stringify(state.manifest), JSON.stringify(state.observation ?? null), JSON.stringify(state.analysis_state)]);
      const existing = (await this.#read(client, state.upload_id, true))!;
      assertSameManifest(existing, state);
      if (!existing.finalized_record_hash) {
        await client.query("update record_uploads set observation=$2::jsonb where upload_id=$1", [state.upload_id, JSON.stringify(state.observation ?? null)]);
        existing.observation = state.observation;
      }
      return existing;
    });
  }
  async status(id: string): Promise<UploadState | null> { return this.#read(this.db, id); }
  async append(id: string, offset: number, events: EventLog, transition: (state: UploadState) => ChunkTransition): Promise<UploadState> {
    return this.#transaction(async client => {
      const state = await this.#read(client, id, true); if (!state) throw new ChunkedUploadError(404, "upload_not_found");
      const prior = (await client.query<{ events: EventLog }>("select events from record_event_chunks where upload_id=$1 and start_seq=$2", [id, offset])).rows[0];
      if (prior) {
        if (canonicalizeJson(prior.events) !== canonicalizeJson(events)) throw new ChunkedUploadError(409, "upload_chunk_conflict");
        return state;
      }
      assertAppend(state, offset, events.length);
      const next = transition(structuredClone(state));
      await client.query("insert into record_event_chunks(upload_id,start_seq,end_seq,events,chain_tips) values($1,$2,$3,$4::jsonb,$5)", [id, offset, next.state.next_seq, JSON.stringify(events), next.chain_tips]);
      await client.query("update record_uploads set next_seq=$2,chain_tip=$3,last_t=$4,observed_length=$5,analysis_state=$6::jsonb where upload_id=$1",
        [id, next.state.next_seq, next.state.chain_tip, next.state.last_t, next.state.observed_length, JSON.stringify(next.state.analysis_state)]);
      const counts = new Map<number, number>(); for (const delay of next.delays) counts.set(delay, (counts.get(delay) ?? 0) + 1);
      if (counts.size) await client.query(`insert into upload_delay_counts(upload_id,delay_ms,event_count)
        select $1,delay_ms,event_count from unnest($2::bigint[],$3::integer[]) as input(delay_ms,event_count)
        on conflict(upload_id,delay_ms) do update set event_count=upload_delay_counts.event_count+excluded.event_count`, [id, [...counts.keys()], [...counts.values()]]);
      return next.state;
    });
  }
  async finalize(id: string, derive: (state: UploadState, percentiles: Percentiles) => FinalizeData) {
    return this.#transaction(async client => {
      const state = await this.#read(client, id, true); if (!state) throw new ChunkedUploadError(404, "upload_not_found");
      // Different upload ids for the same immutable hash serialize publication.
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [state.manifest.record_hash]);
      const prior = (await client.query<{ record_hash: B3Hash; short_signature: string }>("select record_hash,short_signature from records where record_hash=$1", [state.manifest.record_hash])).rows[0];
      if (prior) {
        await client.query("update record_uploads set finalized_record_hash=$2 where upload_id=$1", [id, prior.record_hash]);
        await client.query("delete from upload_delay_counts where upload_id=$1", [id]);
        if (!state.published_owner) await client.query("delete from record_event_chunks where upload_id=$1", [id]);
        return { ...prior, created: false };
      }
      const row = (await client.query<any>(`with ranked as (
        select delay_ms,sum(event_count) over(order by delay_ms) as cumulative,sum(event_count) over() as total
        from upload_delay_counts where upload_id=$1)
        select min(delay_ms) filter(where cumulative>=ceil(total*0.50)) as p50,
        min(delay_ms) filter(where cumulative>=ceil(total*0.90)) as p90,
        min(delay_ms) filter(where cumulative>=ceil(total*0.95)) as p95,
        min(delay_ms) filter(where cumulative>=ceil(total*0.99)) as p99 from ranked`, [id])).rows[0];
      const percentiles = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value === null ? null : Number(value)])) as Percentiles;
      const data = derive(state, percentiles);
      const observation = await this.#bindObservation(client, state);
      await insertRecordData(client, { record: { manifest: state.manifest, events: [] }, short_signature: data.short_signature, stats: data.stats, signals: data.signals, observation });
      await client.query("update records set event_storage='chunks',observation_summary=$2::jsonb where record_hash=$1", [state.manifest.record_hash, JSON.stringify(observation)]);
      await client.query("update record_uploads set finalized_record_hash=$2,published_owner=true where upload_id=$1", [id, state.manifest.record_hash]);
      if (observation.observed_session_id) await client.query("update observed_sessions set finalized_record_hash=$2,observation_state=$3,finalized_at=now() where observed_session_id=$1", [observation.observed_session_id, state.manifest.record_hash, observation.state]);
      await client.query("delete from upload_delay_counts where upload_id=$1", [id]);
      return { record_hash: state.manifest.record_hash, short_signature: data.short_signature, created: true };
    });
  }
  async #bindObservation(client: PostgresQueryable, state: UploadState): Promise<RecordObservation> {
    if (!state.observation) return notRequestedObservation();
    if ("state" in state.observation) return unobservedObservation();
    const { observed_session_id, observed_token_hash } = state.observation;
    const session = (await client.query<any>("select token_hash,finalized_record_hash from observed_sessions where observed_session_id=$1 for update", [observed_session_id])).rows[0];
    if (!session || session.token_hash !== observed_token_hash) throw new ChunkedUploadError(404, "observation_unavailable");
    if (session.finalized_record_hash && session.finalized_record_hash !== state.manifest.record_hash) throw new ChunkedUploadError(409, "observed_session_finalized");
    const aggregate = (await client.query<any>(`select count(*)::integer as count,max(event_count) as last_count,
      min(observed_at) as first_at,max(observed_at) as last_at,
      bool_or(c.chain_tip is distinct from chunks.chain_tips[c.event_count-chunks.start_seq]) as mismatch
      from observed_checkpoints c left join lateral (select start_seq,chain_tips from record_event_chunks
        where upload_id=$2 and start_seq<c.event_count and end_seq>=c.event_count order by start_seq desc limit 1) chunks on true
      where c.observed_session_id=$1`, [observed_session_id, state.upload_id])).rows[0];
    if (!aggregate.count || aggregate.mismatch) throw new ChunkedUploadError(409, "observation_mismatch");
    // The public summary includes bounded anchors; validation above covers all.
    const rows = (await client.query<any>(`(select checkpoint_id,event_count,chain_tip,observed_at from observed_checkpoints where observed_session_id=$1 order by event_count limit 1)
      union (select checkpoint_id,event_count,chain_tip,observed_at from observed_checkpoints where observed_session_id=$1 order by event_count desc limit 31) order by event_count`, [observed_session_id])).rows;
    const observation = observationFromCheckpoints(observed_session_id, aggregate.last_count === state.next_seq ? "observed" : "partial",
      rows.map(row => ({ checkpoint_id: row.checkpoint_id, event_count: row.event_count, chain_tip: row.chain_tip, observed_at: new Date(row.observed_at).toISOString() })));
    return { ...observation, checkpoint_count: aggregate.count, first_observed_at: new Date(aggregate.first_at).toISOString(), last_observed_at: new Date(aggregate.last_at).toISOString(),
      server_observed_span_ms: new Date(aggregate.last_at).getTime() - new Date(aggregate.first_at).getTime() };
  }
  async page(record: StoredRecord, offset: number, limit: number): Promise<EventPage> {
    const upload = (await this.db.query<{ upload_id: string }>("select upload_id from record_uploads where finalized_record_hash=$1 and published_owner and next_seq=$2 limit 1", [record.manifest.record_hash, record.manifest.event_count])).rows[0];
    if (!upload) throw new ChunkedUploadError(404, "record_not_found");
    const rows = (await this.db.query<any>("select start_seq,events,chain_tips from record_event_chunks where upload_id=$1 and end_seq>=$2 and start_seq<$3 and start_seq>=$4 order by start_seq", [upload.upload_id, offset, offset + limit, Math.max(0, offset - MAX_EVENT_CHUNK)])).rows;
    const events: EventLog = []; let before: B3Hash | null = null, after: B3Hash | null = null;
    for (const row of rows) {
      if (offset > row.start_seq && offset <= row.start_seq + row.events.length) before = row.chain_tips[offset - row.start_seq - 1];
      for (let index = Math.max(0, offset - row.start_seq); index < row.events.length && row.start_seq + index < offset + limit; index++) { events.push(row.events[index]); after = row.chain_tips[index]; }
    }
    return { events, next_offset: offset + events.length < record.manifest.event_count ? offset + events.length : null,
      total_events: record.manifest.event_count, chain_tip_before: before, chain_tip_after: after ?? before };
  }
}
