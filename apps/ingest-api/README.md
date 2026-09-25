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
- Malformed payloads return `invalid_payload`. Valid UUID/session/token lookup failures return the uniform `observation_unavailable` body. Unfinalized observed sessions and their checkpoints have no automatic expiry, so authenticated sessions can retain evidence across long absences. Local producer discard does not delete server checkpoint metadata.

The implementation exposes a Fetch `Request` handler plus direct functions for tests and runtime server wiring.

## Runtime database posture

`src/server.ts` uses one shared `pg.Pool` per Node process. Configure it with `PG_POOL_MAX`/`DATABASE_POOL_MAX`, `PG_POOL_IDLE_TIMEOUT_MS`, `PG_POOL_CONNECTION_TIMEOUT_MS`, and `PG_STATEMENT_TIMEOUT_MS` (15 seconds by default). Keep pool sizes conservative for Neon and account for every deployed process. `POST /api/records` is protected by `RECORD_BODY_LIMIT_BYTES` (default 10 MB) and returns `413` for oversized bodies; new producers use resumable chunk publication for long sessions. The one-shot endpoint remains for bounded legacy clients and old tests.

`npm run migrate` applies ordered SQL migrations through the TypeScript migration manager. Applied migration versions/checksums are recorded in `schema_migrations`; reruns skip unchanged migrations and checksum drift fails before runtime readiness succeeds.

Validation also bounds work after JSON parsing: at most 131,072 events per
legacy one-shot request, 16 entries in other arrays, 64 fields per object,
128 characters per field name, 32 nesting levels, and two million visited
values. These limits return 400 even when the HTTP body fits the byte limit;
raising `RECORD_BODY_LIMIT_BYTES` does not raise them. Current producers use
4096-event chunks. The content check visits one child at a time, and malformed
event validation stops collecting diagnostics before running full verification.
Error responses contain at most 25 details plus a truncation notice.

Runtime admission is bounded before buffering API bodies. Defaults can be changed
with these environment variables (production Compose passes them through):

| Setting | Default | Behavior |
| --- | --- | --- |
| `MAX_IN_FLIGHT_API_REQUESTS` | 8 | Additional API requests receive 503 and `Retry-After: 1`; `/health` remains available. |
| `CHECKPOINT_BODY_LIMIT_BYTES` | 16384 | Checkpoint envelopes have a smaller limit than full records; the record limit remains an upper bound. |
| `HTTP_REQUEST_TIMEOUT_MS` | 30000 | Bounds receipt of HTTP headers/body; incomplete requests time out. |
| `PG_STATEMENT_TIMEOUT_MS` | 15000 | Bounds database statements and client query waits. |

These controls bound individual requests and concurrent work. They do not impose
per-user/IP rates, cumulative storage quotas, or retention/deletion policy. Set
those deployment policies at a trusted ingress boundary; do not treat forwarded
IP headers from arbitrary callers as an identity.

Migration `004_unknown_size_stats.sql` must run before this API version writes
nullable size totals/maxima. GET responses correct legacy derived size facts
from immutable events without rewriting old hashes, checkpoints or stored caches.

## Resumable publication and bounded reads

New producers persist a random lowercase UUIDv4 `upload_id` with their frozen
manifest before network work. This private identifier is the bearer capability
for resuming staging; it is never part of a public record response.

1. `POST /api/record-uploads` accepts `{upload_id, manifest, observation?}` and
   returns `{upload_id, next_seq, max_chunk_events:4096}`. Repeating the same
   manifest resumes the durable prefix. A changed manifest returns 409. If the
   hash is already published, `completed` contains the normal upload response.
2. `GET /api/record-uploads/:id` returns the same cursor. `POST
   /api/record-uploads/:id/chunks` accepts `{start_seq, events}` with 1–4096
   events. The server validates and commits the whole chunk atomically. Repeating
   an identical chunk is idempotent; conflicting chunks/offsets return 409.
3. `POST /api/record-uploads/:id/finalize` accepts `{}` and returns
   `{record_hash, short_signature, url, created}`. It verifies the full count,
   sealed hash and every bound checkpoint, computes exact delay percentiles in
   PostgreSQL, and publishes one immutable record in one transaction. Finalize
   retries return the existing result. An observation rejection can be retried
   with an explicitly unobserved envelope on begin, retaining the same prefix.

Upload request bodies are capped at 1 MiB (or the lower configured record cap).
Event chunks and per-delay counts stay in PostgreSQL; finalization does not
assemble the full log in API memory. The existing 10 MB one-shot endpoint and
inline records remain compatible. Legacy GET assembles at most 512 events for
new chunked records; larger records return 409
`chunked_record_requires_pagination`.

`GET /api/records/:id/summary` returns the normal public manifest, stats, signals
and observation, plus `events_page_size`, `first_event_t`, and `last_event_t`.
`GET /api/records/:id/events?offset=0&limit=4096` returns
`{events,next_offset,total_events,chain_tip_before,chain_tip_after}`. Offset is
zero-based; `next_offset` is null at the end and `chain_tip_before` is null at
zero. Pages are immutable once published. A reader must consume the complete
prefix and check the final sealed hash before reporting full verification.

Observation summaries include the first and latest 31 commitment anchors, with
an exact `checkpoint_count` and span over all stored commitments. Every
commitment, including those omitted from the summary, is checked at publication.
Migration `005_chunked_records.sql` must run before this API version accepts
chunk uploads. No automatic expiry, hidden eviction or public segmentation is
introduced; cumulative storage and admission policies remain deployment choices.

Default analyzers share one incremental implementation with bounded legacy array
callers. Configured custom analyzers that require a complete event array return
an explicit unavailable signal during chunked publication; they are not replaced
with defaults or invoked on an incomplete page. An empty configured analyzer list
remains empty. Supporting custom analyzers on long records requires a future
streaming analyzer interface.

The regular managed-database suite runs resume, atomic-chunk, observation,
collision and pagination tests. `PMBAH_SCALE_EVENTS=4000000 npm test` also enables
the intentionally optional four-million-event PostgreSQL publication and complete
paged verification test. It generates events in bounded batches and reports peak
sampled heap and elapsed time. The dedicated scale run passed with a 128 MiB Node
heap cap; this verifies process memory behavior, not a universal latency target.
