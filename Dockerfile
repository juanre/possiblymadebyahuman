# syntax=docker/dockerfile:1

FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/ingest-api/package.json apps/ingest-api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/site/package.json apps/site/package.json
COPY apps/browser-extension/package.json apps/browser-extension/package.json
COPY packages/format/package.json packages/format/package.json
COPY packages/conformance/package.json packages/conformance/package.json
COPY packages/analyzers/package.json packages/analyzers/package.json
COPY packages/storage/package.json packages/storage/package.json
RUN npm ci

FROM deps AS web-builder
COPY packages packages
COPY apps/web apps/web
RUN npm run build:web

FROM alpine:3.20 AS site-builder
RUN apk add --no-cache hugo
WORKDIR /src
COPY apps/site apps/site
RUN hugo --source apps/site --destination /site-public --minify

FROM node:24-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN groupadd --system --gid 1001 pmbah \
    && useradd --system --uid 1001 --gid 1001 pmbah
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8000
ENV WEB_DIST_DIR=/app/web/dist
ENV SITE_DIST_DIR=/app/site/public
COPY --from=deps --chown=pmbah:pmbah /app/node_modules /app/node_modules
COPY --from=deps --chown=pmbah:pmbah /app/package.json /app/package-lock.json /app/
COPY --chown=pmbah:pmbah apps/ingest-api /app/apps/ingest-api
COPY --chown=pmbah:pmbah packages /app/packages
COPY --from=web-builder --chown=pmbah:pmbah /app/apps/web/dist /app/web/dist
COPY --from=site-builder --chown=pmbah:pmbah /site-public /app/site/public
USER pmbah
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://localhost:8000/ready >/dev/null || exit 1
CMD ["npm", "run", "start:production"]
