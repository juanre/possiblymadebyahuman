# `@possiblymadebyahuman/storage`

Backend storage abstraction package.

## Responsibility

- Immutable record-store interface.
- Lookup by full `record_hash` and by `short_signature`.
- Record stats, analysis-result, optional `text_binding`, and server-observed commitment persistence shapes.
- Postgres schema SQL in ordered `migrations/*.sql` files.
- TypeScript migration manager with `schema_migrations` checksum tracking.
- A Postgres adapter plus in-memory implementation for API/unit tests.

Uploaded records are permanent by default in v0. Owner-delete is a future option and is not implemented in M2.

`PostgresRecordStore` accepts a `pg.Pool`-like object. Writes that span `records`, `record_stats`, `analysis_results`, and observation-finalization metadata check out one client, run `BEGIN`/`COMMIT`/`ROLLBACK` on that client, and release it in `finally`.

Observed-session storage stores only `token_hash`, public chain-tip commitments, event counts, and server receive timestamps. Bearer tokens are never returned by record lookup and are not public record content. Finalizing a bound observation locks the observed-session row, re-reads the checkpoint set inside the transaction, and checks those commitments against the final event-chain prefixes before the record is inserted/finalized. Unfinalized observed sessions are expired opportunistically after seven days from last checkpoint or creation; expired/missing/wrong-token lookups surface through the API as the same `observation_unavailable` shape.

## Non-responsibility

- HTTP routing.
- Analyzer execution policy.
- Frontend presentation.
- Plaintext storage for public records.
- User management or public deletion API in v0.

The public manifest field is `parent_record`; the Postgres/storage column is `parent_record_hash`. Format `0.2` `text_binding` is stored as JSONB commitment metadata only; no plaintext text column exists.
