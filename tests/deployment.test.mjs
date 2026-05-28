import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import test from "node:test";

const execFileAsync = promisify(execFile);

const read = (path) => readFile(path, "utf8");

test("deployment files define single-container and local Postgres paths", async () => {
  const dockerfile = await read("Dockerfile");
  assert.match(dockerfile, /FROM node:24-slim AS runtime/);
  assert.match(dockerfile, /COPY --from=web-builder/);
  assert.match(dockerfile, /COPY --from=site-builder/);
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.match(dockerfile, /CMD \["node", "apps\/ingest-api\/scripts\/start-production\.mjs"\]/);

  const localCompose = await read("docker-compose.local-container.yml");
  assert.match(localCompose, /postgres:16-alpine/);
  assert.match(localCompose, /DATABASE_URL: postgresql:\/\//);

  const prodCompose = await read("docker-compose.prod.yml");
  assert.match(prodCompose, /DATABASE_URL.*Neon/);
  assert.match(prodCompose, /PG_POOL_MAX/);
  assert.match(prodCompose, /RECORD_BODY_LIMIT_BYTES/);
  assert.doesNotMatch(prodCompose, /postgres:16-alpine/);
});

test("Makefile is the primary management surface", async () => {
  const makefile = await read("Makefile");
  for (const target of [
    "help",
    "install",
    "check",
    "test",
    "typecheck",
    "dev-api",
    "dev-web",
    "dev-site",
    "docker-build",
    "release-build-image",
    "release-build-image-nocache",
    "local-container",
    "local-container-down",
    "local-container-logs",
    "local-container-test",
    "migrate",
    "prod-container",
    "prod-container-pull",
    "prod-container-migrate",
    "prod-container-down",
    "build-site",
    "release-ready",
    "ship-tag",
    "clean",
  ]) {
    assert.match(makefile, new RegExp(`^${target}:`, "m"));
  }
});

test("deployment examples do not commit secrets and docker ignores local artifacts", async () => {
  const dockerignore = await read(".dockerignore");
  assert.match(dockerignore, /^\.aw$/m);
  assert.match(dockerignore, /^\.env\.\*$/m);

  for (const envFile of [".env.local-container.example", ".env.localprod.example", ".env.production.example"]) {
    const body = await read(envFile);
    assert.match(body, /DATABASE_URL|POSTGRES_PASSWORD/);
    assert.doesNotMatch(body, /sk_live_|password123|BEGIN PRIVATE KEY/);
  }

  const productionExample = await read(".env.production.example");
  for (const variable of [
    "DATABASE_URL",
    "PORT",
    "PUBLIC_BASE_URL",
    "NODE_ENV",
    "LOG_LEVEL",
    "PG_POOL_MAX",
    "PG_POOL_IDLE_TIMEOUT_MS",
    "PG_POOL_CONNECTION_TIMEOUT_MS",
    "PG_STATEMENT_TIMEOUT_MS",
    "RECORD_BODY_LIMIT_BYTES",
  ]) {
    assert.match(productionExample, new RegExp(`^${variable}=`, "m"));
  }
});

test("tag-trigger GHCR release workflow follows the release-image pattern", async () => {
  const workflow = await read(".github/workflows/release-image.yml");
  assert.match(workflow, /tags: \["v\*"\]/);
  assert.match(workflow, /REGISTRY: ghcr\.io/);
  assert.match(workflow, /docker\/metadata-action@v5/);
  assert.match(workflow, /type=semver,pattern=\{\{version\}\}/);
  assert.match(workflow, /type=sha,prefix=/);
  assert.match(workflow, /type=raw,value=latest/);
  assert.match(workflow, /docker\/build-push-action@v6/);
  assert.match(workflow, /platforms: linux\/amd64,linux\/arm64/);
  assert.match(workflow, /file: Dockerfile/);
});

test("production env files remain ignored and untracked", async () => {
  const ignored = await execFileAsync("git", ["check-ignore", ".env.production"]);
  assert.equal(ignored.stdout.trim(), ".env.production");
  const tracked = await execFileAsync("git", ["ls-files", ".env.production"]);
  assert.equal(tracked.stdout.trim(), "");
});

test("release docs cover Render, GHCR, tags, Neon, and startup migrations", async () => {
  const readme = await read("README.md");
  for (const phrase of [
    "Release and Render deployment",
    "ghcr.io/<owner>/<repo>",
    "pushed tag matching `v*`",
    "Neon",
    "startup runs checked migrations",
    "make ship-tag VERSION=0.1.0",
  ]) {
    assert.match(readme, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("Chrome Web Store prep docs define human checklist without fake install links", async () => {
  const readme = await read("README.md");
  assert.match(readme, /docs\/chrome-web-store-prep\.md/);
  assert.match(readme, /do not publish placeholder or "coming soon" install links/);

  const prep = await read("docs/chrome-web-store-prep.md");
  for (const phrase of [
    "Chrome Web Store Developer account",
    "public or unlisted install link",
    "Extension ID: `TBD",
    "Chrome Web Store listing URL: `TBD",
    "Privacy policy URL",
    "Draft Chrome Web Store listing copy",
    "Draft privacy and data-use disclosure answers",
    "Draft permission-justification template",
    "TBD by default-aaaa.7",
    "No fake, placeholder, or \"coming soon\" install URL",
    "not an AI detector",
    "do not contain your document plaintext",
  ]) {
    assert.match(prep, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(prep, /chromewebstore\.google\.com\/detail\/[a-z0-9_-]+/i);
});

test("SOT documents M2.x deployment and reserved routes", async () => {
  const sot = await read("docs/sot.md");
  assert.match(sot, /single Docker container/);
  assert.match(sot, /Neon\.tech/);
  assert.match(sot, /make local-container-test/);
  assert.match(sot, /Reserved route prefixes/);
});
