import pg from "pg";

import { applyMigrations, loadSqlMigrations } from "../../../packages/storage/src/migrations.ts";

export async function runMigrations(databaseUrl = process.env.DATABASE_URL): Promise<{ applied: number; skipped: number }> {
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const migrations = await loadSqlMigrations();
  const { Pool } = pg;
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const result = await applyMigrations(pool, migrations);
    return { applied: result.applied.length, skipped: result.skipped.length };
  } finally {
    await pool.end();
  }
}
