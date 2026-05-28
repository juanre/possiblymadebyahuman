import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const WRITE_FILES = [
  "apps/web/src/write-page.tsx",
  "apps/web/src/write-capture.ts",
];

const BANNED_SOURCE_PATTERNS = [
  /final_text_(hash|length)/i,
  /ins_hash/i,
  /ins_text/i,
  /previous(Text|Value)|last(Text|Value)|textSnapshot|initialSnapshot|baseline/i,
  /localStorage\.setItem\([^\n]*(value|text|canvas)/i,
  /sessionStorage\.setItem\([^\n]*(value|text|canvas)/i,
];

test("/write source does not retain or name plaintext snapshots", async () => {
  const hits = [];
  for (const file of WRITE_FILES) {
    const body = await readFile(file, "utf8");
    for (const pattern of BANNED_SOURCE_PATTERNS) {
      if (pattern.test(body)) hits.push(`${file}: ${pattern}`);
    }
  }
  assert.deepEqual(hits, []);
});
