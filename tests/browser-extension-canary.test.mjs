import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

// The package determinism test elsewhere `rm`s the production dist between
// iterations. If we read directly from `apps/browser-extension/dist` we race
// against it under node:test's parallel runner. Solution: build once, snapshot
// the bundle bytes into a private temp directory at module load, and serve all
// canary reads from that snapshot. The temp directory is cleaned at process
// exit (best-effort).
let snapshotPromise;
async function snapshotDist() {
  // Build into a private temp dir via EXT_DIST_DIR so we never race with the
  // package-determinism test that rm's apps/browser-extension/dist between
  // iterations. Returns the temp dir path; reads are served from it.
  const target = await mkdtemp(join(tmpdir(), "pmbah-canary-"));
  await execFileAsync("npm", ["--workspace", "@possiblymadebyahuman/browser-extension", "run", "build"], {
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, EXT_BASE_URL: "", EXT_DIST_DIR: target },
  });
  process.on("exit", () => {
    try { rm(target, { recursive: true, force: true }); } catch { /* best-effort */ }
  });
  return target;
}

async function distDir() {
  snapshotPromise ??= snapshotDist();
  return snapshotPromise;
}

// Symbols that read user-typed text from DOM nodes. The service-worker bundle
// must contain none of these — it is the trust boundary that talks to the
// network. The content-script bundle is allowed to use them transiently to
// derive process metadata; it never persists or transmits the text.
//
// Note: `final_text_hash`, `final_text_length`, and `ins_hash` are
// intentionally referenced as STRING LITERALS in packages/format's
// validateManifest (which rejects any manifest that carries them). Those
// guards are inlined into the bundle and are not leaks, so the bundle scan
// does not flag them — the source scan further below catches them anywhere
// they would appear as field reads.
const BANNED_IN_SERVICE_WORKER = [
  /\.innerText\b/,
  /\.textContent\b/,
  /\bevent\.data\b/,
  /\bplaintext\b/,
];

const BANNED_IN_POPUP_READS = [
  /\.innerText\b/,
  /\bvalue\.length\b/,
  /\bevent\.data\b/,
];

const BANNED_KERNEL_SYMBOLS = [
  /\breplayEvents\b/,
  /\breplayEventsWithText\b/,
  /\bReplayTextProvider\b/,
  /\bgetInsertedText\b/,
  /\bb3HashText\b/,
];

test("service-worker bundle has no DOM/text-reading symbols", async () => {
  const DIST = await distDir();
  const body = await readFile(`${DIST}/service-worker.js`, "utf8");
  for (const pattern of BANNED_IN_SERVICE_WORKER) {
    assert.doesNotMatch(body, pattern, `service-worker.js leaks ${pattern}`);
  }
});

test("popup bundle reads no DOM/text from the page", async () => {
  const DIST = await distDir();
  const body = await readFile(`${DIST}/popup.js`, "utf8");
  for (const pattern of BANNED_IN_POPUP_READS) {
    assert.doesNotMatch(body, pattern, `popup.js leaks ${pattern}`);
  }
});

test("all extension bundles are free of plaintext-handling kernel symbols", async () => {
  const DIST = await distDir();
  for (const file of ["service-worker.js", "content.js", "popup.js"]) {
    const body = await readFile(`${DIST}/${file}`, "utf8");
    for (const pattern of BANNED_KERNEL_SYMBOLS) {
      assert.doesNotMatch(body, pattern, `${file} contains banned plaintext-handling symbol ${pattern}`);
    }
  }
});

test("service-worker bundle never references the ingest endpoint without the configured base url", async () => {
  const DIST = await distDir();
  const body = await readFile(`${DIST}/service-worker.js`, "utf8");
  // The SW must ship the configured ingest endpoint, never a stray hardcoded
  // hostname that would override the build-time EXT_BASE_URL.
  assert.match(body, /https:\/\/possiblymadebyahuman\.com\/api\/records/);
  for (const stray of [
    "http://localhost",
    "127.0.0.1",
    "example.com/api/records",
    "ngrok.io",
  ]) {
    assert.ok(!body.includes(stray), `service-worker.js leaks stray hostname ${stray}`);
  }
});

test("manifest version matches the package version", async () => {
  const DIST = await distDir();
  const manifest = JSON.parse(await readFile(`${DIST}/manifest.json`, "utf8"));
  const packageJson = JSON.parse(await readFile("apps/browser-extension/package.json", "utf8"));
  assert.equal(manifest.version, packageJson.version);
  // Permissions never grow without intent: the v0 surface is exactly these three
  // plus the <all_urls> host permission asserted below. storage for chrome.storage.local,
  // clipboardWrite for copying the record URL after upload, alarms for the TTL sweep.
  assert.deepEqual(manifest.permissions, ["storage", "clipboardWrite", "alarms"]);
  assert.deepEqual(manifest.host_permissions, ["<all_urls>"]);
});

