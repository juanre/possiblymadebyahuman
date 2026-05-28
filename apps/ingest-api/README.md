# ingest API

Layer 2 ingestion service package.

## Responsibility

- `POST /api/records`, `GET /api/records/:short_signature_or_hash`, and `GET /api/health` endpoint handlers.
- Schema validation through `packages/format`.
- Public content-opaque enforcement: plaintext/content-bearing fields are rejected.
- Hash-chain verification, content addressing, `ingested_server_t` stamping, short-signature generation, immutable storage, and record stats computation.
- Returning the content-opaque `{ manifest, events, stats, signals }` record shape for the web app.

## Non-responsibility

- Producer capture logic.
- Frontend presentation.
- Plaintext storage in public mode.
- Human/AI verdicts, scores, or badges.
- User management, auth, public DELETE endpoint, or owner-delete flow in v0.
- Analyzer implementation; the API stores/returns analyzer signals but does not define detector-style verdicts.

The implementation exposes a Fetch `Request` handler plus direct functions for tests and runtime server wiring.

## Runtime database posture

`src/server.ts` uses one shared `pg.Pool` per Node process. Configure it with `PG_POOL_MAX`/`DATABASE_POOL_MAX`, `PG_POOL_IDLE_TIMEOUT_MS`, `PG_POOL_CONNECTION_TIMEOUT_MS`, and optional `PG_STATEMENT_TIMEOUT_MS`. Keep pool sizes conservative for Neon and account for every deployed process. `POST /api/records` is protected by `RECORD_BODY_LIMIT_BYTES` (default 10 MB) and returns `413` for oversized bodies; operators can raise the limit for unusually long capture sessions after checking proxy and database limits.

`npm run migrate` applies ordered SQL migrations through the TypeScript migration manager. Applied migration versions/checksums are recorded in `schema_migrations`; reruns skip unchanged migrations and checksum drift fails before runtime readiness succeeds.
