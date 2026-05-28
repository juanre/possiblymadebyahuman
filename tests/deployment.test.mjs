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
    "extension-build",
    "extension-package",
    "docker-build",
    "release-build-image",
    "release-build-image-nocache",
    "local-container-build",
    "local-container",
    "local-container-down",
    "local-container-reset",
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

test("local-container builds the image tag that compose runs", async () => {
  const makefile = await read("Makefile");
  assert.match(makefile, /^LOCAL_IMAGE \?= possiblymadebyahuman-local:latest$/m);
  assert.match(makefile, /^local-container-build:\n\t\$\(MAKE\) docker-build IMAGE=\$\(LOCAL_IMAGE\)$/m);
  assert.match(makefile, /^local-container: local-container-build$/m);
  assert.match(makefile, /^LOCAL_COMPOSE = .*LOCAL_IMAGE=\$\(LOCAL_IMAGE\)/m);
  assert.match(makefile, /^local-container-reset:/m);
  assert.match(makefile, /docker compose --env-file "\$\$env_file" -f docker-compose\.local-container\.yml -p pmbah-local down -v/);
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
  assert.match(workflow, /Build browser extension package/);
  assert.match(workflow, /make extension-package/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /apps\/browser-extension\/dist\/possiblymadebyahuman-extension-\*\.zip/);
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

test("browser extension release docs define package artifact and store plan", async () => {
  const readme = await read("README.md");
  assert.match(readme, /docs\/browser-extension-release\.md/);
  assert.match(readme, /docs\/chrome-web-store-prep\.md/);
  assert.match(readme, /do not publish placeholder or "coming soon" install links/);
  assert.match(readme, /make extension-package/);

  const release = await read("docs/browser-extension-release.md");
  for (const phrase of [
    "make extension-package",
    "possiblymadebyahuman-extension-<version>.zip",
    "EXT_BASE_URL",
    "esbuild",
    "source maps",
    "Chrome Web Store manual publishing path",
    "Optional Chrome Web Store API automation",
    "Edge Add-ons path",
    "Firefox AMO path",
    "Safari/App Store distribution is out of scope",
    "Do not publish install links until Chrome Web Store approval produces a real URL",
  ]) {
    assert.match(release, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(release, /chromewebstore\.google\.com\/detail\/[a-z0-9_-]+/i);

  const prep = await read("docs/chrome-web-store-prep.md");
  for (const phrase of [
    "Chrome Web Store Developer account",
    "public or unlisted install link",
    "Extension ID: `TBD",
    "Chrome Web Store listing URL: `TBD",
    "Privacy policy URL",
    "Draft Chrome Web Store listing copy",
    "Draft privacy and data-use disclosure answers",
    "Permission-justification template",
    "Release-readiness summary at frontend tip",
    "Human-input blocker packet for `.26`",
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
