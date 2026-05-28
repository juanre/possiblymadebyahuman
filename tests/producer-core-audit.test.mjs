import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import test from "node:test";

const SOURCE_ROOT = "packages/producer-core/src";
const TEXTLIKE = new Set([".ts", ".tsx", ".mts", ".js", ".mjs", ".md"]);

const BANNED_SYMBOLS = [
  "b3HashText",
  "getInsertedText",
  "ReplayTextProvider",
  "replayEvents",
  "replayEventsWithText",
  "computeFinalTextMetadata",
  "final_text",
  "ins_text",
  "plaintext",
];

async function walk(path) {
  const info = await stat(path).catch(() => null);
  if (!info) return [];
  if (info.isFile()) return [path];
  if (!info.isDirectory()) return [];
  const entries = await readdir(path);
  const out = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    out.push(...(await walk(join(path, entry))));
  }
  return out;
}

async function collectFiles(root) {
  return (await walk(root)).filter((file) => TEXTLIKE.has(extname(file)));
}

test("producer-core source contains no banned plaintext-handling symbols", async () => {
  const files = await collectFiles(SOURCE_ROOT);
  assert.ok(files.length > 0, `expected source files under ${SOURCE_ROOT}`);
  const hits = [];
  for (const file of files) {
    const body = await readFile(file, "utf8");
    for (const symbol of BANNED_SYMBOLS) {
      if (body.includes(symbol)) {
        hits.push(`${file}: ${symbol}`);
      }
    }
  }
  assert.equal(hits.length, 0, hits.length ? `\n${hits.join("\n")}` : "");
});

test("producer-core imports stay within format + own package", async () => {
  const files = await collectFiles(SOURCE_ROOT);
  const importRegex = /^\s*import\s+(?:type\s+)?[^"';]+from\s+["']([^"']+)["']/gm;
  const hits = [];
  for (const file of files) {
    const body = await readFile(file, "utf8");
    importRegex.lastIndex = 0;
    let match;
    while ((match = importRegex.exec(body)) !== null) {
      const spec = match[1];
      if (spec.startsWith(".")) {
        if (spec.startsWith("../../format/")) continue;
        if (spec.startsWith("./") || spec.startsWith("../")) continue;
      }
      // node:* is forbidden in producer-core (it must run in browser SW + Emacs subprocess)
      if (spec.startsWith("node:")) {
        hits.push(`${file}: forbidden node import ${spec}`);
        continue;
      }
      // bare specifiers other than format are not allowed
      if (!spec.startsWith(".") && !spec.startsWith("../../format/")) {
        hits.push(`${file}: unexpected import target ${spec}`);
      }
    }
  }
  assert.equal(hits.length, 0, hits.length ? `\n${hits.join("\n")}` : "");
});

test("producer-core public surface exposes checkpoint adapter and observation envelope", async () => {
  const indexSource = await readFile(`${SOURCE_ROOT}/index.ts`, "utf8");
  for (const expected of [
    "CheckpointAdapter",
    "CheckpointResult",
    "ObservationEnvelope",
    "ObservedSessionToken",
    "SessionObservation",
    "advanceChain",
  ]) {
    assert.ok(indexSource.includes(expected), `producer-core index.ts must export ${expected}`);
  }
});

test("SessionRecord never carries raw text fields in its on-disk shape", async () => {
  const typesSource = await readFile(`${SOURCE_ROOT}/types.ts`, "utf8");
  const fieldNamePattern = (name) => new RegExp(`(?:^|\\s|;|,|\\{)${name}\\s*\\??\\s*:`, "m");
  for (const banned of ["text", "plaintext", "ins_text", "final_text", "buffer"]) {
    assert.ok(
      !fieldNamePattern(banned).test(typesSource),
      `types.ts must not declare field ${banned}`,
    );
  }
});
