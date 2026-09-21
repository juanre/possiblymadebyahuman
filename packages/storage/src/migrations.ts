import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);

export type Migration = {
  version: string;
  name: string;
  sql: string;
};

export type AppliedMigration = {
  version: string;
  name: string;
  checksum: string;
};

export type MigrationApplyResult = {
  applied: AppliedMigration[];
  skipped: AppliedMigration[];
};

export type MigrationQueryable = {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

export type MigrationClient = MigrationQueryable & {
  release?: () => void;
};

export type MigrationDatabase = MigrationQueryable & {
  connect?: () => Promise<MigrationClient>;
};

// Arbitrary but fixed key so concurrent app instances serialize their startup migrations.
export const MIGRATION_ADVISORY_LOCK_KEY = 7_162_824_871;
// Waiting longer than this for another instance's migration run means it is stuck;
// failing the start is better than a deploy that hangs.
export const MIGRATION_LOCK_TIMEOUT = "30s";

export class MigrationChecksumMismatchError extends Error {
  constructor(version: string, expected: string, actual: string) {
    super(`migration ${version} checksum mismatch: stored ${actual}, current ${expected}`);
    this.name = "MigrationChecksumMismatchError";
  }
}

export class MigrationOrderingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationOrderingError";
  }
}

export async function loadSqlMigrations(migrationsDir: URL | string = DEFAULT_MIGRATIONS_DIR): Promise<Migration[]> {
  const directory = migrationsDir instanceof URL ? fileURLToPath(migrationsDir) : migrationsDir;
  const entries = await readdir(directory);
  return Promise.all(entries
    .filter((entry) => /^\d{3,}_.*\.sql$/.test(entry))
    .sort()
    .map(async (entry) => {
      const sql = await readFile(join(directory, entry), "utf8");
      const [version] = entry.split("_");
      if (!version) throw new MigrationOrderingError(`migration file ${entry} is missing a version prefix`);
      return { version, name: basename(entry, ".sql"), sql };
    }));
}

/**
 * Applies pending migrations in one transaction held under a transaction-scoped
 * advisory lock. The connection may go through a pooler in transaction mode,
 * which can spread statements outside a transaction across backends; a
 * session-level lock could then be taken on one backend and never released.
 * Everything, lock included, therefore lives inside the single transaction.
 */
export async function applyMigrations(db: MigrationDatabase, migrations: Migration[]): Promise<MigrationApplyResult> {
  const ordered = validateAndOrderMigrations(migrations);
  const client = db.connect ? await db.connect() : db;
  try {
    return await withMigrationTransaction(client, async () => {
      await client.query(`set local lock_timeout = '${MIGRATION_LOCK_TIMEOUT}'`);
      await client.query("select pg_advisory_xact_lock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);
      return applyOrderedMigrations(client, ordered);
    });
  } finally {
    if ("release" in client) client.release?.();
  }
}

async function applyOrderedMigrations(client: MigrationQueryable, ordered: Migration[]): Promise<MigrationApplyResult> {
  await ensureSchemaMigrationsTable(client);

  const existing = await client.query<AppliedMigration>(
    "select version, name, checksum from schema_migrations order by version",
  );
  const byVersion = new Map(existing.rows.map((row) => [row.version, row]));
  const knownVersions = new Set(ordered.map((migration) => migration.version));
  for (const row of existing.rows) {
    if (!knownVersions.has(row.version)) {
      throw new MigrationOrderingError(`database has unknown migration version ${row.version}; refusing partial migration set`);
    }
  }

  const result: MigrationApplyResult = { applied: [], skipped: [] };
  for (const migration of ordered) {
    const checksum = checksumMigrationSql(migration.sql);
    const stored = byVersion.get(migration.version);
    if (stored) {
      if (stored.checksum !== checksum) throw new MigrationChecksumMismatchError(migration.version, checksum, stored.checksum);
      result.skipped.push(stored);
      continue;
    }

    await client.query(migration.sql);
    await client.query(
      "insert into schema_migrations (version, name, checksum) values ($1, $2, $3)",
      [migration.version, migration.name, checksum],
    );
    result.applied.push({ version: migration.version, name: migration.name, checksum });
  }

  return result;
}

export function checksumMigrationSql(sql: string): string {
  return `sha256:${createHash("sha256").update(sql, "utf8").digest("hex")}`;
}

export async function ensureSchemaMigrationsTable(db: MigrationQueryable): Promise<void> {
  await db.query(`create table if not exists schema_migrations (
    version text primary key,
    name text not null,
    checksum text not null,
    applied_at timestamptz not null default now()
  )`);
}

function validateAndOrderMigrations(migrations: Migration[]): Migration[] {
  const ordered = [...migrations].sort((left, right) => left.version.localeCompare(right.version));
  for (let index = 0; index < ordered.length; index += 1) {
    const migration = ordered[index] as Migration;
    if (!/^\d{3,}$/.test(migration.version)) {
      throw new MigrationOrderingError(`migration version ${migration.version} must be a zero-padded number`);
    }
    if (index > 0 && (ordered[index - 1] as Migration).version === migration.version) {
      throw new MigrationOrderingError(`duplicate migration version ${migration.version}`);
    }
  }
  return ordered;
}

async function withMigrationTransaction<T>(client: MigrationQueryable, fn: () => Promise<T>): Promise<T> {
  try {
    await client.query("begin");
    const value = await fn();
    await client.query("commit");
    return value;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  }
}
