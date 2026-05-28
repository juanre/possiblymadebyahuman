import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(path, "utf8");

test("deployment files define single-container and local Postgres paths", async () => {
  const dockerfile = await read("Dockerfile");
  assert.match(dockerfile, /FROM node:24-slim AS runtime/);
  assert.match(dockerfile, /COPY --from=web-builder/);
  assert.match(dockerfile, /COPY --from=site-builder/);
  assert.match(dockerfile, /HEALTHCHECK/);

  const localCompose = await read("docker-compose.local-container.yml");
  assert.match(localCompose, /postgres:16-alpine/);
  assert.match(localCompose, /DATABASE_URL: postgresql:\/\//);

  const prodCompose = await read("docker-compose.prod.yml");
  assert.match(prodCompose, /DATABASE_URL.*Neon/);
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
    "local-container",
    "local-container-down",
    "local-container-logs",
    "local-container-test",
    "migrate",
    "prod-container",
    "prod-container-migrate",
    "prod-container-down",
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
});

test("SOT documents M2.x deployment and reserved routes", async () => {
  const sot = await read("docs/sot.md");
  assert.match(sot, /single Docker container/);
  assert.match(sot, /Neon\.tech/);
  assert.match(sot, /make local-container-test/);
  assert.match(sot, /Reserved route prefixes/);
});
