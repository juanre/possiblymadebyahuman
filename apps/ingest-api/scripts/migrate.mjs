import { readFile } from 'node:fs/promises';
import pg from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const migrationPath = new URL('../../../packages/storage/migrations/001_init.sql', import.meta.url);
const sql = await readFile(migrationPath, 'utf8');
const { Client } = pg;
const client = new Client({ connectionString: databaseUrl });
await client.connect();
try {
  await client.query(sql);
  console.log('Migrations applied');
} finally {
  await client.end();
}
