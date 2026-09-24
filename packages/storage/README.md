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

Observed-session storage stores only `token_hash`, public chain-tip commitments, event counts, and server receive timestamps. Bearer tokens are never returned by record lookup and are not public record content. Finalizing a bound observation locks the observed-session row, re-reads the checkpoint set inside the transaction, and checks those commitments against the final event-chain prefixes before the record is inserted/finalized. Unfinalized observed sessions do not expire automatically: the original checkpoint evidence remains available across pauses lasting months. Missing/wrong-token lookups surface through the API as the same `observation_unavailable` shape. No checkpoints are invented during idle periods.

## Non-responsibility

- HTTP routing.
- Analyzer execution policy.
- Frontend presentation.
- Plaintext storage for public records.
- User management or public deletion API in v0.

The public manifest field is `parent_record`; the Postgres/storage column is `parent_record_hash`. Format `0.2` `text_binding` is stored as JSONB commitment metadata only; no plaintext text column exists.

Migration `003_long_session_times` widens elapsed duration, delay and active/idle millisecond columns to `bigint`. Calendar timestamps remain `timestamptz`; counts and positions retain their existing bounds. The adapter decodes PostgreSQL bigint strings into JSON numbers only within JavaScript’s safe integer range, rejecting lossy values. Existing events, hashes and signatures are unchanged.

Migration `004_unknown_size_stats` allows null insertion/deletion totals and largest-insert statistics when a required event size was not measured. Apply it before deploying the updated API. Existing caches remain intact; public read projections derive corrected size facts from the immutable event log. Edit-topology 0.2.0 uses the same uncertainty rules and includes its size thresholds. Historical custom threshold counts are preserved for fully measured logs and shown as unavailable for partially measured logs because their original thresholds were not stored.

Migration `005_chunked_records` adds private upload cursors, immutable event chunks
of at most 4096 entries and exact delay-frequency counts. Each accepted chunk
updates its cursor/hash and fixed-size analyzer state in one transaction.
Finalization locks the upload and observed session, checks all commitments, and
atomically writes the public record/stats/signals. New records keep their legacy
`events` column empty and use `event_storage='chunks'`; old inline records remain
readable. Paged queries use the `(upload_id,start_seq)` index and bounded ranges.
Exact percentiles use PostgreSQL cumulative counts, so no approximation or
whole-log allocation is needed in the API process. Public observation summaries
return at most 32 anchors and exact aggregate count/span.

Only the upload transaction marked `published_owner` supplies public pages;
other attempts for the same record hash cannot replace that source. Exact delay
counts are deleted after their statistics are committed, and completed duplicate
uploads discard their redundant chunks. Canonical chunks retain per-event tips
for checkpoint validation and arbitrary page-boundary commitments. Event storage
therefore grows with the log; API working memory stays bounded by one chunk.
