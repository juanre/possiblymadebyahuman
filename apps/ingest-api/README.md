# ingest API

Layer 2 ingestion service package.

## Responsibility

- `POST /api/observed-sessions/:id/checkpoints`, `POST /api/records`, `GET /api/records/:short_signature_or_hash`, and `GET /api/health` endpoint handlers.
- Schema validation through `packages/format`.
- Public content-blind enforcement: plaintext/content-bearing fields are rejected.
- Hash-chain verification, content addressing, `ingested_server_t` stamping, short-signature generation, immutable storage, and record stats computation.
- Server-observed process commitments: checkpoint append/receipt, token-hash binding, final prefix verification, and observation metadata on fetched records.
- Returning the content-blind `{ manifest, events, stats, signals, observation }` record shape for the web app.

## Non-responsibility

- Producer capture logic.
- Frontend presentation.
- Plaintext storage in public mode.
- Human/AI verdicts, scores, or badges.
- User management, auth, public DELETE endpoint, or owner-delete flow in v0.
- Analyzer implementation; the API stores/returns analyzer signals but does not define detector-style verdicts.

Observation checkpoints are activity-driven producer calls: first captured event, approximately once per minute only when new events exist since the last checkpoint, after a configured event-count threshold, and final flush before upload when needed. The server does not receive idle heartbeats and does not receive text. A checkpoint is a server-received commitment to `event_count` plus `chain_tip`; the matching public event prefix is checked only when the final record is uploaded.

Checkpoint API contract:

- `POST /api/observed-sessions/:session_id/checkpoints` with `{event_count, chain_tip}` creates the observed session on first successful commitment and returns `{observed_session_id, token, checkpoint_id, event_count, chain_tip, server_t, created}`.
- Later checkpoint calls include `{event_count, chain_tip, token}`. The server stores only `token_hash`.
- `POST /api/records` may include sibling `{observation:{observed_session_id, token}}`, or `{observation:{state:"unobserved"}}` when observation was requested but no commitment succeeded; `GET /api/records/:id` returns sibling `{observation:{state, commitments, first_observed_at, last_observed_at, server_observed_span_ms}}`.
- Public observation states are `observed`, `partial`, `unobserved`, and `not_requested`; prefix mismatch at final upload is rejected rather than published as a normal record.
- Malformed payloads return `invalid_payload`. Valid UUID/session/token lookup failures return the uniform `observation_unavailable` body. Unfinalized observed sessions expire after seven days from last checkpoint or creation.

The implementation exposes a Fetch `Request` handler plus direct functions for tests and runtime server wiring.

## Runtime database posture

`src/server.ts` uses one shared `pg.Pool` per Node process. Configure it with `PG_POOL_MAX`/`DATABASE_POOL_MAX`, `PG_POOL_IDLE_TIMEOUT_MS`, `PG_POOL_CONNECTION_TIMEOUT_MS`, and optional `PG_STATEMENT_TIMEOUT_MS`. Keep pool sizes conservative for Neon and account for every deployed process. `POST /api/records` is protected by `RECORD_BODY_LIMIT_BYTES` (default 10 MB) and returns `413` for oversized bodies; operators can raise the limit for unusually long capture sessions after checking proxy and database limits.

`npm run migrate` applies ordered SQL migrations through the TypeScript migration manager. Applied migration versions/checksums are recorded in `schema_migrations`; reruns skip unchanged migrations and checksum drift fails before runtime readiness succeeds.
