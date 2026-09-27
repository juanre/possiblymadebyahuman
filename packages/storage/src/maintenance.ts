import type { PostgresQueryable } from "./index.ts";

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
