// Deletes unfinalized upload staging untouched for --older-than-days (default 30).
import { parseArgs } from 'node:util';
import pg from 'pg';
import { DEFAULT_ABANDONED_UPLOAD_DAYS, deleteAbandonedUploads } from '../../../packages/storage/src/maintenance.ts';

try {
  const { values } = parseArgs({ options: { 'older-than-days': { type: 'string', default: String(DEFAULT_ABANDONED_UPLOAD_DAYS) } } });
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const olderThanDays = Number(values['older-than-days']);
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const deleted = await deleteAbandonedUploads(pool, { olderThanDays });
    console.log(`deleted ${deleted.uploads} abandoned unfinalized uploads untouched for ${olderThanDays} days (${deleted.chunks} staged chunks)`);
  } finally {
    await pool.end();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
