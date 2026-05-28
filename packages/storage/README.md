# `@possiblymadebyahuman/storage`

Backend storage abstraction package.

## Responsibility

- Immutable record-store interface.
- Lookup by full `record_hash` and by `short_signature`.
- Record stats and analysis-result persistence shapes.
- Postgres schema SQL in `migrations/001_init.sql`.
- TypeScript migration manager with `schema_migrations` checksum tracking.
- A Postgres adapter plus in-memory implementation for API/unit tests.

Uploaded records are permanent by default in v0. Owner-delete is a future option and is not implemented in M2.

`PostgresRecordStore` accepts a `pg.Pool`-like object. Writes that span `records`, `record_stats`, and `analysis_results` check out one client, run `BEGIN`/`COMMIT`/`ROLLBACK` on that client, and release it in `finally`.

## Non-responsibility

- HTTP routing.
- Analyzer execution policy.
- Frontend presentation.
- Plaintext storage for public records.
- User management or public deletion API in v0.

The public manifest field is `parent_record`; the Postgres/storage column is `parent_record_hash`.
