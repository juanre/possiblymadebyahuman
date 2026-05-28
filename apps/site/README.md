# site

Hugo static site for the public-facing landing page and docs.

## Responsibility

- Public `/` and `/docs/*` routes.
- Product explanation, content-blind privacy model, how records and verification work, threat model, and producer conformance.
- Candid lightweight tone: "we cannot prove it, but here is us caring enough to show the work."

## Non-responsibility

- Public record pages such as `/<short_signature>` (those belong to `apps/web`).
- The per-record standing disclaimer (rendered by the Vite record app's `DisclaimerBanner`, not by the Hugo home page).
- Backend ingestion APIs.
- Producer capture.
- Detector/certificate language or aggregate human/AI scoring.

## Content layout

```text
assets/
  pmbah-figure-source.jpg    # original drawing archive (not served)
content/
  _index.md                  # landing page
  docs/
    _index.md                # docs section index
    product-promise.md
    claims.md
    privacy.md
    records.md
    verification.md
    threat-model.md
    conformance.md
    routing.md
static/
  images/
    pmbah-figure-{600,1200}.{webp,jpg}   # served at /images/...
```

`layouts/_default/baseof.html` sets the shared shell (nav, candid description, footer, type stack, faint graph-paper grid). `layouts/index.html` renders the landing markdown as-is so the hero grid HTML in `_index.md` stays untouched. `layouts/_default/list.html` renders section indexes with a page list sorted by title.

## Local development

```bash
make dev-site            # hugo server with hot reload at http://localhost:1313 (override port with SITE_PORT=...)
make build-site          # one-shot build into apps/site/public
```

The Dockerfile builds the same way:

```dockerfile
FROM alpine:3.20 AS site-builder
RUN apk add --no-cache hugo
WORKDIR /src
COPY apps/site apps/site
RUN hugo --source apps/site --destination /site-public --minify
```

`tests/site-build.test.mjs` runs the same `hugo` build into a temp directory and asserts every expected page renders with the product framing and without leaking the golden record's plaintext. It skips automatically if the `hugo` binary is not on `PATH`.

## Editing rules

- Keep tone candid and short. Avoid marketing-style claims.
- Never add verdict, score, badge, or certificate-of-humanity copy.
- Never put the per-record standing disclaimer on the home page; it belongs on individual record pages rendered by the Vite app.
- New doc pages should appear under `content/docs/` with a `title` and a one-line `summary`.
