import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const requiredPaths = [
  "docs/spec.md",
  "docs/sot.md",
  "docs/architecture.md",
  "docs/spec/canonicalization.md",
  "packages/format/README.md",
  "packages/conformance/README.md",
  "packages/analyzers/README.md",
  "packages/storage/README.md",
  "apps/ingest-api/README.md",
  "apps/web/README.md",
  "apps/site/README.md",
  "apps/browser-extension/README.md",
  "producers/emacs/README.md",
];

test("M0 scaffold paths exist", async () => {
  for (const path of requiredPaths) {
    await access(path);
  }
});

test("architecture records product boundaries", async () => {
  const architecture = await readFile("docs/architecture.md", "utf8");
  assert.match(architecture, /content-blind/i);
  assert.match(architecture, /not a detector/i);
  assert.match(architecture, /Out of scope for M0/);
});

test("canonicalization spec home defines stable JSON rules", async () => {
  const canonicalization = await readFile("docs/spec/canonicalization.md", "utf8");
  assert.match(canonicalization, /keys are sorted lexicographically/i);
  assert.match(canonicalization, /No insignificant whitespace/i);
  assert.match(canonicalization, /ins_hash.*omitted/i);
});
