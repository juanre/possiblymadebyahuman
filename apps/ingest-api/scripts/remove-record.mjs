// Removes one published record by short signature or full hash. Without
// --confirm it only reports what would be removed. See docs/operations-record-removal.md.
import { parseArgs } from 'node:util';
import pg from 'pg';
import { removeRecord } from '../../../packages/storage/src/maintenance.ts';

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { confirm: { type: 'boolean', default: false } } });
  if (positionals.length !== 1) throw new Error('usage: remove-record.mjs <short-signature-or-hash> [--confirm]');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const result = await removeRecord(pool, positionals[0], { confirm: values.confirm });
    const detail = `${result.observed_sessions} observed session(s), ${result.uploads} upload(s), ${result.chunks} event chunk(s); `
      + `${result.continuations} continuation(s) stay published and now name a missing parent`;
    if (result.removed) console.log(`removed ${result.record_hash} (${result.short_signature}) with ${detail}`);
    else console.log(`would remove ${result.record_hash} (${result.short_signature}) with ${detail}. Nothing changed; rerun with --confirm to remove it.`);
  } finally {
    await pool.end();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
