import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { verifyRecord } from "../packages/format/src/index.ts";
import { checkCapabilityAccuracy } from "../packages/conformance/src/index.ts";

const emacs = spawnSync("bash", ["-lc", "command -v emacs"], { encoding: "utf8" }).stdout.trim();

function runEmacs(scriptPath) {
  return spawnSync(emacs, ["--batch", "-Q", "-l", scriptPath], {
    cwd: resolve("."),
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

test("Emacs producer captures Unicode codepoint mutations and builds a conformant content-opaque record", { skip: emacs ? false : "emacs binary not available" }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pmbah-emacs-test-"));
  const outputPath = join(temp, "record.json");
  const scriptPath = join(temp, "scenario.el");
  const modePath = resolve("producers/emacs/pmbah-mode.el");
  const helperPath = resolve("producers/emacs/scripts/build-record.mjs");

  await writeFile(scriptPath, `;;; scenario.el --- PMBAH test scenario -*- lexical-binding: t; -*-
(load ${JSON.stringify(modePath)})
(setq pmbah-helper-script ${JSON.stringify(helperPath)})
(with-temp-buffer
  (text-mode)
  (pmbah-mode 1)
  ;; Insert three Unicode codepoints, delete the non-ASCII one, insert another,
  ;; then use an Emacs replace primitive so after-change reports a replacement.
  (insert "A🙂B")
  (goto-char 2)
  (delete-char 1)
  (insert "é")
  (goto-char 2)
  (search-forward "é")
  (replace-match "zz")
  (let* ((context (list :surface "emacs" :emacs (list :buffer_name "scratch-test" :major_mode "text-mode")))
         (record (pmbah-build-record-for-current-buffer context))
         (default-context (pmbah--capture-context nil nil))
         (output (list :record record :default_context default-context)))
    (with-temp-file ${JSON.stringify(outputPath)}
      (insert (pmbah--json-encode output)))))
`);

  try {
    const result = runEmacs(scriptPath);
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const fixture = JSON.parse(await readFile(outputPath, "utf8"));
    const { record, default_context: defaultContext } = fixture;

    assert.deepEqual(defaultContext, { surface: "emacs" });
    assert.equal(JSON.stringify(defaultContext).includes(resolve(".")), false);

    assert.equal(record.manifest.producer.id, "emacs");
    assert.deepEqual(record.manifest.producer.capabilities, ["timing", "pause_fidelity"]);
    assert.equal(record.manifest.capture_context.surface, "emacs");
    assert.equal(record.manifest.capture_context.emacs.buffer_name, "scratch-test");
    assert.equal(record.manifest.capture_context.emacs.major_mode, "text-mode");
    assert.equal(JSON.stringify(record.manifest.capture_context).includes(resolve(".")), false);

    assert.deepEqual(record.events.map(({ op, pos, del_len, ins_len }) => ({ op, pos, del_len, ins_len })), [
      { op: "insert", pos: 0, del_len: 0, ins_len: 3 },
      { op: "delete", pos: 1, del_len: 1, ins_len: 0 },
      { op: "insert", pos: 1, del_len: 0, ins_len: 1 },
      { op: "replace", pos: 1, del_len: 1, ins_len: 2 },
    ]);

    for (const event of record.events) {
      assert.equal("ins_text" in event, false);
      assert.equal("text" in event, false);
    }
    assert.equal(JSON.stringify(record).includes("A🙂B"), false);
    assert.equal(JSON.stringify(record).includes("é"), false);
    assert.equal(JSON.stringify(record).includes("zz"), false);

    const verification = verifyRecord(record);
    assert.equal(verification.valid, true, verification.errors.join("; "));
    assert.equal("final_text_hash" in record.manifest, false);
    assert.equal("final_text_length" in record.manifest, false);
    assert.deepEqual(checkCapabilityAccuracy(record.manifest.producer.capabilities, record.events), []);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
