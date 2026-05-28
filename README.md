# possiblymadebyahuman

`possiblymadebyahuman` records the shape of a writing process and presents it as a replayable, hash-addressed writing record.

It is **not** a human/AI detector. It must not emit humanness verdicts, confidence percentages, or certification-style badges. The allowed claim is narrower and more honest: this record shows the shape of an editing process; it does not prove who originated the ideas.

The public service is content-blind by default: uploaded records store mutation structure, metadata, statistics, and analyzer facts, not plaintext writing. Plaintext belongs only in local replay flows or test fixtures.

## Current milestone

Release-readiness work is in progress. Implemented pieces include the content-blind record format, ingest API, immutable Postgres storage, analyzer facts, Docker/local Postgres stack, and Vite public record page. Remaining release work is tracked in aweb tasks; do not treat a local feature demo as release-ready until the release-readiness task is reviewed.

## Commands

The Makefile is the main management surface:

```bash
make help
make install
make check
make docker-build
make local-container
make local-container-test  # full local Docker+Postgres HTTP e2e journey
make local-container-down
```

Equivalent npm checks remain available:

```bash
npm install
npm run typecheck
npm test
npm run check
```

## Database operations

Runtime uses one shared `pg.Pool` per Node process rather than one shared client. Defaults are intentionally conservative for Neon/serverless Postgres:

- `PG_POOL_MAX` or `DATABASE_POOL_MAX` default `5`
- `PG_POOL_IDLE_TIMEOUT_MS` default `30000`
- `PG_POOL_CONNECTION_TIMEOUT_MS` default `5000`
- `PG_STATEMENT_TIMEOUT_MS`/`PG_QUERY_TIMEOUT_MS` optional statement/query timeout
- `RECORD_BODY_LIMIT_BYTES` default `1000000`; oversized `POST /api/records` requests return `413`

Run migrations before starting a production container:

```bash
DATABASE_URL='postgresql://...' make migrate
# or for compose-managed prod-like runs:
make prod-container-migrate PROD_ENV_FILE=.env.localprod
```

Migration posture is pgdbm-style but TypeScript-native: `schema_migrations` records ordered `NNN_name.sql` migrations with SHA-256 checksums; reruns are idempotent and checksum drift fails. Before adding `002_*`, include tests for ordering/checksum behavior and a rollback/restore plan for production data.
