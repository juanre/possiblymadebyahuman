import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import test from "node:test";

const USER_FACING_TARGETS = [
  "README.md",
  "apps/site/README.md",
  "apps/site/layouts/_default/baseof.html",
  "apps/site/content",
  "apps/web/src",
];

const TEXTLIKE = new Set([".md", ".html", ".tsx", ".ts", ".jsx", ".js"]);

// Hard-banned phrases in user-facing copy. The `honest` family is the
// flagship case: it must not appear at all (use `clear` / `explicit` /
// `accurate` / `precise` instead). `replayable`, `deterministic replay`,
// `reconstructs the buffer`, and `final_text_*` imply the system stores
// or reconstructs text and are also forbidden.
//
// Note on `humanness` / `humanlike` / `humanly`: coord allows these in
// explicit negative/anti-pattern context (e.g. "does not emit humanness
// verdicts") with reviewer ACK. The audit cannot reliably distinguish
// positive from negative uses via regex, so it does not enforce here;
// positive uses are caught by manual review.
const BANNED = [
  { regex: /\bhonest(ly|y)?\b/gi, why: "moralizing — use 'clear' / 'explicit' / 'accurate' / 'precise'" },
  { regex: /\breplayable\b/gi, why: "implies text storage/reconstruction; use 'inspectable' / 'content-opaque process record'" },
  { regex: /\bdeterministic\s+replay\b/gi, why: "implies text playback; use content-opaque framing" },
  { regex: /\breconstructs?\s+the\s+buffer\b/gi, why: "implies text storage" },
  { regex: /\bfinal_text_(hash|length)\b/gi, why: "removed from v0 content-opaque format" },
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

async function collectTextFiles() {
  const files = [];
  for (const target of USER_FACING_TARGETS) files.push(...(await walk(target)));
  return files.filter((file) => TEXTLIKE.has(extname(file)));
}

test("user-facing copy contains no banned content-opaque-violating phrases", async () => {
  const files = await collectTextFiles();
  const hits = [];
  for (const file of files) {
    const body = await readFile(file, "utf8");
    for (const { regex, why } of BANNED) {
      const matches = body.match(regex);
      if (matches && matches.length > 0) {
        hits.push({ file, phrase: regex.source, count: matches.length, why });
      }
    }
  }
  const report = hits.map((h) => `${h.file}: ${h.count}× /${h.phrase}/ — ${h.why}`).join("\n");
  assert.equal(hits.length, 0, hits.length ? `\n${report}` : "");
});
