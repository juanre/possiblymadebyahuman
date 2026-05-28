# site

Hugo static site for the public-facing landing page, docs, and blog.

## Responsibility

- Public `/`, `/docs/*`, and `/blog/*` routes.
- Product explanation, content-blind privacy model, how records and verification work, threat model, and producer conformance.
- Candid lightweight tone: "we cannot prove it, but here is us caring enough to show the work."

## Non-responsibility

- Public record pages such as `/<short_signature>` (those belong to `apps/web`).
- Backend ingestion APIs.
- Producer capture.
- Detector/certificate language or humanness scoring.

## Content layout

```text
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
  blog/
    _index.md                # blog section index
    the-gesture.md
    why-not-a-detector.md
```

`layouts/_default/baseof.html` sets the shared shell (nav, candid description, footer). `layouts/index.html` renders the landing page content as-is. `layouts/_default/list.html` renders section indexes with a page list sorted by title; `layouts/blog/list.html` overrides that ordering with date-descending for the blog.

## Local development

```bash
make dev-site        # hugo server with hot reload at http://localhost:1313
make build-site      # one-shot build into apps/site/public
```

The Dockerfile builds the same way:

```dockerfile
FROM alpine:3.20 AS site-builder
RUN apk add --no-cache hugo
WORKDIR /src
COPY apps/site apps/site
RUN hugo --source apps/site --destination /site-public --minify
```

`tests/site-build.test.mjs` runs the same `hugo` build into a temp directory and asserts every expected page renders with the standing claim and without leaking the golden record's plaintext. It skips automatically if the `hugo` binary is not on `PATH`.

## Editing rules

- Keep tone candid and short. Avoid marketing-style claims.
- Never add verdict, score, badge, or certificate-of-humanity copy.
- New doc pages should appear under `content/docs/` with a `title` and a one-line `summary`.
- New blog posts need front-matter `title`, ISO-8601 `date`, and a one-line `summary`.
