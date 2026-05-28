import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { applyMigrations } from '../../../packages/storage/src/migrations.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const migrationsDir = fileURLToPath(new URL('../../../packages/storage/migrations/', import.meta.url));
const entries = await readdir(migrationsDir);
const migrations = await Promise.all(entries
  .filter((entry) => /^\d{3,}_.*\.sql$/.test(entry))
  .sort()
  .map(async (entry) => {
    const path = join(migrationsDir, entry);
    const sql = await readFile(path, 'utf8');
    const [version] = entry.split('_');
    return { version, name: basename(entry, '.sql'), sql };
  }));

const { Pool } = pg;
const pool = new Pool({ connectionString: databaseUrl, max: 1 });
try {
  const result = await applyMigrations(pool, migrations);
  console.log(`Migrations applied: ${result.applied.length}; skipped: ${result.skipped.length}`);
} finally {
  await pool.end();
}
