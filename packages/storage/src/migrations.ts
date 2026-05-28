import { createHash } from "node:crypto";

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

export async function applyMigrations(db: MigrationDatabase, migrations: Migration[]): Promise<MigrationApplyResult> {
  const ordered = validateAndOrderMigrations(migrations);
  await ensureSchemaMigrationsTable(db);

  const existing = await db.query<AppliedMigration>(
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

    await withMigrationTransaction(db, async (client) => {
      await client.query(migration.sql);
      await client.query(
        "insert into schema_migrations (version, name, checksum) values ($1, $2, $3)",
        [migration.version, migration.name, checksum],
      );
    });
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

async function withMigrationTransaction<T>(db: MigrationDatabase, fn: (client: MigrationQueryable) => Promise<T>): Promise<T> {
  const client = db.connect ? await db.connect() : db;
  try {
    await client.query("begin");
    const value = await fn(client);
    await client.query("commit");
    return value;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    if ("release" in client) client.release?.();
  }
}
