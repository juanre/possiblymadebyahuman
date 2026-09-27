import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const WRITE_FILES = [
  "apps/web/src/write-page.tsx",
  "apps/web/src/draft-editor.tsx",
  "apps/web/src/draft-list.tsx",
  "apps/web/src/write-capture.ts",
  "packages/producer-core/src/measured-input.ts",
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

test("/write keeps draft text only in its own drafts database, never in the event journal", async () => {
  const drafts = await readFile("apps/web/src/drafts.ts", "utf8");
  const page = await readFile("apps/web/src/write-page.tsx", "utf8");
  const journal = await readFile("packages/browser-storage/src/index.ts", "utf8");
  assert.match(drafts, /"pmbah\.write\.drafts\.v1"/);
  assert.match(page, /name: "pmbah\.write\.journal\.v1"/);
  assert.doesNotMatch(journal, /drafts|\btext\b/);
});
