# possiblymadebyahuman

`possiblymadebyahuman` records the *shape* of a writing process — operation positions, lengths, timing, and source classification — and presents it as a content-opaque, hash-addressed process record. The record never contains, stores, or reconstructs the text that was written.

It is **not** a human/AI detector. It does not emit humanness verdicts, confidence percentages, or certification-style badges. The allowed claim is just: this record shows the shape of an editing process.

The public service is content-blind: uploaded records store mutation structure, metadata, statistics, and analyzer facts, not plaintext writing. Plaintext belongs only in local replay flows or test fixtures.

`possiblymadebyahuman` is most certainly _not_ made by a human. It is instead made by a team of agents coordinating with [https://aweb.ai](aweb.ai). The human is only the instigator, and also somehow responsible for the result even though he has not actually looked at the code. His only real contribution has been the line drawing in the home page. He also plans to document how long it took from the first idea to the release of the site, as a note for posterity.

## Current milestone

Release-readiness work is in progress. Implemented pieces include the content-opaque record format, ingest API, immutable Postgres storage, analyzer facts, Docker/local Postgres stack, and Vite public record page. Remaining release work is tracked in aweb tasks; do not treat a local feature demo as release-ready until the release-readiness task is reviewed.

## Browser extension distribution prep

Public v0 requires a real Chrome Web Store install path for the browser extension; do not publish placeholder or "coming soon" install links. Packaging/release details live in [`docs/browser-extension-release.md`](docs/browser-extension-release.md). Draft listing, privacy-disclosure, permission-justification, and human publisher checklists live in [`docs/chrome-web-store-prep.md`](docs/chrome-web-store-prep.md). Those documents are preparatory only until the extension implementation, package artifact, human approval, and real Chrome Web Store URL exist.

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
make build-site             # build the Hugo landing/docs into apps/site/public
make dev-site               # run the Hugo dev server while editing the site (override port with SITE_PORT=...)
make extension-build        # build the Chrome/Chromium extension into apps/browser-extension/dist
make extension-package      # build deterministic Chrome/Chromium extension zip
make test-web-browser       # build the record app and run the Playwright smoke
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
- `RECORD_BODY_LIMIT_BYTES` default `10000000` (10 MB); oversized `POST /api/records` requests return `413`. Operators can raise this for unusually long capture sessions after checking reverse-proxy and Postgres limits.

Run migrations before starting a production container:

```bash
DATABASE_URL='postgresql://...' make migrate
# or for compose-managed prod-like runs:
make prod-container-migrate PROD_ENV_FILE=.env.localprod
```

Migration posture is pgdbm-style but TypeScript-native: `schema_migrations` records ordered `NNN_name.sql` migrations with SHA-256 checksums; reruns are idempotent and checksum drift fails. Before adding `002_*`, include tests for ordering/checksum behavior and a rollback/restore plan for production data.

## Release and Render deployment

A pushed tag matching `v*` triggers `.github/workflows/release-image.yml`. The workflow builds the production Dockerfile for `linux/amd64` and `linux/arm64`, pushes GHCR images under `ghcr.io/<owner>/<repo>`, and uploads the deterministic browser-extension zip as a GitHub Actions artifact. The Makefile default `PROD_IMAGE` points at `ghcr.io/juanre/possiblymadebyahuman:latest`; forks should override `PROD_IMAGE=ghcr.io/<owner>/<repo>:<tag>` when validating or deploying.

- full semver, for example `ghcr.io/juanre/possiblymadebyahuman:0.1.0`
- major/minor, for example `:0.1`
- git SHA
- `:latest`

Do not push tags until the human explicitly approves release. The Makefile release surface is:

```bash
make release-ready                         # checks + browser smoke + release image build
make ship-tag VERSION=0.1.0                # runs release-ready, tags v0.1.0, pushes the tag
make release-build-image RELEASE_IMAGE=possiblymadebyahuman-local
make release-build-image-nocache RELEASE_IMAGE=possiblymadebyahuman-local
make extension-package                    # writes apps/browser-extension/dist/possiblymadebyahuman-extension-<version>.zip
```

Render setup:

1. Create a Render Web Service using the GHCR image, preferably an immutable version tag such as `ghcr.io/juanre/possiblymadebyahuman:0.1.0`.
2. Ensure Render can pull the image: make the package public or grant Render registry credentials for GHCR.
3. Set environment variables from `.env.production.example` in Render. The real `DATABASE_URL` comes from Neon and must not be committed.
4. Render supplies `PORT`; keep `PUBLIC_BASE_URL` set to the production HTTPS origin.
5. Use the image default command. Container startup runs checked migrations before the HTTP server starts; `/ready` will not go green until required migrations are present.

Prod-like local validation against an external Neon database:

```bash
cp .env.localprod.example .env.localprod  # fill DATABASE_URL; do not commit
make prod-container-migrate PROD_ENV_FILE=.env.localprod PROD_IMAGE=ghcr.io/juanre/possiblymadebyahuman:0.1.0
make prod-container PROD_ENV_FILE=.env.localprod PROD_IMAGE=ghcr.io/juanre/possiblymadebyahuman:0.1.0
make prod-container-down PROD_ENV_FILE=.env.localprod PROD_IMAGE=ghcr.io/juanre/possiblymadebyahuman:0.1.0
```
