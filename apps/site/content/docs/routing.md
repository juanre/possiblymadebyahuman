---
title: "Deployment and routing"
summary: "How `/`, `/docs/*`, `/write`, `/api/*`, and `/<short_signature>` are served from a single container."
---

The public service runs as **one Docker container** that serves three things:

- the ingest API (`/api/*` and `/health` / `/ready`);
- this Hugo site (`/` and `/docs/*`);
- the Vite app (`/write`, `/<short_signature>`, plus assets under `/record-assets/*`).

## Routing order

The runtime resolves requests in this order:

1. `/api/*` → backend.
2. `/health`, `/ready`, `/live` → backend.
3. `/` and `/docs/*` → Hugo static output.
4. `/record-assets/*` → Vite app assets.
5. `/write` → Vite app shell (`index.html`) and first-party drafting/signing UI.
6. `/<short_signature>` → Vite app shell (`index.html`), with the React app reading `window.location.pathname` and hitting `/api/records/<slug>`.

## Reserved short-signature prefixes

Short signatures are derived from BLAKE3 bytes, but the generator skips any string that would shadow a fixed prefix:

`api`, `docs`, `blog`, `write`, `assets`, `record-assets`, `images`, `health`, `ready`, `live`, plus any future runtime/static prefix added to the container.

When a generated signature collides with a reserved prefix, the backend lengthens or re-derives it until it does not.

## Where Hugo fits

Hugo is built once in the multi-stage Dockerfile:

```dockerfile
FROM alpine:3.20 AS site-builder
RUN apk add --no-cache hugo
WORKDIR /src
COPY apps/site apps/site
RUN hugo --source apps/site --destination /site-public --minify
```

The runtime stage copies `/site-public` to `/app/site/public` and points `SITE_DIST_DIR` at it. The Node server serves `/app/site/public/<path>/index.html` for the three Hugo prefixes.

## Local development

Two options for working on the site locally:

```bash
# Hugo dev server with hot reload, useful while writing content.
make dev-site
# default: http://localhost:1313

# Build and run the production image with Postgres alongside; serves Hugo + Vite + API on one port.
make local-container
# default: http://localhost:8000
```

`make local-container-test` exercises the deployed container's HTTP routes end-to-end, including `/` and `/docs/`, against a real Postgres.

## Environment

Relevant runtime variables:

```text
PORT=8000
DATABASE_URL=postgresql://...
PUBLIC_BASE_URL=https://possiblymadebyahuman.com
WEB_DIST_DIR=/app/web/dist
SITE_DIST_DIR=/app/site/public
NODE_ENV=production
LOG_LEVEL=info
```

The single-container model means deploying a new build of either the Hugo site or the Vite record app rebuilds the same image; there is no separate static surface to keep in sync, and the routing contract above is the only thing the container has to honour.
