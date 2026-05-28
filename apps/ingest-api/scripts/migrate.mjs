import pg from 'pg';
import { applyMigrations, loadSqlMigrations } from '../../../packages/storage/src/migrations.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const migrations = await loadSqlMigrations();
const { Pool } = pg;
const pool = new Pool({ connectionString: databaseUrl, max: 1 });
try {
  const result = await applyMigrations(pool, migrations);
  console.log(`Migrations applied: ${result.applied.length}; skipped: ${result.skipped.length}`);
} finally {
  await pool.end();
}
