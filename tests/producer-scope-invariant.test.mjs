import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function text(path) {
  return readFile(path, "utf8");
}

test("producer scope invariant is documented for every first-party producer", async () => {
  const sot = await text("docs/sot.md");
  for (const snippet of [
    "Producer scope invariant",
    "Emacs",
    "Browser extension",
    "`/write` first-party page",
    "`packages/producer-core`",
    "must not retain text snapshots",
    "must not require plaintext",
  ]) {
    assert.ok(sot.includes(snippet), `docs/sot.md missing ${snippet}`);
  }
});

test("Emacs production path allows non-empty starts and helper receives no text contract", async () => {
  const mode = await text("producers/emacs/pmbah-mode.el");
  const helper = await text("producers/emacs/scripts/build-record.mjs");
  const readme = await text("producers/emacs/README.md");

  assert.doesNotMatch(mode, /pmbah--assert-empty-buffer-for-start/);
  assert.doesNotMatch(mode, /refuses to start in a non-empty buffer/);
  assert.doesNotMatch(mode, /initial_observed_length/);
  assert.doesNotMatch(helper, /initial_observed_length/);
  assert.match(readme, /does not pass\s+buffer text to the helper/);
  assert.match(readme, /non-empty buffer/);
  assert.match(readme, /ERR_MODULE_NOT_FOUND/);
  assert.match(readme, /localhost:8000/);
  assert.doesNotMatch(readme, /localhost:8787/);

  for (const banned of [
    /final_text/i,
    /ins_text/i,
    /ins_hash/i,
    /replay_insertions_by_seq/i,
    /buffer-substring-no-properties\s*\([^)]*point-min/i,
  ]) {
    assert.doesNotMatch(helper, banned, `Emacs helper contains banned text/replay contract ${banned}`);
  }
});

test("browser extension rejects fresh non-empty fields and audits retained text", async () => {
  const policy = await text("apps/browser-extension/src/lib/policy.ts");
  const canary = await text("tests/browser-extension-canary.test.mjs");
  const unit = await text("tests/browser-extension.test.mjs");

  assert.match(policy, /non_empty_field_no_resumable_session/);
  assert.match(policy, /no automatic snapshot of existing/);
  assert.match(unit, /fresh empty field is eligible; non-empty without resumable session is INELIGIBLE/);
  assert.match(canary, /content script retains no text snapshots between events/);
  assert.match(canary, /FieldEntry type carries no text-bearing string field/);
});

test("/write starts empty and has no retained-text audit", async () => {
  const page = await text("apps/web/src/write-page.tsx");
  const audit = await text("tests/write-page-audit.test.mjs");
  const browser = await text("tests/browser/write-page.spec.mjs");

  // The /write page renders a blank, placeholderless textarea — the empty
  // start is the invitation. The empty-start invariant is structurally
  // enforced by the producer-core eligibility policy and the explicit
  // textarea reset on upload; this audit anchors on those, not on placeholder
  // copy. The `aria-label="Writing canvas"` is the stable a11y anchor.
  assert.match(page, /aria-label="Writing canvas"/);
  assert.match(page, /textareaRef\.current\.value = ""/);
  assert.match(audit, /does not retain or name plaintext snapshots/);
  assert.match(browser, /uploads no plaintext/);
});

test("producer-core contract excludes plaintext, text hashes, and replay", async () => {
  const readme = await text("packages/producer-core/README.md");
  const audit = await text("tests/producer-core-audit.test.mjs");

  assert.match(readme, /Store, hash, replay, upload, or require document text/);
  assert.match(readme, /does not verify document content/);
  assert.match(audit, /producer-core source contains no banned plaintext-handling symbols/);
});
