# possiblymadebyahuman

`possiblymadebyahuman` records how a piece of writing was edited and publishes that record at a short link anyone can check. A record holds the shape of the editing: when each edit happened, where it landed, how large it was, and whether it was typed, pasted or cut. It never contains the text itself.

Try it at [possiblymadebyahuman.com](https://possiblymadebyahuman.com), or open [an example record](https://possiblymadebyahuman.com/8MxUYwiQ3q).

A record describes a writing process and leaves its meaning to the reader. It carries no humanness score, verdict or badge; the site explains [what a record can and cannot show](https://possiblymadebyahuman.com/docs/what-pmbah-does/).

`possiblymadebyahuman` is most certainly _not_ made by a human. It is instead made by a team of agents coordinating with [aweb.ai](https://aweb.ai). The human is only the instigator, and also somehow responsible for the result even though he has not actually looked at the code. His only real contribution has been the line drawing in the home page. He also plans to document how long it took from the first idea to the release of the site, as a note for posterity.

## Ways to write a record

- **Chrome extension.** Records the text boxes you choose on any website: comments, forum replies, email. See [how to install and use it](https://possiblymadebyahuman.com/docs/browser-extension/). Until the Chrome Web Store listing is live, it installs from the ZIP attached to each [GitHub release](https://github.com/juanre/possiblymadebyahuman/releases).
- **The writing page.** [`/write`](https://possiblymadebyahuman.com/write) needs no installation and keeps several drafts in your browser. See [writing in the browser](https://possiblymadebyahuman.com/docs/write/).
- **Emacs.** `pmbah-mode` records a buffer. See [the Emacs guide](https://possiblymadebyahuman.com/docs/emacs/) and [`producers/emacs/README.md`](producers/emacs/README.md).

## How a record works

Each edit becomes an event in a log, and the events are linked in a BLAKE3 hash chain whose final hash identifies the record. While you write, the producer sends the service checkpoints (an event count and a chain hash, never text), so the service can confirm when it saw the writing unfold. Finishing signs the end time into the record and publishes it at a short link.

Optionally, the producer also computes a salted commitment to the letters and digits of the finished text, on your machine, and uploads only that commitment. A reader who has a copy of the text can then check in their own browser whether its wording matches.

Anyone can recompute a record's hash chain in the browser. The site documents [reading a record](https://possiblymadebyahuman.com/docs/records/), [verification](https://possiblymadebyahuman.com/docs/verification/), [server checkpoints](https://possiblymadebyahuman.com/docs/server-observed-commitments/), [checking a document](https://possiblymadebyahuman.com/docs/checking-a-document/) and the [threat model](https://possiblymadebyahuman.com/docs/threat-model/). The format itself is specified in [`docs/spec.md`](docs/spec.md) and [`docs/text-binding.md`](docs/text-binding.md), with conformance vectors in [`packages/conformance`](packages/conformance).

## Privacy

The service stores event structure, metadata, statistics and analyzer facts, never the writing. Producers may read editor text briefly to measure edits or compute the text commitment, then discard it; they never keep, reconstruct or upload it. Drafts on `/write` are saved only in the writer's browser. The [privacy page](https://possiblymadebyahuman.com/docs/privacy/) has the details.

## Repository layout

| Path | What it is |
| --- | --- |
| [`apps/site`](apps/site) | Hugo site: the landing page and docs |
| [`apps/web`](apps/web) | React app for record pages and the `/write` drafting page |
| [`apps/ingest-api`](apps/ingest-api) | Node service that accepts, stores and serves records |
| [`apps/browser-extension`](apps/browser-extension) | Chrome MV3 extension |
| [`producers/emacs`](producers/emacs) | Emacs producer |
| [`packages/format`](packages/format) | Event-log format, hash chain and verification |
| [`packages/producer-core`](packages/producer-core) | Content-blind producer kernel shared by the extension and `/write` |
| [`packages/browser-capture`](packages/browser-capture), [`packages/browser-storage`](packages/browser-storage) | Browser edit capture and the IndexedDB journal |
| [`packages/analyzers`](packages/analyzers) | Descriptive statistics computed from records |
| [`packages/storage`](packages/storage) | Storage layer for the service |
| [`packages/conformance`](packages/conformance) | Golden vectors every producer and format implementation must pass |

Architecture and milestone boundaries live in [`docs/sot.md`](docs/sot.md). Bugs and open work are tracked in [GitHub issues](https://github.com/juanre/possiblymadebyahuman/issues).

## Development

### Commands

The Makefile is the main management surface:

```bash
make help
make install
make test-db               # PostgreSQL server for pgdbm fixtures
make check
make docker-build
make local-container
make local-container-test  # full local Docker+Postgres HTTP e2e journey
make local-container-down
make local-container-reset # stop local stack and remove the local Postgres volume
make build-site             # build the Hugo landing/docs into apps/site/public
make dev-site               # run the Hugo dev server while editing the site (override port with SITE_PORT=...)
make extension-build        # build the Chrome/Chromium extension into apps/browser-extension/dist
make extension-package      # build deterministic Chrome/Chromium extension zip
make test-web-browser       # build the record app and run the Playwright smoke
```

Equivalent npm checks remain available:

```bash
npm install
uv sync --locked
make test-db
npm run typecheck
npm test
npm run check
```

### Tests

Tests use the provided `pgdbm` pytest fixtures (`test_db` and `test_db_factory`) to create and clean up isolated databases. The Python test wrapper supplies their connections to the Node integration tests and release-image gate; neither creates or drops databases itself. Application SQL migrations still run through the existing TypeScript runner, so tests exercise the production migration path.

Install Node 24+, Python 3.11+, uv and Docker, then run `make install`, `make test-db`, and `make check`. The dedicated PostgreSQL service listens at `127.0.0.1:25433` with development-only `postgres` credentials. It is separate from the normal local application database. `make test-db-down` stops that disposable service. For an existing test server, set `TEST_DB_HOST`, `TEST_DB_PORT`, `TEST_DB_USER` and `TEST_DB_PASSWORD` before starting pytest; the role must be able to create test databases. Never point these at production.

`npm test` runs the Node suite under pgdbm fixture ownership. `make test-release-container` uses another fixture-owned database for the built container's startup migrations, HTTP smoke and browser tests. CI provides a PostgreSQL service with a TCP health check and uses the same fixtures. Python dependencies are pinned in `uv.lock`; no Python dependency is added to the production image.

### Browser extension packaging

`make extension-package` builds the deterministic extension ZIP. The release steps and the store submission are described in [`docs/browser-extension-release.md`](docs/browser-extension-release.md), [`docs/chrome-web-store-prep.md`](docs/chrome-web-store-prep.md) and [`docs/chrome-web-store-listing.md`](docs/chrome-web-store-listing.md). Link to the Chrome Web Store only once the listing is live; do not publish placeholder or "coming soon" install links.

## Running the service

### Database

Runtime uses one shared `pg.Pool` per Node process rather than one shared client. Defaults are intentionally conservative for Neon/serverless Postgres:

- `PG_POOL_MAX` or `DATABASE_POOL_MAX` default `5`
- `PG_POOL_IDLE_TIMEOUT_MS` default `30000`
- `PG_POOL_CONNECTION_TIMEOUT_MS` default `5000`
- `PG_STATEMENT_TIMEOUT_MS`/`PG_QUERY_TIMEOUT_MS` optional statement/query timeout
- `RECORD_BODY_LIMIT_BYTES` default `10000000` (10 MB); oversized `POST /api/records` requests return `413`. Operators can raise this for unusually long capture sessions after checking reverse-proxy and Postgres limits.

### Limits and uploads

API admission is bounded per instance and per client address. Every API write needs `Content-Type: application/json` (other types receive `415`). Rate-limited requests receive `429` with `Retry-After`; producers back off and journal uploads wait and repeat. Configure with:

- `MAX_IN_FLIGHT_API_REQUESTS` default `PG_POOL_MAX` × 4; excess API requests receive `503`
- `MAX_IN_FLIGHT_API_REQUESTS_PER_CLIENT` default `4`
- `RATE_LIMIT_WRITES_PER_MINUTE` default `600`, `RATE_LIMIT_WRITE_BURST` default `120`
- `RATE_LIMIT_NEW_SESSIONS_PER_MINUTE` default `30`, `RATE_LIMIT_NEW_SESSION_BURST` default `30` (beginning uploads, observed sessions and direct records)
- `TRUSTED_CLIENT_IP_HEADER` unset by default. Behind Cloudflare in front of Render, set it to `cf-connecting-ip`, otherwise all clients share the proxy's address. Only name a header the proxy overwrites.

One resumable upload is capped by `MAX_UPLOAD_EVENTS` (default `10000000`) and `MAX_UPLOAD_BYTES` (default `1600000000`); larger uploads receive `413 upload_too_large`.

Abandoned unfinalized upload staging is deleted by an operator command, not automatically. Run it periodically (for example as a daily Render cron job running `node apps/ingest-api/scripts/delete-abandoned-uploads.mjs` in the image):

```bash
make delete-abandoned-uploads DATABASE_URL='postgresql://...'          # untouched for 30 days
make delete-abandoned-uploads DATABASE_URL='postgresql://...' OLDER_THAN_DAYS=60
```

Producers keep a frozen record and its `upload_id` until publication succeeds and restart a deleted upload from event zero, so no record is lost. Published records, finalized uploads, observed sessions and checkpoints are never deleted by this command.

### Record removal

Reported abusive records are removed by the operator, never through the public API. `make remove-record SIGNATURE=<short signature or hash> DATABASE_URL=...` previews the removal; add `CONFIRM=yes` to remove. See [record removal](docs/operations-record-removal.md).

See [`apps/ingest-api/README.md`](apps/ingest-api/README.md) for details.

### Migrations

Run migrations before starting a production container:

```bash
DATABASE_URL='postgresql://...' make migrate
# or for compose-managed prod-like runs:
make prod-container-migrate PROD_ENV_FILE=.env.localprod
```

Migration posture is pgdbm-style but TypeScript-native: `schema_migrations` records ordered `NNN_name.sql` migrations with SHA-256 checksums; reruns are idempotent and checksum drift fails. Before adding another migration, include tests for ordering/checksum behavior and a rollback/restore plan for production data.

## Release and Render deployment

A pushed tag matching `v*` triggers `.github/workflows/release-image.yml`. The workflow builds the production Dockerfile for `linux/amd64` and `linux/arm64`, pushes GHCR images under `ghcr.io/<owner>/<repo>`, and uploads the deterministic browser-extension zip as a GitHub Actions artifact. The Makefile default `PROD_IMAGE` points at `ghcr.io/juanre/possiblymadebyahuman:latest`; forks should override `PROD_IMAGE=ghcr.io/<owner>/<repo>:<tag>` when validating or deploying.

- full semver, for example `ghcr.io/juanre/possiblymadebyahuman:0.1.0`
- major/minor, for example `:0.1`
- git SHA
- `:latest`

Do not push tags until the human explicitly approves release. The Makefile release surface is:

```bash
make release-ready                         # checks + disposable Docker/Postgres browser gate
make ship-tag VERSION=0.1.0                 # checks, tags, pushes
make release-build-image RELEASE_IMAGE=possiblymadebyahuman-local
make release-build-image-nocache RELEASE_IMAGE=possiblymadebyahuman-local
make extension-package                    # writes apps/browser-extension/dist/possiblymadebyahuman-extension-<version>.zip
```

`release-ready` requires a clean tree, including untracked files, and a running test PostgreSQL service (`make test-db`). The release gate runs its application container against a fresh database managed by pgdbm fixtures. `make test-release-container` runs just that image gate. Pull requests, main, and release tags run the same reusable `.github/workflows/check.yml`, including Emacs, real Postgres, Hugo, and Chromium with the installed extension against the built image. Image publication waits for these checks and extension packaging. Successful releases attach the extension zip to a GitHub Release so its download does not expire with CI artifacts.

The image embeds `BUILD_REVISION`; `/health` returns it as `revision`. Pin deployments to an immutable version or image digest, then compare this field to the reviewed commit.

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
