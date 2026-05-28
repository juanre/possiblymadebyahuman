import { runMigrations } from '../src/migrate.ts';

try {
  const result = await runMigrations();
  console.log(`Migrations applied: ${result.applied}; skipped: ${result.skipped}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
