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

test("Emacs producer captures Unicode codepoint mutations and builds a conformant content-blind record", { skip: emacs ? false : "emacs binary not available" }, async () => {
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

test("Emacs producer records newline insertion as one codepoint", { skip: emacs ? false : "emacs binary not available" }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pmbah-emacs-newline-"));
  const outputPath = join(temp, "newline.json");
  const scriptPath = join(temp, "newline.el");
  const modePath = resolve("producers/emacs/pmbah-mode.el");

  await writeFile(scriptPath, `;;; newline.el --- PMBAH newline test -*- lexical-binding: t; -*-
(load ${JSON.stringify(modePath)})
(with-temp-buffer
  (text-mode)
  (pmbah-mode 1)
  (insert "one")
  (newline)
  (insert "two")
  (let ((output (list :events (vconcat (pmbah--session-events)))))
    (with-temp-file ${JSON.stringify(outputPath)}
      (insert (pmbah--json-encode output)))))
`);

  try {
    const result = runEmacs(scriptPath);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    assert.deepEqual(output.events.map(({ op, pos, del_len, ins_len }) => ({ op, pos, del_len, ins_len })), [
      { op: "insert", pos: 0, del_len: 0, ins_len: 3 },
      { op: "insert", pos: 3, del_len: 0, ins_len: 1 },
      { op: "insert", pos: 4, del_len: 0, ins_len: 3 },
    ]);
    assert.equal(JSON.stringify(output).includes("one"), false);
    assert.equal(JSON.stringify(output).includes("two"), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Emacs producer starts in non-empty buffers without text or baseline fields", { skip: emacs ? false : "emacs binary not available" }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pmbah-emacs-nonempty-"));
  const outputPath = join(temp, "nonempty.json");
  const scriptPath = join(temp, "nonempty.el");
  const modePath = resolve("producers/emacs/pmbah-mode.el");
  const helperPath = resolve("producers/emacs/scripts/build-record.mjs");

  await writeFile(scriptPath, `;;; nonempty.el --- PMBAH non-empty start test -*- lexical-binding: t; -*-
(load ${JSON.stringify(modePath)})
(setq pmbah-helper-script ${JSON.stringify(helperPath)})
(with-temp-buffer
  (text-mode)
  (insert "PREEXISTING-CANARY🙂")
  (let ((start-pos (1- (point-max))))
    (pmbah-mode 1)
    (goto-char (point-max))
    (insert "X")
    (let* ((record (pmbah-build-record-for-current-buffer (list :surface "emacs")))
           (output (list :enabled (if pmbah-mode t :json-false)
                         :start_pos start-pos
                         :session pmbah--session-id
                         :event_count pmbah--next-seq
                         :record record)))
      (with-temp-file ${JSON.stringify(outputPath)}
        (insert (pmbah--json-encode output))))))
`);

  try {
    const result = runEmacs(scriptPath);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    const { record } = output;
    assert.equal(output.enabled, true);
    assert.equal(output.event_count, 1);
    assert.equal("initial_observed_length" in record.manifest, false);
    assert.deepEqual(record.events.map(({ op, pos, del_len, ins_len }) => ({ op, pos, del_len, ins_len })), [
      { op: "insert", pos: output.start_pos, del_len: 0, ins_len: 1 },
    ]);
    const verification = verifyRecord(record);
    assert.equal(verification.valid, true, verification.errors.join("; "));
    assert.equal("final_text_hash" in record.manifest, false);
    assert.equal("final_text_length" in record.manifest, false);
    const serialized = JSON.stringify(record);
    assert.equal(serialized.includes("PREEXISTING-CANARY"), false);
    assert.equal(serialized.includes("🙂"), false);
    assert.equal(serialized.includes("X"), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Emacs producer starts a fresh session after successful upload", { skip: emacs ? false : "emacs binary not available" }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pmbah-emacs-post-upload-"));
  const outputPath = join(temp, "post-upload.json");
  const scriptPath = join(temp, "post-upload.el");
  const modePath = resolve("producers/emacs/pmbah-mode.el");
  const helperPath = resolve("producers/emacs/scripts/build-record.mjs");

  await writeFile(scriptPath, `;;; post-upload.el --- PMBAH post-upload scope test -*- lexical-binding: t; -*-
(require 'cl-lib)
(load ${JSON.stringify(modePath)})
(setq pmbah-helper-script ${JSON.stringify(helperPath)})
(with-temp-buffer
  (text-mode)
  (pmbah-mode 1)
  (insert "PostUploadCanary🙂")
  (let ((response nil))
    (cl-letf (((symbol-function 'pmbah--post-record)
               (lambda (_record)
                 (list :record_hash "b3:stub" :short_signature "stub" :url "http://localhost:8000/stub" :created t))))
      (setq response (pmbah-sign-buffer (list :surface "emacs"))))
    (let ((output (list :response response
                        :enabled (if pmbah-mode t :json-false)
                        :session pmbah--session-id
                        :events pmbah--events
                        :event_count pmbah--next-seq
                        :hook_present (if (memq #'pmbah--after-change after-change-functions) t :json-false))))
      (with-temp-file ${JSON.stringify(outputPath)}
        (insert (pmbah--json-encode output))))))
`);

  try {
    const result = runEmacs(scriptPath);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(output.response.url, "http://localhost:8000/stub");
    assert.equal(output.enabled, true);
    assert.equal(typeof output.session, "string");
    assert.equal(output.events, null);
    assert.equal(output.event_count, 0);
    assert.equal(output.hook_present, true);
    assert.equal(JSON.stringify(output).includes("PostUploadCanary"), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Emacs sign binding uses active region or whole buffer and avoids preview buffers", { skip: emacs ? false : "emacs binary not available" }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pmbah-emacs-binding-scope-"));
  const outputPath = join(temp, "binding-scope.json");
  const scriptPath = join(temp, "binding-scope.el");
  const modePath = resolve("producers/emacs/pmbah-mode.el");

  await writeFile(scriptPath, `;;; binding-scope.el --- PMBAH binding scope test -*- lexical-binding: t; -*-
(require 'cl-lib)
(load ${JSON.stringify(modePath)})

(defun pmbah-test-sign-final-text (activate-region)
  (let ((captured nil)
        (prompts nil)
        (answers '(t)))
    (with-temp-buffer
      (text-mode)
      (insert "alpha beta gamma")
      (pmbah-mode 1)
      (goto-char (point-max))
      (insert "!")
      (when activate-region
        (transient-mark-mode 1)
        (goto-char (+ (point-min) 6))
        (set-mark (point))
        (goto-char (+ (point-min) 10))
        (activate-mark)
        (unless (use-region-p)
          (error "expected active region")))
      (cl-letf (((symbol-function 'pmbah--y-or-n-p-default-yes)
                 (lambda (prompt)
                   (push prompt prompts)
                   (prog1 (car answers)
                     (setq answers (cdr answers)))))
                ((symbol-function 'pmbah--run-helper)
                 (lambda (payload)
                   (setq captured payload)
                   (list :record (list :manifest (list :record_hash "b3:stub") :events []))))
                ((symbol-function 'pmbah--post-record)
                 (lambda (_record) (list :url "https://example.test/record"))))
        (let ((noninteractive nil))
          (pmbah-sign-buffer (list :surface "emacs"))))
      (list :final_text (plist-get captured :final_text)
            :prompts (vconcat (nreverse prompts))))))

(defun pmbah-test-prefix-sign-no-prompts ()
  (let ((captured nil))
    (with-temp-buffer
      (rename-buffer "prefix-buffer")
      (text-mode)
      (insert "prefix ")
      (pmbah-mode 1)
      (insert "body")
      (cl-letf (((symbol-function 'pmbah--y-or-n-p-default-yes)
                 (lambda (prompt)
                   (error "unexpected prompt: %s" prompt)))
                ((symbol-function 'pmbah--run-helper)
                 (lambda (payload)
                   (setq captured payload)
                   (list :record (list :manifest (list :record_hash "b3:stub") :events []))))
                ((symbol-function 'pmbah--post-record)
                 (lambda (_record) (list :url "https://example.test/record"))))
        (let ((noninteractive nil)
              (current-prefix-arg '(4)))
          (call-interactively #'pmbah-sign-buffer)))
      captured)))

(when (get-buffer "*PMBAH capture context*")
  (kill-buffer "*PMBAH capture context*"))
(let ((context nil)
      (answers '(nil nil)))
  (cl-letf (((symbol-function 'pmbah--y-or-n-p-default-yes)
             (lambda (_prompt)
               (prog1 (car answers)
                 (setq answers (cdr answers))))))
    (setq context (pmbah-review-capture-context)))
  (let* ((region-result (pmbah-test-sign-final-text t))
         (whole-result (pmbah-test-sign-final-text nil))
         (prefix-payload (pmbah-test-prefix-sign-no-prompts))
         (output (list :region_text (plist-get region-result :final_text)
                       :whole_buffer_text (plist-get whole-result :final_text)
                       :region_prompts (plist-get region-result :prompts)
                       :whole_buffer_prompts (plist-get whole-result :prompts)
                       :prefix_final_text (plist-get prefix-payload :final_text)
                       :prefix_context (plist-get prefix-payload :capture_context)
                       :default_yes_answer (cl-letf (((symbol-function 'read-from-minibuffer) (lambda (_prompt) "")))
                                             (pmbah--y-or-n-p-default-yes "Default? "))
                       :explicit_no_answer (cl-letf (((symbol-function 'read-from-minibuffer) (lambda (_prompt) "n")))
                                             (if (pmbah--y-or-n-p-default-yes "No? ") t :json-false))
                       :context context
                       :preview_buffer_exists (if (get-buffer "*PMBAH capture context*") t :json-false))))
    (with-temp-file ${JSON.stringify(outputPath)}
      (insert (pmbah--json-encode output)))))
`);

  try {
    const result = runEmacs(scriptPath);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(output.region_text, "beta");
    assert.equal(output.whole_buffer_text, "alpha beta gamma!");
    assert.equal(output.region_prompts[0], "Bind the selected region to this record? ");
    assert.equal(output.whole_buffer_prompts[0], "Bind the whole buffer to this record? ");
    assert.equal(output.prefix_final_text, "prefix body");
    assert.deepEqual(output.prefix_context, { surface: "emacs", emacs: { buffer_name: "prefix-buffer", major_mode: "text-mode" } });
    assert.equal(output.default_yes_answer, true);
    assert.equal(output.explicit_no_answer, false);
    assert.deepEqual(output.context, { surface: "emacs" });
    assert.equal(output.preview_buffer_exists, false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Emacs helper payload contains only process metadata", { skip: emacs ? false : "emacs binary not available" }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pmbah-emacs-payload-"));
  const outputPath = join(temp, "payload.json");
  const scriptPath = join(temp, "payload.el");
  const modePath = resolve("producers/emacs/pmbah-mode.el");

  await writeFile(scriptPath, `;;; payload.el --- PMBAH helper payload test -*- lexical-binding: t; -*-
(require 'cl-lib)
(load ${JSON.stringify(modePath)})
(with-temp-buffer
  (text-mode)
  (pmbah-mode 1)
  (insert "Alpha🙂Beta")
  (goto-char 6)
  (delete-char 1)
  (insert "Ω")
  (let ((captured nil))
    (cl-letf (((symbol-function 'pmbah--run-helper)
               (lambda (payload)
                 (setq captured payload)
                 (list :record (list :manifest nil :events [])))))
      (pmbah-build-record-for-current-buffer (list :surface "emacs")))
    (with-temp-file ${JSON.stringify(outputPath)}
      (insert (pmbah--json-encode captured)))))
`);

  try {
    const result = runEmacs(scriptPath);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(await readFile(outputPath, "utf8"));
    const serialized = JSON.stringify(payload);
    for (const forbidden of [
      "Alpha🙂Beta",
      "Alpha",
      "Beta",
      "Ω",
      "final_text",
      "final_text_hash",
      "final_text_length",
      "ins_text",
      "ins_hash",
      "replay_insertions_by_seq",
    ]) {
      assert.equal(serialized.includes(forbidden), false, `helper payload leaked ${forbidden}`);
    }
    assert.equal("initial_observed_length" in payload, false);
    assert.equal(Array.isArray(payload.events), true);
    assert.equal(payload.events.length, 3);
    assert.deepEqual(payload.events.map(({ op, pos, del_len, ins_len }) => ({ op, pos, del_len, ins_len })), [
      { op: "insert", pos: 0, del_len: 0, ins_len: 10 },
      { op: "delete", pos: 5, del_len: 1, ins_len: 0 },
      { op: "insert", pos: 5, del_len: 0, ins_len: 1 },
    ]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Emacs helper handles large content-blind event shapes without text replay", () => {
  const helperPath = resolve("producers/emacs/scripts/build-record.mjs");
  const payload = {
    format_version: "0.1",
    session_id: "00000000-0000-4000-8000-000000000032",
    producer: { id: "emacs", version: "0.1.0", capabilities: ["timing", "pause_fidelity"] },
    capture_context: { surface: "emacs" },
    events: [{ seq: 0, t: 0, op: "insert", pos: 0, del_len: 0, ins_len: 200_000, source: "programmatic" }],
    duration_ms: 0,
    created_client_t: "2026-05-28T00:00:00.000Z",
  };
  const result = spawnSync(process.execPath, [helperPath], {
    cwd: resolve("."),
    encoding: "utf8",
    input: JSON.stringify(payload),
    maxBuffer: 20 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(verifyRecord(output.record).valid, true);
  const serialized = JSON.stringify(output);
  assert.equal(serialized.includes("replay_insertions_by_seq"), false);
  assert.equal(serialized.includes("final_text"), false);
  assert.equal(serialized.includes("a".repeat(100)), false);
});

test("Emacs helper seals a content-blind text binding from transient final text without leaking plaintext", () => {
  const helperPath = resolve("producers/emacs/scripts/build-record.mjs");
  const marker = "EMACSBINDCANARY777";
  const payload = {
    session_id: "00000000-0000-4000-8000-000000000033",
    producer: { id: "emacs", version: "0.1.0", capabilities: ["timing", "pause_fidelity"] },
    capture_context: { surface: "emacs" },
    events: [
      { seq: 0, t: 0, op: "insert", pos: 0, del_len: 0, ins_len: 5, source: "typing" },
      { seq: 1, t: 90, op: "insert", pos: 5, del_len: 0, ins_len: 6, source: "typing" },
    ],
    duration_ms: 90,
    final_text: `Hello there, ${marker} — this is the buffer text.`,
    created_client_t: "2026-05-28T00:00:00.000Z",
  };
  const result = spawnSync(process.execPath, [helperPath], {
    cwd: resolve("."),
    encoding: "utf8",
    input: JSON.stringify(payload),
    maxBuffer: 10 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(verifyRecord(output.record).valid, true);
  const binding = output.record.manifest.text_binding;
  assert.equal(output.record.manifest.format_version, "0.2");
  assert.equal(binding.scheme, "canon-letters/0.1");
  assert.equal(Object.hasOwn(binding, "policy"), false);
  assert.ok(binding.canonical_length > 0);
  // The transient final text must not survive into the helper output anywhere.
  const serialized = JSON.stringify(output);
  assert.equal(serialized.includes(marker), false);
  assert.equal(serialized.includes("Hello there"), false);
  assert.equal(serialized.includes("final_text"), false);
});
