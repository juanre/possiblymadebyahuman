import type { PostgresDatabase, PostgresQueryable } from "./index.ts";

export type RecordRemoval = {
  record_hash: string;
  short_signature: string;
  removed: boolean;
  observed_sessions: number;
  uploads: number;
  chunks: number;
  continuations: number;
};

/**
 * Removes one published record, addressed by short signature or full hash, in
 * one transaction: its stats and signals, the observed session it finalized
 * with its checkpoints, every upload staging or owning its hash with their
 * chunks, and the record row. The hash is recorded in removed_records so it
 * cannot be published again. Continuations stay published and self-verifying;
 * their signed parent hash then addresses nothing. Without `confirm` the same
 * work is rolled back and only reported.
 */
export async function removeRecord(db: PostgresDatabase, id: string, { confirm }: { confirm: boolean }): Promise<RecordRemoval> {
  const client = db.connect ? await db.connect() : db;
  try {
    await client.query("begin");
    const found = (await client.query<{ record_hash: string }>(
      "select record_hash from records where record_hash = $1 or short_signature = $1", [id])).rows[0];
    if (!found) throw new Error(`no stored record has short signature or hash ${id}`);
    // The records insert trigger takes this lock, so a concurrent publication
    // of the same hash either finishes first and is removed, or sees the tombstone.
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [found.record_hash]);
    const row = (await client.query<{ record_hash: string; short_signature: string }>(
      "select record_hash, short_signature from records where record_hash = $1 for update", [found.record_hash])).rows[0];
    if (!row) throw new Error(`no stored record has short signature or hash ${id}`);
    const hash = row.record_hash;
    const count = async (sql: string) => Number((await client.query<{ count: string }>(sql, [hash])).rows[0]!.count);
    const observed_sessions = await count("with deleted as (delete from observed_sessions where finalized_record_hash = $1 returning 1) select count(*) from deleted");
    const uploads = `select upload_id from record_uploads where finalized_record_hash = $1 or manifest->>'record_hash' = $1`;
    const chunks = await count(`with deleted as (delete from record_event_chunks where upload_id in (${uploads}) returning 1) select count(*) from deleted`);
    await client.query(`delete from upload_delay_counts where upload_id in (${uploads})`, [hash]);
    const uploadCount = await count(`with deleted as (delete from record_uploads where upload_id in (${uploads}) returning 1) select count(*) from deleted`);
    await client.query("delete from records where record_hash = $1", [hash]);
    await client.query("insert into removed_records(record_hash) values ($1)", [hash]);
    const continuations = await count("select count(*) from records where parent_record_hash = $1");
    await client.query(confirm ? "commit" : "rollback");
    return { record_hash: hash, short_signature: row.short_signature, removed: confirm, observed_sessions, uploads: uploadCount, chunks, continuations };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    if ("release" in client) client.release?.();
  }
}

// Producers keep a frozen record and its upload_id until publication succeeds,
// and beginning a missing upload stages it again from event zero. Deleting
// staging that nobody has touched for a month therefore loses no record.
export const DEFAULT_ABANDONED_UPLOAD_DAYS = 30;

/**
 * Deletes unfinalized uploads, with their staged chunks and delay counts, that
 * have not been begun or appended to for `olderThanDays`. Uploads locked by a
 * concurrent append are skipped. Finalized uploads own published event pages
 * and are never touched.
 */
export async function deleteAbandonedUploads(db: PostgresQueryable, { olderThanDays = DEFAULT_ABANDONED_UPLOAD_DAYS } = {}): Promise<{ uploads: number; chunks: number }> {
  if (!Number.isSafeInteger(olderThanDays) || olderThanDays < 1) throw new RangeError("olderThanDays must be a positive integer");
  const row = (await db.query<{ uploads: number; chunks: number }>(`with stale as (
      select upload_id from record_uploads
      where finalized_record_hash is null and updated_at < now() - make_interval(days => $1)
      for update skip locked),
    chunks as (delete from record_event_chunks where upload_id in (select upload_id from stale) returning 1),
    delays as (delete from upload_delay_counts where upload_id in (select upload_id from stale) returning 1),
    uploads as (delete from record_uploads where upload_id in (select upload_id from stale) returning 1)
    select (select count(*) from uploads)::integer as uploads, (select count(*) from chunks)::integer as chunks,
      (select count(*) from delays)::integer as delays`, [olderThanDays])).rows[0]!;
  return { uploads: row.uploads, chunks: row.chunks };
}