test("content script retains no text snapshots between events", async () => {
  // Coord's no-retention rule: producers may transiently inspect text only to
  // derive metadata; they must not retain text in session/content-script state
  // across event boundaries. Forbid any identifier that would name retained
  // text (snapshots, previous/current text caches, diff-fallback helpers).
  // Inline transient reads inside a handler scope are fine — the bans below
  // target names that imply state across calls.
  const body = await readFile("apps/browser-extension/src/content/capture.ts", "utf8");
  const bannedRetainedTextSymbols = [
    /\bpreviousText\b/,
    /\bpreviousValue\b/,
    /\bpreviousTextSnapshot\b/,
    /\bcurrentText\b/,
    /\bcurrentValue\b/,
    /\blastText\b/,
    /\blastValue\b/,
    /\bsnapshotValue\b/,
    /\bsnapshotText\b/,
    /\bsharedPrefixLength\b/,
    /\bsharedSuffixLength\b/,
    /\binferTextFieldMutation\b/,
  ];
  for (const pattern of bannedRetainedTextSymbols) {
    assert.doesNotMatch(body, pattern, `content/capture.ts retains text via ${pattern} — content-opacity violation`);
  }
});

test("FieldEntry type carries no text-bearing string field", async () => {
  // The FieldEntry struct is the per-field UI state held by the content
  // script. It must not carry any text or text-producing closure. We grab the
  // declared type block and assert no `string` field appears beyond the
  // session_id union (which holds a UUID, not text).
  const source = await readFile("apps/browser-extension/src/content/capture.ts", "utf8");
  const fieldEntryMatch = source.match(/type\s+FieldEntry\s*=\s*\{([^}]+)\}/m);
  assert.ok(fieldEntryMatch, "FieldEntry type declaration not found");
  const declaration = fieldEntryMatch[1];
  // Allowed fields are exactly element / session_id / state.
  const expectedFields = ["element", "session_id", "state"];
  const declaredFields = (declaration.match(/^\s*(\w+)\s*[:?]/gm) ?? [])
    .map((line) => line.trim().replace(/[:?].*$/, ""));
  assert.deepEqual(
    declaredFields.sort(),
    expectedFields.sort(),
    `FieldEntry must declare exactly ${expectedFields.join(", ")} — extra fields invite retained-text leakage`,
  );
  // Defense in depth: no `string` type or "() => string" closure type on the
  // entry. The session_id is typed `string | null` (UUID), but the bans below
  // catch standalone string types or closure-returning-string patterns.
  assert.doesNotMatch(declaration, /:\s*\(\s*\)\s*=>\s*string/, "FieldEntry must not declare a () => string closure");
  assert.doesNotMatch(declaration, /text\s*\??:\s*string/i, "FieldEntry must not declare a text-bearing string");
});

test("source files outside the content script never read DOM text", async () => {
  // codepoint.ts inspects transient strings passed by the content script — it
  // does not itself touch the DOM. Its parameters happen to be named *Value,
  // so simple substring matches would false-positive on `.value` in
  // `previousValue.length`. We use word-boundary patterns to target only
  // bare-`value` reads and DOM-specific text APIs.
  const bannedSourcePatterns = [
    /\bvalue\.length\b/, // bare element.value read
    /\.innerText\b/,
    /\.textContent\b/,
    /\bevent\.data\b/,
    /\bfinal_text_hash\b/,
    /\bfinal_text_length\b/,
    /\bins_hash\b/,
    /\bins_text\b/,
  ];
  for (const path of [
    "apps/browser-extension/src/lib/adapters.ts",
    "apps/browser-extension/src/lib/dispatcher.ts",
    "apps/browser-extension/src/lib/descriptor.ts",
    "apps/browser-extension/src/lib/policy.ts",
    "apps/browser-extension/src/lib/messages.ts",
    "apps/browser-extension/src/lib/codepoint.ts",
    "apps/browser-extension/src/background/service-worker.ts",
  ]) {
    const body = await readFile(path, "utf8");
    for (const pattern of bannedSourcePatterns) {
      assert.doesNotMatch(body, pattern, `${path} matches ${pattern}; only the content script may read DOM text`);
    }
  }
});
