import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

import { computeEventHashChain, verifyRecord } from "../packages/format/src/index.ts";
import { checkCapabilityAccuracy } from "../packages/conformance/src/index.ts";

const emacs = spawnSync("bash", ["-lc", "command -v emacs"], { encoding: "utf8" }).stdout.trim();

// Scenarios that do not test observation point the producer at a closed port so
// no test can ever reach the public service. Emacs runs asynchronously so that
// an ingest API served from this process can answer it.
async function runEmacs(scriptPath, env = {}) {
  const recoveryDirectory = await mkdtemp(join(tmpdir(), "pmbah-emacs-recovery-"));
  try {
    return await new Promise((resolveRun, rejectRun) => {
      const child = spawn(emacs, ["--batch", "-Q", "--eval", `(progn
          (setq pmbah-state-directory ${JSON.stringify(recoveryDirectory)})
          (defun pmbah-test-materialize (descriptor)
            (append (list (cons 'manifest (alist-get 'manifest descriptor))
                          (cons 'events (vconcat (pmbah--session-events))))
                    (when (alist-get 'observation descriptor)
                      (list (cons 'observation (alist-get 'observation descriptor)))))))`, "-l", scriptPath], {
        cwd: resolve("."),
        env: { ...process.env, PMBAH_API_BASE_URL: "http://127.0.0.1:9", ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      child.on("error", rejectRun);
      child.on("close", (status) => resolveRun({ status, stdout, stderr }));
    });
  } finally {
    await rm(recoveryDirectory, { recursive: true, force: true });
  }
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
(setq pmbah-observe-process nil)
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
    const result = await runEmacs(scriptPath);
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
    const result = await runEmacs(scriptPath);
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
(setq pmbah-observe-process nil)
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
    const result = await runEmacs(scriptPath);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    const { record } = output;
    assert.equal(output.enabled, true);
    assert.equal(output.event_count, 1);
    assert.equal("initial_observed_length" in record.manifest, false);
    assert.deepEqual(record.events.map(({ op, pos, del_len, ins_len }) => ({ op, pos, del_len, ins_len })), [
      { op: "insert", pos: null, del_len: 0, ins_len: 1 },
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

test("Emacs marks interrupted capture without inventing events and retains absolute narrowed positions", { skip: emacs ? false : "emacs binary not available" }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pmbah-emacs-gaps-"));
  const outputPath = join(temp, "gaps.json");
  const scriptPath = join(temp, "gaps.el");
  await writeFile(scriptPath, `;;; gaps.el -*- lexical-binding: t; -*-
(load ${JSON.stringify(resolve("producers/emacs/pmbah-mode.el"))})
(setq pmbah-observe-process nil)
(let (events snapshot refused whole-binding)
  (with-temp-buffer
    (insert "unobserved prefix")
    (narrow-to-region (point-max) (point-max))
    (pmbah-mode 1)
    (insert "A")
    (insert "B")
    (pmbah-mode -1)
    (insert "C")
    (pmbah-mode 1)
    (insert "D")
    (let ((inhibit-modification-hooks t)) (insert "E"))
    (insert "F")
    (emacs-lisp-mode)
    (insert "G")
    (setq events (vconcat (pmbah--session-events)))
    (pmbah-mode -1)
    (setq snapshot (pmbah--state-snapshot))
    (pmbah-mode 1)
    (setq refused (condition-case err
                      (progn (pmbah-sign-buffer (list :surface "emacs") t) nil)
                    (user-error (error-message-string err)))))
  (with-temp-buffer
    (pmbah-mode 1)
    (insert "outside MIDDLE outside")
    (narrow-to-region 9 15)
    (cl-letf (((symbol-function 'pmbah--run-helper)
               (lambda (payload &optional _script)
                 (setq whole-binding (plist-get payload :final_text))
                 (list :record (list :manifest nil :events []))))
              ((symbol-function 'pmbah--post-record)
               (lambda (_body) (list :url "https://example.test/record"))))
      (pmbah-sign-buffer (list :surface "emacs") t)))
  (with-temp-file ${JSON.stringify(outputPath)}
    (insert (pmbah--json-encode
             (list :events events :snapshot snapshot :refused refused :whole_binding whole-binding)))))
`);
  try {
    const result = await runEmacs(scriptPath);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(output.events.length, 5, "only observed mutations are recorded");
    assert.deepEqual(output.events.map((event) => event.pos), [null, 18, null, null, 23]);
    assert.ok(output.events.every((event) => event.ins_len === 1 && event.del_len === 0));
    assert.equal(output.snapshot.pending_gap, true, "stopping capture persists the boundary");
    assert.match(output.refused, /Capture has a gap/);
    assert.equal(output.whole_binding, "outside MIDDLE outside", "whole-buffer binding includes text outside narrowing");
    assert.equal(JSON.stringify(output.snapshot).includes("unobserved prefix"), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Emacs refuses binding immediately after edits hidden from its hooks", { skip: emacs ? false : "emacs binary not available" }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pmbah-emacs-hidden-edit-"));
  const scriptPath = join(temp, "hidden.el");
  await writeFile(scriptPath, `;;; hidden.el -*- lexical-binding: t; -*-
(load ${JSON.stringify(resolve("producers/emacs/pmbah-mode.el"))})
(setq pmbah-observe-process nil)
(with-temp-buffer
  (pmbah-mode 1)
  (insert "known")
  (let ((inhibit-modification-hooks t)) (insert " hidden"))
  (condition-case err
      (progn (pmbah-sign-buffer (list :surface "emacs") t) (error "binding should fail"))
    (user-error (princ (error-message-string err)))))
`);
  try {
    const result = await runEmacs(scriptPath);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Capture has a gap/);
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
(setq pmbah-observe-process nil)
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
    const result = await runEmacs(scriptPath);
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
                 (lambda (payload &optional _script)
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
                 (lambda (payload &optional _script)
                   (setq captured payload)
                   (list :record (list :manifest (list :record_hash "b3:stub") :events []))))
                ((symbol-function 'pmbah--post-record)
                 (lambda (_record) (list :url "https://example.test/record"))))
        (let ((noninteractive t)
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
    const result = await runEmacs(scriptPath);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(output.region_text, "beta");
    assert.equal(output.whole_buffer_text, "alpha beta gamma!");
    assert.equal(output.region_prompts[0], "Anyone can test guesses against this public commitment. Bind the selected region? ");
    assert.equal(output.whole_buffer_prompts[0], "Anyone can test guesses against this public commitment. Bind the whole buffer? ");
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
               (lambda (payload &optional _script)
                 (setq captured payload)
                 (list :record (list :manifest nil :events [])))))
      (pmbah-build-record-for-current-buffer (list :surface "emacs")))
    (with-temp-file ${JSON.stringify(outputPath)}
      (insert (pmbah--json-encode captured)))))
`);

  try {
    const result = await runEmacs(scriptPath);
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
    assert.equal(payload.events, undefined, "the helper receives a journal descriptor, not full history");
    assert.equal(payload.event_count, 3);
    assert.match(payload.journal_path, /events-[0-9a-f-]+\.jsonl$/);
    assert.equal(payload.operation, "export");
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

test("Emacs helper never echoes its input back when the input is malformed", () => {
  const helperPath = resolve("producers/emacs/scripts/build-record.mjs");
  const marker = "SECRET-DOCUMENT-WORDS-9f3a";
  const result = spawnSync(process.execPath, [helperPath], { input: `{"final_text": "${marker}"`, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.equal(result.stderr.includes(marker), false, result.stderr);
  assert.equal(result.stdout.includes(marker), false);
  assert.match(result.stderr, /not valid JSON/);
});

test("Emacs chain-tip helper computes the public prefix tip and refuses text-bearing input", () => {
  const helperPath = resolve("producers/emacs/scripts/chain-tip.mjs");
  const sessionId = "00000000-0000-4000-8000-000000000034";
  const events = [
    { seq: 0, t: 0, op: "insert", pos: 0, del_len: 0, ins_len: 5, source: "typing" },
    { seq: 1, t: 90, op: "insert", pos: 5, del_len: 0, ins_len: 6, source: "typing" },
  ];
  const run = (input) => spawnSync(process.execPath, [helperPath], { cwd: resolve("."), encoding: "utf8", input });

  const ok = run(JSON.stringify({ session_id: sessionId, format_version: "0.2", events }));
  assert.equal(ok.status, 0, ok.stderr || ok.stdout);
  assert.deepEqual(JSON.parse(ok.stdout), {
    event_count: 2,
    chain_tip: computeEventHashChain(events, sessionId, "0.2").at(-1),
  });
  assert.notEqual(JSON.parse(ok.stdout).chain_tip, computeEventHashChain(events, sessionId, "0.1").at(-1));

  const tail = [
    { seq: 2, t: 400, op: "delete", pos: 3, del_len: 2, ins_len: 0, source: "typing" },
    { seq: 3, t: 900, op: "insert", pos: 3, del_len: 0, ins_len: 1, source: "typing" },
  ];
  const fullChain = computeEventHashChain([...events, ...tail], sessionId, "0.2");
  const incremental = run(JSON.stringify({
    session_id: sessionId,
    format_version: "0.2",
    previous_chain_tip: fullChain[1],
    previous_event_count: 2,
    events: tail,
  }));
  assert.equal(incremental.status, 0, incremental.stderr || incremental.stdout);
  assert.deepEqual(JSON.parse(incremental.stdout), { event_count: 4, chain_tip: fullChain.at(-1) }, "advancing from a prefix tip equals a full recompute");

  const gap = run(JSON.stringify({ session_id: sessionId, format_version: "0.2", previous_chain_tip: fullChain[1], previous_event_count: 1, events: tail }));
  assert.notEqual(gap.status, 0);
  assert.match(gap.stderr, /previous_event_count/);

  const tipWithoutCount = run(JSON.stringify({ session_id: sessionId, format_version: "0.2", previous_chain_tip: fullChain[1], events: tail }));
  assert.notEqual(tipWithoutCount.status, 0);

  const marker = "CHAINTIP-CANARY-1c2d";
  const textField = run(JSON.stringify({ session_id: sessionId, format_version: "0.2", events, final_text: marker }));
  assert.notEqual(textField.status, 0);
  assert.equal(textField.stdout, "");
  assert.equal(textField.stderr.includes(marker), false, textField.stderr);
  assert.match(textField.stderr, /unexpected field/);

  const malformed = run(`{"events": "${marker}"`);
  assert.notEqual(malformed.status, 0);
  assert.equal(malformed.stderr.includes(marker), false, malformed.stderr);
  assert.match(malformed.stderr, /not valid JSON/);
});

test("Emacs producer commits server-observed checkpoints while writing and binds them at sign time", { skip: emacs ? false : "emacs binary not available" }, async () => {
  const { createIngestApi } = await import("../apps/ingest-api/src/index.ts");
  const { createRuntimeServer } = await import("../apps/ingest-api/src/server.ts");
  const { InMemoryRecordStore } = await import("../packages/storage/src/index.ts");
  const store = new InMemoryRecordStore();
  const api = createIngestApi({ store, baseUrl: "http://pmbah.test" });
  const server = createRuntimeServer({ api, db: { async query() { return { rows: [] }; } } });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address();

  const temp = await mkdtemp(join(tmpdir(), "pmbah-emacs-observed-"));
  const outputPath = join(temp, "observed.json");
  const scriptPath = join(temp, "observed.el");
  const modePath = resolve("producers/emacs/pmbah-mode.el");
  const helperPath = resolve("producers/emacs/scripts/build-record.mjs");

  await writeFile(scriptPath, `;;; observed.el --- PMBAH server-observed scenario -*- lexical-binding: t; -*-
(require 'cl-lib)
(load ${JSON.stringify(modePath)})
(setq pmbah-helper-script ${JSON.stringify(helperPath)})
;; Record what the real chain-tip helper is asked to compute, then run it.
(defvar pmbah-test-helper-payloads nil)
(let ((run-helper (symbol-function 'pmbah--run-node-script-async)))
  (cl-letf (((symbol-function 'pmbah--run-node-script-async)
             (lambda (script payload callback)
               (push (list :previous_event_count (plist-get payload :previous_event_count)
                           :previous_chain_tip (plist-get payload :previous_chain_tip)
                           :event_count (plist-get payload :event_count)
                           :previous_byte_offset (plist-get payload :previous_byte_offset)
                           :end_byte (plist-get payload :end_byte)
                           :events_present (if (plist-member payload :events) t :json-false))
                     pmbah-test-helper-payloads)
               (funcall run-helper script payload callback))))
    (with-temp-buffer
      (text-mode)
      (pmbah-mode 1)
      (insert "First words")
      ;; The first mutation commits immediately; wait for the server's answer.
      (pmbah--observation-wait 10)
      (let ((status-after-first-edit (pmbah--observation-status))
            (mode-line-after-first-edit (pmbah--mode-line)))
        (insert " and a few more")
        (goto-char (point-min))
        (delete-char 1)
        (let* ((status-before-sign (pmbah--observation-status))
               (mode-line-before-sign (pmbah--mode-line))
               (response (pmbah-sign-buffer (list :surface "emacs") t))
               (status-after-sign (pmbah--observation-status))
               (output (list :response response
                             :status_after_first_edit status-after-first-edit
                             :mode_line_after_first_edit mode-line-after-first-edit
                             :status_before_sign status-before-sign
                             :mode_line_before_sign mode-line-before-sign
                             :status_after_sign status-after-sign
                             :helper_payloads (vconcat (nreverse pmbah-test-helper-payloads)))))
          (with-temp-file ${JSON.stringify(outputPath)}
            (insert (pmbah--json-encode output))))))))
`);

  try {
    const result = await runEmacs(scriptPath, { PMBAH_API_BASE_URL: `http://127.0.0.1:${port}` });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    assert.match(output.response.short_signature, /^[1-9A-HJ-NP-Za-km-z]+$/);

    const fetched = await api.getRecord(output.response.short_signature);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.manifest.producer.id, "emacs");
    assert.equal(fetched.body.manifest.format_version, "0.3");
    assert.equal(fetched.body.events.length, 3);
    assert.equal(fetched.body.observation.state, "observed");
    assert.ok(fetched.body.observation.checkpoint_count >= 2, "first-edit checkpoint plus the pre-sign flush");
    assert.equal(fetched.body.observation.commitments.at(-1).event_count, 3);
    assert.equal(fetched.body.observation.observed_session_id, fetched.body.manifest.session_id);
    assert.equal(JSON.stringify(fetched.body).includes("First words"), false);
    assert.equal(JSON.stringify(output).includes("First words"), false);
    assert.equal(output.status_after_first_edit.state, "known");
    assert.equal(output.status_after_first_edit.committed_event_count, 1);
    assert.equal(output.mode_line_after_first_edit, " PMBAH:1✓");
    assert.equal(output.status_before_sign.state, "partial");
    assert.equal(output.mode_line_before_sign, " PMBAH:3·");
    assert.equal(output.status_after_sign.state, "unknown", "a fresh session starts after upload");
    assert.equal(output.status_after_sign.event_count, 0);
    assert.equal(output.status_after_sign.token_present, false);
    assert.equal(output.status_after_first_edit.chain_tip_event_count, 1);
    assert.equal(output.helper_payloads.length, 2, "first-edit checkpoint plus the pre-sign flush");
    assert.equal(output.helper_payloads[0].previous_event_count, null);
    assert.equal(output.helper_payloads[0].previous_chain_tip, null);
    assert.equal(output.helper_payloads[0].event_count, 1);
    assert.equal(output.helper_payloads[0].events_present, false);
    assert.equal(output.helper_payloads[1].previous_event_count, 1);
    assert.equal(output.helper_payloads[1].previous_chain_tip, fetched.body.observation.commitments[0].chain_tip);
    assert.equal(output.helper_payloads[1].event_count, 3);
    assert.equal(output.helper_payloads[1].events_present, false);
    assert.equal(output.helper_payloads[1].previous_byte_offset, output.helper_payloads[0].end_byte,
      "the next checkpoint starts exactly after the previously hashed prefix");
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(temp, { recursive: true, force: true });
  }
});

test("Emacs producer uploads an explicit unobserved state when no checkpoint ever succeeded", { skip: emacs ? false : "emacs binary not available" }, async () => {
  const { createIngestApi } = await import("../apps/ingest-api/src/index.ts");
  const { createRuntimeServer } = await import("../apps/ingest-api/src/server.ts");
  const { InMemoryRecordStore } = await import("../packages/storage/src/index.ts");
  const store = new InMemoryRecordStore();
  const api = createIngestApi({ store, baseUrl: "http://pmbah.test" });
  const server = createRuntimeServer({ api, db: { async query() { return { rows: [] }; } } });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address();

  const temp = await mkdtemp(join(tmpdir(), "pmbah-emacs-unobserved-"));
  const outputPath = join(temp, "unobserved.json");
  const scriptPath = join(temp, "unobserved.el");
  const modePath = resolve("producers/emacs/pmbah-mode.el");
  const helperPath = resolve("producers/emacs/scripts/build-record.mjs");

  await writeFile(scriptPath, `;;; unobserved.el --- checkpoints unreachable, upload reachable -*- lexical-binding: t; -*-
(load ${JSON.stringify(modePath)})
(setq pmbah-helper-script ${JSON.stringify(helperPath)})
;; Checkpoints go to a closed port; only the final upload reaches the service.
(setq pmbah-observation-base-url "http://127.0.0.1:9")
(with-temp-buffer
  (text-mode)
  (pmbah-mode 1)
  (insert "Offline words")
  (pmbah--observation-wait 10)
  (setq pmbah-observation-base-url nil)
  (let* ((status-before-sign (pmbah--observation-status))
         (response (pmbah-sign-buffer (list :surface "emacs") t))
         (output (list :response response :status_before_sign status-before-sign)))
    (with-temp-file ${JSON.stringify(outputPath)}
      (insert (pmbah--json-encode output)))))
`);

  try {
    const result = await runEmacs(scriptPath, { PMBAH_API_BASE_URL: `http://127.0.0.1:${port}` });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(output.status_before_sign.state, "unknown");
    assert.equal(output.status_before_sign.token_present, false);
    assert.match(output.status_before_sign.last_failure, /^transient/);
    const fetched = await api.getRecord(output.response.short_signature);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.observation.state, "unobserved");
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(temp, { recursive: true, force: true });
  }
});

test("Emacs producer uploads a diverged session as unobserved and tells the writer", { skip: emacs ? false : "emacs binary not available" }, async () => {
  const { createIngestApi } = await import("../apps/ingest-api/src/index.ts");
  const { createRuntimeServer } = await import("../apps/ingest-api/src/server.ts");
  const { InMemoryRecordStore } = await import("../packages/storage/src/index.ts");
  const store = new InMemoryRecordStore();
  const api = createIngestApi({ store, baseUrl: "http://pmbah.test" });
  const server = createRuntimeServer({ api, db: { async query() { return { rows: [] }; } } });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address();

  const temp = await mkdtemp(join(tmpdir(), "pmbah-emacs-diverged-"));
  const outputPath = join(temp, "diverged.json");
  const scriptPath = join(temp, "diverged.el");
  const modePath = resolve("producers/emacs/pmbah-mode.el");
  const helperPath = resolve("producers/emacs/scripts/build-record.mjs");

  await writeFile(scriptPath, `;;; diverged.el --- a diverged observation must not block signing -*- lexical-binding: t; -*-
(load ${JSON.stringify(modePath)})
(setq pmbah-helper-script ${JSON.stringify(helperPath)})
(with-temp-buffer
  (text-mode)
  (pmbah-mode 1)
  (insert "Committed words")
  (pmbah--observation-wait 10)
  ;; The server answers a later checkpoint with a conflict: the session is pinned diverged.
  (setq pmbah--observation-in-flight t)
  (pmbah--observation-apply (list 'conflict 409 "checkpoint_chain_tip_conflict"))
  (insert " and more")
  (let* ((status-before-sign (pmbah--observation-status))
         (response (pmbah-sign-buffer (list :surface "emacs") t)))
    (with-temp-file ${JSON.stringify(outputPath)}
      (insert (pmbah--json-encode (list :response response :status_before_sign status-before-sign))))))
`);

  try {
    const result = await runEmacs(scriptPath, { PMBAH_API_BASE_URL: `http://127.0.0.1:${port}` });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(output.status_before_sign.state, "diverged");
    assert.equal(output.status_before_sign.token_present, true);
    assert.match(output.response.short_signature, /^[1-9A-HJ-NP-Za-km-z]+$/, "the upload succeeded");
    const fetched = await api.getRecord(output.response.short_signature);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.events.length, 2);
    assert.equal(fetched.body.observation.state, "unobserved", "no token is bound for a diverged session");
    assert.match(result.stderr, /PMBAH record uploaded/);
    assert.match(result.stderr, /server observation diverged and was not bound/);
    assert.match(result.stderr, /conflict \(HTTP 409\): checkpoint_chain_tip_conflict/, "the last failure is shown");
    assert.equal(result.stderr.includes("Committed words"), false);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(temp, { recursive: true, force: true });
  }
});

test("Emacs pre-sign flush commits events that arrived while a checkpoint was in flight", { skip: emacs ? false : "emacs binary not available" }, async () => {
  const { createIngestApi } = await import("../apps/ingest-api/src/index.ts");
  const { createRuntimeServer } = await import("../apps/ingest-api/src/server.ts");
  const { InMemoryRecordStore } = await import("../packages/storage/src/index.ts");
  const store = new InMemoryRecordStore();
  const api = createIngestApi({ store, baseUrl: "http://pmbah.test" });
  const server = createRuntimeServer({ api, db: { async query() { return { rows: [] }; } } });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address();

  const temp = await mkdtemp(join(tmpdir(), "pmbah-emacs-flush-"));
  const outputPath = join(temp, "flush.json");
  const scriptPath = join(temp, "flush.el");
  const modePath = resolve("producers/emacs/pmbah-mode.el");
  const helperPath = resolve("producers/emacs/scripts/build-record.mjs");

  await writeFile(scriptPath, `;;; flush.el --- events captured during an in-flight kick are still flushed -*- lexical-binding: t; -*-
(load ${JSON.stringify(modePath)})
(setq pmbah-helper-script ${JSON.stringify(helperPath)})
(with-temp-buffer
  (text-mode)
  (pmbah-mode 1)
  (insert "One")
  (pmbah--observation-wait 10)
  ;; Not due by count or time, so the cadence does not queue this event.
  (insert " two")
  ;; The 60 s rule fires: a kick for two events goes in flight.
  (pmbah--observation-kick)
  ;; A third event arrives while that kick is in flight and is not queued either.
  (insert " three")
  (let ((during-flight (pmbah--observation-status)))
    (let ((response (pmbah-sign-buffer (list :surface "emacs") t)))
      (with-temp-file ${JSON.stringify(outputPath)}
        (insert (pmbah--json-encode (list :response response :during_flight during-flight)))))))
`);

  try {
    const result = await runEmacs(scriptPath, { PMBAH_API_BASE_URL: `http://127.0.0.1:${port}` });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(output.during_flight.in_flight, true);
    assert.equal(output.during_flight.committed_event_count, 1);
    assert.equal(output.during_flight.event_count, 3);
    const fetched = await api.getRecord(output.response.short_signature);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.events.length, 3);
    assert.equal(fetched.body.observation.state, "observed");
    assert.equal(fetched.body.observation.commitments.at(-1).event_count, 3);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(temp, { recursive: true, force: true });
  }
});

test("Emacs session survives a major-mode change and revert-buffer", { skip: emacs ? false : "emacs binary not available" }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pmbah-emacs-major-mode-"));
  const outputPath = join(temp, "major-mode.json");
  const scriptPath = join(temp, "major-mode.el");
  const documentPath = join(temp, "draft.txt");
  const modePath = resolve("producers/emacs/pmbah-mode.el");
  await writeFile(documentPath, "");

  await writeFile(scriptPath, `;;; major-mode.el --- session state outlives kill-all-local-variables -*- lexical-binding: t; -*-
(load ${JSON.stringify(modePath)})
(setq pmbah-observe-process nil)
(setq pmbah-state-directory ${JSON.stringify(join(temp, "state/"))})
(defun pmbah-test-snapshot (session)
  (list :same_session (if (equal session pmbah--session-id) t :json-false)
        :event_count pmbah--next-seq
        :enabled (if pmbah-mode t :json-false)
        :hook_present (if (memq #'pmbah--after-change after-change-functions) t :json-false)
        :major_mode (symbol-name major-mode)))
(let ((mode-change nil) (revert nil))
  (with-temp-buffer
    (text-mode)
    (pmbah-mode 1)
    (insert "one")
    (let ((session pmbah--session-id))
      (emacs-lisp-mode)
      (insert "two")
      (setq mode-change (pmbah-test-snapshot session))))
  (with-current-buffer (find-file-noselect ${JSON.stringify(documentPath)})
    (text-mode)
    (pmbah-mode 1)
    (insert "draft")
    (let ((session pmbah--session-id)
          (count-before pmbah--next-seq))
      (revert-buffer t t)
      (insert "again")
      (setq revert (append (pmbah-test-snapshot session)
                           (list :count_before count-before
                                 :events (vconcat (pmbah--session-events)))))
      (set-buffer-modified-p nil)))
  (with-temp-file ${JSON.stringify(outputPath)}
    (insert (pmbah--json-encode (list :mode_change mode-change :revert revert)))))
`);

  try {
    const result = await runEmacs(scriptPath);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(output.mode_change.same_session, true);
    assert.equal(output.mode_change.event_count, 2);
    assert.equal(output.mode_change.enabled, true);
    assert.equal(output.mode_change.hook_present, true);
    assert.equal(output.mode_change.major_mode, "emacs-lisp-mode");
    assert.equal(output.revert.same_session, true);
    assert.equal(output.revert.enabled, true);
    assert.equal(output.revert.hook_present, true);
    assert.equal(output.revert.count_before, 1);
    assert.ok(output.revert.event_count >= 2, "the edit after revert is recorded in the same session");
    assert.deepEqual(output.revert.events.at(-1) && { op: output.revert.events.at(-1).op, ins_len: output.revert.events.at(-1).ins_len }, { op: "insert", ins_len: 5 });
    for (let index = 1; index < output.revert.events.length; index += 1) {
      assert.ok(output.revert.events[index].t >= output.revert.events[index - 1].t);
    }
    assert.equal(JSON.stringify(output).includes("draft"), false);
    assert.equal(JSON.stringify(output).includes("again"), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Emacs producer persists a file buffer's session without text and resumes it when the file is reopened", { skip: emacs ? false : "emacs binary not available" }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pmbah-emacs-resume-"));
  const outputPath = join(temp, "resume.json");
  const scriptPath = join(temp, "resume.el");
  const documentPath = join(temp, "essay.txt");
  const stateDirectory = join(temp, "state/");
  const modePath = resolve("producers/emacs/pmbah-mode.el");
  await writeFile(documentPath, "");

  await writeFile(scriptPath, `;;; resume.el --- persist and resume a file buffer's session -*- lexical-binding: t; -*-
(require 'cl-lib)
(load ${JSON.stringify(modePath)})
(setq pmbah-observe-process nil)
(setq pmbah-state-directory ${JSON.stringify(stateDirectory)})
;; Saving must not append a final newline, which would be one more recorded edit.
(setq mode-require-final-newline nil)
(defun pmbah-test-kill-file-buffer ()
  (set-buffer-modified-p nil)
  (kill-buffer (current-buffer)))
(let ((first nil) (second nil) (after-sign nil) (after-discard nil))
  (with-current-buffer (find-file-noselect ${JSON.stringify(documentPath)})
    (text-mode)
    (pmbah-mode 1)
    (insert "Hello")
    (insert " world")
    (setq pmbah--observation-token "resume-token-0123456789abcdef0123456789")
    (let ((scan (pmbah--journal-helper (append (list :operation "inspect") (pmbah--chain-tip-payload)))))
      (setq pmbah--chain-tip (alist-get 'chain_tip scan)
            pmbah--chain-tip-event-count 2
            pmbah--chain-tip-byte-offset (alist-get 'byte_length scan)
            pmbah--chain-tip-last-time (alist-get 'last_t scan)))
    (pmbah--write-state)
    (let ((path (pmbah--state-file)))
      (setq first (list :session pmbah--session-id
                        :event_count pmbah--next-seq
                        :events (vconcat (pmbah--session-events))
                        :state_file path
                        :state_file_modes (logand (file-modes path) #o777)
                        :state_directory_modes (logand (file-modes (file-name-directory path)) #o777)
                        :state_json (pmbah--read-file path))))
    (let ((make-backup-files nil))
      (save-buffer))
    (pmbah-test-kill-file-buffer))
  (with-current-buffer (find-file-noselect ${JSON.stringify(documentPath)})
    (text-mode)
    (pmbah-mode 1)
    (let ((resumed-count pmbah--next-seq))
      (goto-char (point-max))
      (insert "!")
      (setq second (list :session pmbah--session-id
                         :resumed_count resumed-count
                         :event_count pmbah--next-seq
                         :events (vconcat (pmbah--session-events))
                         :token pmbah--observation-token
                         :observation_state (symbol-name pmbah--observation-state)
                         :chain_tip pmbah--chain-tip
                         :chain_tip_event_count pmbah--chain-tip-event-count
                         :elapsed_ms (pmbah--elapsed-ms))))
    (cl-letf (((symbol-function 'pmbah--post-record)
               (lambda (_body) (list :url "https://example.test/record" :short_signature "stub"))))
      (pmbah-sign-buffer (list :surface "emacs") t))
    (setq after-sign (list :state_file_exists (if (file-exists-p (pmbah--state-file)) t :json-false)
                           :session pmbah--session-id
                           :event_count pmbah--next-seq))
    (insert "?")
    (pmbah--write-state)
    (let ((existed (file-exists-p (pmbah--state-file))))
      (pmbah-discard-session)
      (setq after-discard (list :state_file_existed_before (if existed t :json-false)
                                :state_file_exists (if (file-exists-p (pmbah--state-file)) t :json-false))))
    (pmbah-test-kill-file-buffer))
  (with-temp-file ${JSON.stringify(outputPath)}
    (insert (pmbah--json-encode (list :first first :second second :after_sign after-sign :after_discard after-discard)))))
`);

  try {
    const result = await runEmacs(scriptPath);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    const { first, second } = output;

    assert.equal(first.event_count, 2);
    assert.equal(first.state_file_modes, 0o600, "the state file holds a bearer token");
    assert.equal(first.state_directory_modes, 0o700);
    assert.ok(first.state_file.startsWith(stateDirectory));
    assert.match(first.state_file, /\/[0-9a-f]{64}\.json$/);
    const state = JSON.parse(first.state_json);
    assert.equal(state.session_id, first.session);
    assert.equal(state.format_version, "0.3");
    assert.equal(typeof state.session_start_ms, "number");
    assert.equal(state.event_count, 2);
    assert.equal(state.events, undefined, "metadata never embeds the growing event log");
    assert.equal(state.observation.token, "resume-token-0123456789abcdef0123456789");
    assert.equal(state.chain_tip, computeEventHashChain(first.events, first.session, "0.3").at(-1));
    assert.equal(state.chain_tip_event_count, 2);
    for (const forbidden of ["Hello", "world", "essay", "text", "content"]) {
      assert.equal(first.state_json.includes(forbidden), false, `state file leaked ${forbidden}`);
    }

    assert.equal(second.session, first.session, "the same session resumes for the same file");
    assert.equal(second.resumed_count, 2);
    assert.equal(second.event_count, 3);
    assert.deepEqual(second.events.slice(0, 2), first.events);
    assert.equal(second.events[2].op, "insert");
    assert.equal(second.events[2].pos, null, "the first resumed mutation marks unobserved intervening edits");
    assert.ok(second.events[2].t >= second.events[1].t, "t stays monotonic across the resume");
    assert.ok(second.elapsed_ms >= second.events[2].t);
    assert.equal(second.token, "resume-token-0123456789abcdef0123456789");
    assert.equal(second.observation_state, "disabled");
    assert.equal(second.chain_tip, computeEventHashChain(first.events, first.session, "0.3").at(-1), "recovery verifies the cached hash against its journal prefix");
    assert.equal(second.chain_tip_event_count, 2);

    assert.equal(output.after_sign.state_file_exists, true, "the linked empty continuation remains recoverable");
    assert.notEqual(output.after_sign.session, first.session);
    assert.equal(output.after_sign.event_count, 0);
    assert.equal(output.after_discard.state_file_existed_before, true);
    assert.equal(output.after_discard.state_file_exists, false, "discard removes the state file");
    assert.equal(JSON.stringify(output).includes("Hello"), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Emacs file buffers open at the same time keep independent sessions", { skip: emacs ? false : "emacs binary not available" }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pmbah-emacs-two-buffers-"));
  const outputPath = join(temp, "two.json");
  const scriptPath = join(temp, "two.el");
  const modePath = resolve("producers/emacs/pmbah-mode.el");
  await writeFile(join(temp, "a.txt"), "");
  await writeFile(join(temp, "b.txt"), "");

  await writeFile(scriptPath, `;;; two.el --- two buffers, two sessions -*- lexical-binding: t; -*-
(load ${JSON.stringify(modePath)})
(setq pmbah-observe-process nil)
(setq pmbah-state-directory ${JSON.stringify(join(temp, "state/"))})
(defun pmbah-test-snapshot ()
  (list :session pmbah--session-id :event_count pmbah--next-seq :state_file (pmbah--state-file)))
(defun pmbah-test-kill-file-buffer ()
  (set-buffer-modified-p nil)
  (kill-buffer (current-buffer)))
(let ((a (find-file-noselect ${JSON.stringify(join(temp, "a.txt"))}))
      (b (find-file-noselect ${JSON.stringify(join(temp, "b.txt"))}))
      (output nil))
  (with-current-buffer a (pmbah-mode 1) (insert "a1") (insert "a2"))
  (with-current-buffer b (pmbah-mode 1) (insert "b1"))
  (with-current-buffer a (insert "a3"))
  (setq output (list :a (with-current-buffer a (pmbah-test-snapshot))
                     :b (with-current-buffer b (pmbah-test-snapshot))))
  ;; kill-buffer persists both; reopening resumes each one separately.
  (with-current-buffer a (pmbah-test-kill-file-buffer))
  (with-current-buffer b (pmbah-test-kill-file-buffer))
  (with-current-buffer (find-file-noselect ${JSON.stringify(join(temp, "b.txt"))})
    (pmbah-mode 1)
    (setq output (plist-put output :b_again (pmbah-test-snapshot)))
    (pmbah-test-kill-file-buffer))
  (with-current-buffer (find-file-noselect ${JSON.stringify(join(temp, "a.txt"))})
    (pmbah-mode 1)
    (setq output (plist-put output :a_again (pmbah-test-snapshot)))
    (pmbah-test-kill-file-buffer))
  (with-temp-file ${JSON.stringify(outputPath)}
    (insert (pmbah--json-encode output))))
`);

  try {
    const result = await runEmacs(scriptPath);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    assert.notEqual(output.a.session, output.b.session);
    assert.equal(output.a.event_count, 3);
    assert.equal(output.b.event_count, 1);
    assert.notEqual(output.a.state_file, output.b.state_file);
    assert.equal(output.a_again.session, output.a.session);
    assert.equal(output.a_again.event_count, 3);
    assert.equal(output.b_again.session, output.b.session);
    assert.equal(output.b_again.event_count, 1);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Emacs producer resumes and builds the same persisted session after a sixty-day pause", { skip: emacs ? false : "emacs binary not available" }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pmbah-emacs-time-bound-"));
  const outputPath = join(temp, "bound.json");
  const scriptPath = join(temp, "bound.el");
  const documentPath = join(temp, "old.txt");
  const modePath = resolve("producers/emacs/pmbah-mode.el");
  await writeFile(documentPath, "past");
  const pauseMs = 60 * 24 * 60 * 60 * 1000;
  const sixtyDaysAgoMs = Date.now() - pauseMs;

  await writeFile(scriptPath, `;;; bound.el --- a months-old session resumes with its original clock -*- lexical-binding: t; -*-
(load ${JSON.stringify(modePath)})
(setq pmbah-observe-process nil)
(setq pmbah-helper-script ${JSON.stringify(resolve("producers/emacs/scripts/build-record.mjs"))})
(setq pmbah-state-directory ${JSON.stringify(join(temp, "state/"))})
(with-current-buffer (find-file-noselect ${JSON.stringify(documentPath)})
  (let ((path (pmbah--state-file)))
    (make-directory (file-name-directory path) t)
    (with-temp-file path
      (insert (pmbah--json-encode
               (list :session_id "11111111-2222-4333-8444-555555555555"
                     :session_start_ms ${sixtyDaysAgoMs}
                     :format_version pmbah-format-version
                     :events [(:seq 0 :t 0 :op "insert" :pos 0 :del_len 0 :ins_len 4 :source "typing")]
                     :observation (list :token nil :committed_event_count 0 :commitments [])))))
    (pmbah-mode 1)
    (goto-char (point-max))
    (insert "new")
    (pmbah--write-state)
    (let ((output (list :session pmbah--session-id
                        :event_count pmbah--next-seq
                        :record (pmbah-build-record-for-current-buffer (list :surface "emacs"))
                        :first_t (plist-get (car (pmbah--session-events)) :t)
                        :state_file_exists (if (file-exists-p path) t :json-false)
                        :stale_file_exists (if (file-exists-p (concat path ".stale")) t :json-false))))
      (with-temp-file ${JSON.stringify(outputPath)}
        (insert (pmbah--json-encode output))))
    (set-buffer-modified-p nil)
    (kill-buffer (current-buffer))))
`);

  try {
    const result = await runEmacs(scriptPath);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(output.session, "11111111-2222-4333-8444-555555555555");
    assert.equal(output.event_count, 2);
    assert.equal(output.first_t, 0, "the existing history is unchanged");
    assert.equal(output.state_file_exists, true);
    assert.equal(output.stale_file_exists, false, "age alone must not retire a draft");
    assert.equal(output.record.manifest.session_id, output.session);
    assert.deepEqual(output.record.events[0], { seq: 0, t: 0, op: "insert", pos: 0, del_len: 0, ins_len: 4, source: "typing" });
    assert.ok(output.record.events[1].t >= pauseMs);
    assert.ok(output.record.events[1].t < pauseMs + 60_000);
    assert.ok(output.record.manifest.duration_ms >= output.record.events[1].t);
    assert.equal(verifyRecord(output.record).valid, true);
    assert.equal(JSON.stringify(output.record).includes("past"), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Emacs state file follows the buffer when the visited file is renamed", { skip: emacs ? false : "emacs binary not available" }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pmbah-emacs-rename-"));
  const outputPath = join(temp, "rename.json");
  const scriptPath = join(temp, "rename.el");
  const oldPath = join(temp, "draft-v1.txt");
  const newPath = join(temp, "draft-final.txt");
  const modePath = resolve("producers/emacs/pmbah-mode.el");
  await writeFile(oldPath, "");

  await writeFile(scriptPath, `;;; rename.el --- write-file moves the session state -*- lexical-binding: t; -*-
(load ${JSON.stringify(modePath)})
(setq pmbah-observe-process nil)
(setq pmbah-state-directory ${JSON.stringify(join(temp, "state/"))})
(setq mode-require-final-newline nil)
(let ((before nil) (after nil) (resumed nil))
  (with-current-buffer (find-file-noselect ${JSON.stringify(oldPath)})
    (text-mode)
    (pmbah-mode 1)
    (insert "Draft")
    (pmbah--write-state)
    (setq before (list :session pmbah--session-id :state_file (pmbah--state-file)))
    (let ((make-backup-files nil) (require-final-newline nil))
      (write-file ${JSON.stringify(newPath)}))
    (setq after (list :session pmbah--session-id
                      :state_file (pmbah--state-file)
                      :old_state_exists (if (file-exists-p (plist-get before :state_file)) t :json-false)
                      :new_state_exists (if (file-exists-p (pmbah--state-file)) t :json-false)))
    (set-buffer-modified-p nil)
    (kill-buffer (current-buffer)))
  (with-current-buffer (find-file-noselect ${JSON.stringify(newPath)})
    (text-mode)
    (pmbah-mode 1)
    (setq resumed (list :session pmbah--session-id :event_count pmbah--next-seq))
    (set-buffer-modified-p nil)
    (kill-buffer (current-buffer)))
  (with-temp-file ${JSON.stringify(outputPath)}
    (insert (pmbah--json-encode (list :before before :after after :resumed resumed)))))
`);

  try {
    const result = await runEmacs(scriptPath);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    assert.notEqual(output.after.state_file, output.before.state_file);
    assert.equal(output.after.session, output.before.session, "renaming the file keeps the session");
    assert.equal(output.after.old_state_exists, false, "the state file under the old name is gone");
    assert.equal(output.after.new_state_exists, true);
    assert.equal(output.resumed.session, output.before.session, "the renamed file resumes the session");
    assert.equal(output.resumed.event_count, 1);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Emacs signs a sixty-day session and a backward clock correction cannot reorder edits", { skip: emacs ? false : "emacs binary not available" }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pmbah-emacs-long-duration-"));
  const outputPath = join(temp, "duration.json");
  const scriptPath = join(temp, "duration.el");
  const documentPath = join(temp, "long.txt");
  const modePath = resolve("producers/emacs/pmbah-mode.el");
  await writeFile(documentPath, "");
  const pauseMs = 60 * 24 * 60 * 60 * 1000;
  const sixtyDaysAgoMs = Date.now() - pauseMs;

  await writeFile(scriptPath, `;;; duration.el --- long durations and backwards clocks remain signable -*- lexical-binding: t; -*-
(require 'cl-lib)
(load ${JSON.stringify(modePath)})
(setq pmbah-observe-process nil)
(setq pmbah-helper-script ${JSON.stringify(resolve("producers/emacs/scripts/build-record.mjs"))})
(setq pmbah-state-directory ${JSON.stringify(join(temp, "state/"))})
(with-current-buffer (find-file-noselect ${JSON.stringify(documentPath)})
  (text-mode)
  (pmbah-mode 1)
  (insert "Long ago")
  (let ((session pmbah--session-id)
        (path (pmbah--state-file))
        (uploaded nil))
    (setq pmbah--session-start-time (seconds-to-time (/ ${sixtyDaysAgoMs} 1000.0)))
    (insert " again")
    (pmbah--write-state)
    (let ((corrected-time (time-subtract (current-time) (seconds-to-time 3600))))
      (cl-letf (((symbol-function 'current-time) (lambda () corrected-time))
                ((symbol-function 'pmbah--post-record)
                 (lambda (body) (setq uploaded (pmbah-test-materialize body)) '((url . "https://example.test/saved")))))
        (insert "!")
        (pmbah-sign-buffer (list :surface "emacs") t)))
    (with-temp-file ${JSON.stringify(outputPath)}
      (insert (pmbah--json-encode
               (list :original_session session
                     :record uploaded
                     :same_session (if (equal session pmbah--session-id) t :json-false)
                     :state_file_exists (if (file-exists-p path) t :json-false)
                     :stale_file_exists (if (file-exists-p (concat path ".stale")) t :json-false)))))
    (set-buffer-modified-p nil)
    (kill-buffer (current-buffer))))
`);

  try {
    const result = await runEmacs(scriptPath);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(output.record.manifest.session_id, output.original_session);
    assert.equal(output.record.events.length, 3);
    assert.ok(output.record.events[1].t >= pauseMs);
    assert.ok(output.record.events[1].t < pauseMs + 60_000);
    assert.equal(output.record.events[2].t, output.record.events[1].t, "clock rollback clamps to the last edit time");
    assert.equal(output.record.manifest.duration_ms, output.record.events[2].t);
    assert.equal(verifyRecord(output.record).valid, true);
    assert.equal(output.same_session, false, "successful publication starts the next session");
    assert.equal(output.state_file_exists, true, "the linked empty continuation remains recoverable");
    assert.equal(output.stale_file_exists, false);
    assert.equal(JSON.stringify(output.record).includes("Long ago"), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Emacs checkpoint attempt times out against a server that never answers and later edits retry", { skip: emacs ? false : "emacs binary not available" }, async () => {
  const { createServer } = await import("node:http");
  const seen = [];
  const server = createServer((request) => { seen.push(request.url); });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address();

  const temp = await mkdtemp(join(tmpdir(), "pmbah-emacs-timeout-"));
  const outputPath = join(temp, "timeout.json");
  const scriptPath = join(temp, "timeout.el");
  const modePath = resolve("producers/emacs/pmbah-mode.el");

  await writeFile(scriptPath, `;;; timeout.el --- a checkpoint request that never completes -*- lexical-binding: t; -*-
(load ${JSON.stringify(modePath)})
(setq pmbah-observation-request-timeout-seconds 1)
(with-temp-buffer
  (text-mode)
  (pmbah-mode 1)
  (insert "Stuck")
  (let* ((started (float-time))
         (settled (pmbah--observation-wait 10))
         (waited (- (float-time) started))
         (after-timeout (pmbah--observation-status))
         (processes (mapcar #'process-name (process-list))))
    ;; The backoff is 1 s after one failure; wait it out, edit again, and the
    ;; attempt is re-kicked.
    (sleep-for 1.1)
    (insert "!")
    (let ((rekicked (pmbah--observation-status)))
      (with-temp-file ${JSON.stringify(outputPath)}
        (insert (pmbah--json-encode (list :settled (if settled t :json-false)
                                          :waited_seconds waited
                                          :after_timeout after-timeout
                                          :processes (vconcat processes)
                                          :rekicked rekicked)))))))
`);

  try {
    const result = await runEmacs(scriptPath, { PMBAH_API_BASE_URL: `http://127.0.0.1:${port}` });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(seen.length >= 1, true, "the server accepted the request");
    assert.equal(output.settled, true, "the wait ended because the attempt timed out");
    assert.ok(output.waited_seconds < 8, `waited ${output.waited_seconds}s`);
    assert.equal(output.after_timeout.in_flight, false);
    assert.equal(output.after_timeout.state, "unknown");
    assert.match(output.after_timeout.last_failure, /^transient .*no response/);
    assert.equal(output.processes.some((name) => /pmbah|127\.0\.0\.1/.test(name)), false, `abandoned request left processes: ${output.processes}`);
    assert.equal(output.rekicked.in_flight, true, "the next edit after the backoff re-kicks the checkpoint");
    assert.equal(JSON.stringify(output).includes("Stuck"), false);
  } finally {
    server.closeAllConnections();
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(temp, { recursive: true, force: true });
  }
});

test("Emacs observation state machine backs off on transient failures, pins conflicts, and resets when unavailable", { skip: emacs ? false : "emacs binary not available" }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pmbah-emacs-observation-states-"));
  const outputPath = join(temp, "states.json");
  const scriptPath = join(temp, "states.el");
  const modePath = resolve("producers/emacs/pmbah-mode.el");

  await writeFile(scriptPath, `;;; states.el --- checkpoint outcome handling without a server -*- lexical-binding: t; -*-
(load ${JSON.stringify(modePath)})
(defun pmbah-test-outcome (kind http-status payload)
  (setq pmbah--observation-in-flight t)
  (pmbah--observation-apply (list kind http-status payload))
  (list :state (symbol-name pmbah--observation-state)
        :backoff_ms pmbah--observation-backoff-ms
        :committed pmbah--observation-committed-count
        :token (or pmbah--observation-token :json-false)
        :commitments (length pmbah--observation-commitments)
        :in_flight (if pmbah--observation-in-flight t :json-false)))
(defun pmbah-test-ok-payload (event-count checkpoint-id chain-tip)
  (list (cons 'event_count event-count)
        (cons 'token "token-0123456789abcdef0123456789abcdef")
        (cons 'checkpoint_id checkpoint-id)
        (cons 'chain_tip chain-tip)
        (cons 'server_t "2026-01-01T00:00:00.000Z")))
(with-temp-buffer
  (text-mode)
  (pmbah-mode 1)
  ;; Three events, captured without triggering a real checkpoint.
  (let ((pmbah-observe-process nil))
    (insert "a")
    (insert "b")
    (insert "c"))
  (let* ((malformed-ok (pmbah-test-outcome 'ok 201 (list (cons 'event_count 1) (cons 'token "short"))))
         (transient-1 (pmbah-test-outcome 'transient 0 "connection refused"))
         (transient-2 (pmbah-test-outcome 'transient 503 "unavailable"))
         (transient-7 (progn (dotimes (_ 4) (pmbah-test-outcome 'rate_limited 429 "slow down"))
                             (pmbah-test-outcome 'transient 0 "still down")))
         (ok-1 (pmbah-test-outcome 'ok 201 (pmbah-test-ok-payload 1 "cp-1" "b3:00")))
         (ok-3 (pmbah-test-outcome 'ok 201 (pmbah-test-ok-payload 3 "cp-3" "b3:02")))
         (conflict (pmbah-test-outcome 'conflict 409 "checkpoint_stale"))
         (after-conflict-ok (pmbah-test-outcome 'ok 200 (pmbah-test-ok-payload 3 "cp-3" "b3:02")))
         (unavailable (pmbah-test-outcome 'unavailable 404 "observation_unavailable"))
         (output (list :malformed_ok malformed-ok
                       :transient_1 transient-1 :transient_2 transient-2 :transient_7 transient-7
                       :ok_1 ok-1 :ok_3 ok-3 :conflict conflict :after_conflict_ok after-conflict-ok
                       :unavailable unavailable
                       :envelope_after_reset (or (pmbah--observation-envelope) :json-false))))
    (with-temp-file ${JSON.stringify(outputPath)}
      (insert (pmbah--json-encode output)))))
`);

  try {
    const result = await runEmacs(scriptPath);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(output.malformed_ok.state, "unknown", "a malformed success body is a transient failure");
    assert.equal(output.malformed_ok.committed, 0);
    assert.equal(output.malformed_ok.token, false);
    assert.equal(output.malformed_ok.backoff_ms, 1000);
    assert.equal(output.malformed_ok.in_flight, false);
    assert.equal(output.transient_1.state, "unknown");
    assert.equal(output.transient_1.backoff_ms, 2000);
    assert.equal(output.transient_1.in_flight, false);
    assert.equal(output.transient_2.backoff_ms, 4000);
    assert.equal(output.transient_7.backoff_ms, 60000, "backoff is capped");
    assert.equal(output.ok_1.state, "partial");
    assert.equal(output.ok_1.backoff_ms, 0);
    assert.equal(output.ok_1.committed, 1);
    assert.equal(output.ok_1.commitments, 1);
    assert.equal(output.ok_3.state, "known");
    assert.equal(output.ok_3.committed, 3);
    assert.equal(output.ok_3.commitments, 2);
    assert.equal(output.conflict.state, "diverged");
    assert.equal(output.conflict.token, "token-0123456789abcdef0123456789abcdef");
    assert.equal(output.after_conflict_ok.state, "diverged", "a conflict pins the session");
    assert.equal(output.unavailable.state, "unknown");
    assert.equal(output.unavailable.token, false);
    assert.equal(output.unavailable.committed, 0);
    assert.equal(output.unavailable.commitments, 0);
    assert.deepEqual(output.envelope_after_reset, { state: "unobserved" });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Emacs classifies real HTTP error callbacks before connection errors", { skip: emacs ? false : "emacs binary not available" }, async () => {
  const { createServer } = await import("node:http");
  let status = 409;
  const server = createServer((_request, response) => {
    response.writeHead(status, { "content-type": "application/json", "connection": "close" });
    response.end(JSON.stringify({ error: status === 404 ? "observation_unavailable" : "checkpoint_rejected" }));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const temp = await mkdtemp(join(tmpdir(), "pmbah-emacs-http-errors-"));
  try {
    for (const [code, expected, reason] of [[409, "diverged", "conflict"], [400, "diverged", "client_bug"], [404, "unknown", "unavailable"], [429, "unknown", "rate_limited"]]) {
      status = code;
      const outputPath = join(temp, `${code}.json`);
      const scriptPath = join(temp, `${code}.el`);
      await writeFile(scriptPath, `(load ${JSON.stringify(resolve("producers/emacs/pmbah-mode.el"))})
(with-temp-buffer
  (pmbah-mode 1)
  (insert "HTTP test")
  (pmbah--observation-wait 10)
  (let ((result (pmbah--observation-status)))
    (with-temp-file ${JSON.stringify(outputPath)}
      (insert (pmbah--json-encode result)))))
`);
      const result = await runEmacs(scriptPath, { PMBAH_API_BASE_URL: `http://127.0.0.1:${server.address().port}` });
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(await readFile(outputPath, "utf8"));
      assert.equal(output.state, expected, `HTTP ${code}`);
      assert.match(output.last_failure, new RegExp(`^${reason} .*HTTP ${code}`));
      assert.equal(output.in_flight, false);
    }
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await rm(temp, { recursive: true, force: true });
  }
});

test("Emacs persists diverged state and reason immediately and preserves it on reopen", { skip: emacs ? false : "emacs binary not available" }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pmbah-emacs-diverged-resume-"));
  const scriptPath = join(temp, "scenario.el");
  const documentPath = join(temp, "document.txt");
  const outputPath = join(temp, "result.json");
  await writeFile(documentPath, "");
  await writeFile(scriptPath, `(load ${JSON.stringify(resolve("producers/emacs/pmbah-mode.el"))})
(setq pmbah-observe-process nil pmbah-state-directory ${JSON.stringify(join(temp, "state/"))})
(let ((saved nil) (restored nil))
  (with-current-buffer (find-file-noselect ${JSON.stringify(documentPath)})
    (pmbah-mode 1)
    (insert "Local test")
    (setq pmbah-observe-process t
          pmbah--observation-token "persisted-token"
          pmbah--observation-committed-count 1)
    (pmbah--observation-apply (list 'conflict 409 "checkpoint_stale"))
    (setq saved (plist-get (pmbah--read-state (pmbah--state-file)) :observation))
    (set-buffer-modified-p nil)
    (kill-buffer (current-buffer)))
  (with-current-buffer (find-file-noselect ${JSON.stringify(documentPath)})
    (pmbah-mode 1)
    (setq restored (list :status (pmbah--observation-status) :envelope (pmbah--observation-envelope))))
  (with-temp-file ${JSON.stringify(outputPath)}
    (insert (pmbah--json-encode (list :saved saved :restored restored)))))
`);
  try {
    const result = await runEmacs(scriptPath);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(output.saved.state, "diverged");
    assert.match(output.saved.last_failure, /checkpoint_stale/);
    assert.equal(output.restored.status.state, "diverged");
    assert.equal(output.restored.envelope.state, "unobserved");
    assert.equal(JSON.stringify(output).includes("Local test"), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Emacs freezes before network and recovers identical file and non-file uploads after restart", { skip: emacs ? false : "emacs binary not available" }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pmbah-emacs-frozen-"));
  const stateDir = join(temp, "state");
  const documentPath = join(temp, "draft.txt");
  const firstPath = join(temp, "first.json");
  const secondPath = join(temp, "second.json");
  const scriptPath = join(temp, "scenario.el");
  const setup = `(load ${JSON.stringify(resolve("producers/emacs/pmbah-mode.el"))})
(setq pmbah-observe-process nil pmbah-state-directory ${JSON.stringify(stateDir)})`;
  await writeFile(documentPath, "");
  await writeFile(scriptPath, `;;; frozen.el -*- lexical-binding: t; -*-
${setup}
(let (results)
  (dolist (variant '((t "0.3") (nil "0.3") (nil "0.2") (nil "0.1")))
    (let ((file (car variant)) (version (cadr variant)))
    (with-current-buffer (if file (find-file-noselect ${JSON.stringify(documentPath)}) (generate-new-buffer "scratch-recovery"))
      (pmbah-mode 1)
      (insert "PRIVATE-FROZEN-CANARY")
      (unless (equal version "0.3")
        (setq pmbah--session-format version
              pmbah--frozen-record
              (pmbah--json-encode (pmbah-build-record-for-current-buffer (list :surface "emacs")
                                   (unless (equal version "0.1") "PRIVATE-FROZEN-CANARY")))))
      (let (sent frozen-before-flush blocked)
        (cl-letf (((symbol-function 'pmbah--observation-flush)
                   (lambda ()
                     (setq frozen-before-flush
                           (stringp (plist-get (pmbah--read-state (pmbah--state-file)) :frozen_record)))
                     (sleep-for 0.04)))
                  ((symbol-function 'pmbah--post-record)
                   (lambda (body) (setq sent (pmbah-test-materialize body)) (error "lost response"))))
          (condition-case nil (pmbah-sign-buffer (list :surface "emacs") t) (error nil)))
        (setq blocked t)
        (dotimes (_ 3)
          (unless (condition-case nil (progn (insert "forbidden") nil) (buffer-read-only t))
            (setq blocked nil)))
        (unless (and (memq #'pmbah--before-change before-change-functions)
                     (memq #'pmbah--after-change after-change-functions))
          (setq blocked nil))
        (let ((inhibit-read-only t)) (insert "private override"))
        (unless (= pmbah--next-seq 1) (error "frozen events changed"))
        (push (list :file (if file t :json-false) :path (pmbah--state-file)
                    :sent sent :version version :frozen_before_flush (if frozen-before-flush t :json-false)
                    :blocked (if blocked t :json-false)) results))
      (set-buffer-modified-p nil)
      (kill-buffer (current-buffer)))))
  (with-temp-file ${JSON.stringify(firstPath)} (insert (pmbah--json-encode (vconcat results)))))
`);
  try {
    let result = await runEmacs(scriptPath);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const first = JSON.parse(await readFile(firstPath, "utf8"));
    for (const attempt of first) {
      assert.equal(attempt.frozen_before_flush, true);
      assert.equal(attempt.blocked, true);
      assert.equal(attempt.sent.manifest.format_version, attempt.version);
      assert.equal(verifyRecord(attempt.sent).valid, true);
      assert.equal((await readFile(attempt.path, "utf8")).includes("PRIVATE-FROZEN-CANARY"), false);
    }
    await writeFile(scriptPath, `;;; retry.el -*- lexical-binding: t; -*-
${setup}
(let (results)
  (dolist (item (pmbah--read-state ${JSON.stringify(firstPath)}))
    (with-current-buffer (if (eq (plist-get item :file) t)
                            (find-file-noselect ${JSON.stringify(documentPath)})
                          (generate-new-buffer "recovered-scratch"))
      (if buffer-file-name (pmbah-mode 1) (pmbah-recover-session (plist-get item :path)))
      (let (sent)
        (dotimes (_ 3)
          (condition-case nil (progn (insert "forbidden") (error "recovered frozen buffer was writable"))
            (buffer-read-only nil)))
        (cl-letf (((symbol-function 'pmbah--run-helper) (lambda (_) (error "must not rebuild")))
                  ((symbol-function 'pmbah--observation-flush) (lambda () (error "must not reflush")))
                  ((symbol-function 'pmbah--post-record)
                   (lambda (body) (setq sent (pmbah-test-materialize body)) (list (cons 'url "https://example.test/recovered")))))
          (pmbah-sign-buffer nil t))
        (push sent results))
      (set-buffer-modified-p nil)
      (kill-buffer (current-buffer))))
  (with-temp-file ${JSON.stringify(secondPath)} (insert (pmbah--json-encode (vconcat (nreverse results))))))
`);
    result = await runEmacs(scriptPath);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(await readFile(secondPath, "utf8")), first.map((entry) => entry.sent));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Emacs blocks upload on storage failure and preserves accepted links when saving fails", { skip: emacs ? false : "emacs binary not available" }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pmbah-emacs-save-failure-"));
  const scriptPath = join(temp, "scenario.el");
  const outputPath = join(temp, "out.json");
  await writeFile(scriptPath, `;;; storage.el -*- lexical-binding: t; -*-
(load ${JSON.stringify(resolve("producers/emacs/pmbah-mode.el"))})
(setq pmbah-observe-process nil)
(let ((posts 0) (flushes 0) failure accepted-error)
  (with-temp-buffer
    (pmbah-mode 1)
    (insert "PRIVATE-STORAGE-CANARY")
    (cl-letf (((symbol-function 'pmbah--write-json-file) (lambda (&rest _) (error "disk full")))
              ((symbol-function 'pmbah--observation-flush) (lambda () (cl-incf flushes)))
              ((symbol-function 'pmbah--post-record) (lambda (_) (cl-incf posts))))
      (setq failure (condition-case err (pmbah-sign-buffer nil t) (error (error-message-string err)))))
  (let ((posts-before posts) (flushes-before flushes))
    (with-temp-buffer
      (pmbah-mode 1)
      (insert "accepted")
      (let ((write-json (symbol-function 'pmbah--write-json-file)))
        (cl-letf (((symbol-function 'pmbah--write-json-file)
                   (lambda (path json)
                     (if (string-match-p "published-" path) (error "archive full") (funcall write-json path json))))
                  ((symbol-function 'pmbah--post-record)
                   (lambda (_) (cl-incf posts) (list (cons 'url "https://example.test/accepted")))))
          (setq accepted-error (condition-case err (pmbah-sign-buffer nil t) (error (error-message-string err))))))
      (let ((saved (pmbah--read-state (pmbah--state-file))))
        (pmbah--start-session)
        (pmbah--resume-session saved))
      (cl-letf (((symbol-function 'pmbah--post-record) (lambda (_) (error "must not upload again"))))
        (pmbah-sign-buffer nil t)))
    (with-temp-file ${JSON.stringify(outputPath)}
      (insert (pmbah--json-encode (list :posts_before posts-before :flushes_before flushes-before
                                      :posts posts :failure failure :accepted_error accepted-error)))))))
`);
  try {
    const result = await runEmacs(scriptPath);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(output.posts_before, 0);
    assert.equal(output.flushes_before, 0);
    assert.equal(output.posts, 1);
    assert.match(output.failure, /disk full/);
    assert.match(output.accepted_error, /https:\/\/example.test\/accepted/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Emacs helper seals finish time without rewriting historical formats or checkpoint prefixes", () => {
  const base = { session_id: "00000000-0000-4000-8000-000000000044", duration_ms: 300,
    events: [{ seq: 0, t: 100, op: "insert", pos: 0, del_len: 0, ins_len: 4, source: "typing" }] };
  const build = (format_version, extra = {}) => {
    const result = spawnSync(process.execPath, [resolve("producers/emacs/scripts/build-record.mjs")], {
      input: JSON.stringify({ ...base, format_version, ...extra }), encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).record;
  };
  const modern = build("0.3", { final_text: "word" });
  assert.equal(modern.manifest.format_version, "0.3");
  assert.equal(verifyRecord(modern).valid, true);
  const tampered = structuredClone(modern);
  tampered.manifest.duration_ms += 1;
  assert.equal(verifyRecord(tampered).valid, false);
  const legacy = build("0.2", { final_text: "word" });
  assert.equal(legacy.manifest.format_version, "0.2");
  assert.equal(verifyRecord(legacy).valid, true);
  assert.deepEqual(computeEventHashChain(base.events, base.session_id, "0.2"), computeEventHashChain(base.events, base.session_id, "0.3"));
  const old = build("0.1");
  old.manifest.duration_ms += 1;
  assert.equal(verifyRecord(old).valid, true, "historical finalization bytes are unchanged");
});

test("Emacs links and persists the next segment at the prior signed finish", { skip: emacs ? false : "emacs binary not available" }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pmbah-emacs-linked-"));
  const scriptPath = join(temp, "scenario.el");
  const outputPath = join(temp, "out.json");
  const documentPath = join(temp, "draft.txt");
  await writeFile(documentPath, "");
  await writeFile(scriptPath, `;;; linked.el -*- lexical-binding: t; -*-
(load ${JSON.stringify(resolve("producers/emacs/pmbah-mode.el"))})
(setq pmbah-observe-process nil)
(let (parent child start-ms child-state)
  (with-current-buffer (find-file-noselect ${JSON.stringify(documentPath)})
    (pmbah-mode 1)
    (setq pmbah--session-start-time (time-subtract (current-time) (seconds-to-time 10))
          start-ms (pmbah--time-to-ms pmbah--session-start-time))
    (insert "PARENT-CANARY")
    (cl-letf (((symbol-function 'pmbah--post-record)
               (lambda (body) (setq parent (pmbah-test-materialize body)) '((url . "https://example.test/parent")))))
      (pmbah-sign-buffer (list :surface "emacs") t))
    (setq child-state (pmbah--read-state (pmbah--state-file)))
    (set-buffer-modified-p nil)
    (kill-buffer (current-buffer)))
  (with-current-buffer (find-file-noselect ${JSON.stringify(documentPath)})
    (pmbah-mode 1)
    (insert "child")
    (setq child (pmbah-build-record-for-current-buffer (list :surface "emacs")))
    (set-buffer-modified-p nil)
    (kill-buffer (current-buffer)))
  (with-temp-file ${JSON.stringify(outputPath)}
    (insert (pmbah--json-encode (list :parent parent :child child :start_ms start-ms :child_state child-state)))))
`);
  try {
    const result = await runEmacs(scriptPath);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(verifyRecord(output.child).valid, true);
    assert.equal(output.child.manifest.parent_record, output.parent.manifest.record_hash);
    assert.equal(output.child_state.parent_record, output.parent.manifest.record_hash);
    assert.equal(output.child_state.session_start_ms, output.start_ms + output.parent.manifest.duration_ms);
    assert.equal((output.child_state.events ?? []).length, 0);
    assert.equal(output.child.events.length, 1);
    assert.equal(output.child.events[0].pos, null);
    assert.equal(Date.parse(output.parent.manifest.created_client_t), output.start_ms);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Emacs drops only a rejected observation envelope and keeps the frozen record on retry", { skip: emacs ? false : "emacs binary not available" }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pmbah-emacs-rejected-"));
  const scriptPath = join(temp, "scenario.el");
  const outputPath = join(temp, "out.json");
  await writeFile(scriptPath, `;;; rejected.el -*- lexical-binding: t; -*-
(load ${JSON.stringify(resolve("producers/emacs/pmbah-mode.el"))})
(setq pmbah-observe-process nil)
(with-temp-buffer
  (pmbah-mode 1)
  (insert "BOUND-CANARY")
  (let (before after failure)
    (let ((helper (symbol-function 'pmbah--journal-helper)))
      (cl-letf (((symbol-function 'pmbah--journal-helper)
                 (lambda (payload)
                   (if (equal (alist-get 'operation payload) "publish")
                       (progn (setq before (pmbah-test-materialize payload))
                              '((error . ((code . "observation_mismatch") (message . "rejected")))))
                     (funcall helper payload)))))
        (setq failure (condition-case err (pmbah-sign-buffer (list :surface "emacs") t)
                        (user-error (error-message-string err))))))
    (let ((saved (pmbah--read-state (pmbah--state-file))))
      (pmbah--start-session)
      (pmbah--resume-session saved))
    (cl-letf (((symbol-function 'pmbah--post-record)
               (lambda (body) (setq after (pmbah-test-materialize body)) '((url . "https://example.test/retried")))))
      (pmbah-sign-buffer nil t))
    (with-temp-file ${JSON.stringify(outputPath)}
      (insert (pmbah--json-encode (list :before before :after after :failure failure))))))
`);
  try {
    const result = await runEmacs(scriptPath);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    assert.deepEqual(output.after.manifest, output.before.manifest);
    assert.deepEqual(output.after.events, output.before.events);
    assert.deepEqual(output.after.observation, { state: "unobserved" });
    assert.match(output.failure, /observation_mismatch/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Emacs preserves unrelated recovery state when a visited file is renamed onto it", { skip: emacs ? false : "emacs binary not available" }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pmbah-emacs-rename-conflict-"));
  const scriptPath = join(temp, "scenario.el");
  const outputPath = join(temp, "out.json");
  const first = join(temp, "first.txt"), second = join(temp, "second.txt");
  await Promise.all([writeFile(first, ""), writeFile(second, "")]);
  await writeFile(scriptPath, `;;; rename-conflict.el -*- lexical-binding: t; -*-
(load ${JSON.stringify(resolve("producers/emacs/pmbah-mode.el"))})
(setq pmbah-observe-process nil)
(let (target before old after)
  (with-current-buffer (find-file-noselect ${JSON.stringify(second)})
    (pmbah-mode 1) (insert "target") (pmbah--write-state)
    (setq target (pmbah--state-file) before (pmbah--read-file target))
    (set-buffer-modified-p nil) (kill-buffer (current-buffer)))
  (with-current-buffer (find-file-noselect ${JSON.stringify(first)})
    (pmbah-mode 1) (insert "source") (pmbah--write-state)
    (setq old (pmbah--state-file))
    (set-visited-file-name ${JSON.stringify(second)} t)
    (insert "new edit") (pmbah--write-state)
    (pmbah-discard-session)
    (insert "after discard") (pmbah--write-state)
    (cl-letf (((symbol-function 'pmbah--post-record)
               (lambda (_) '((url . "https://example.test/renamed")))))
      (pmbah-sign-buffer (list :surface "emacs") t))
    (insert "linked child") (insert " second edit") (pmbah--write-state)
    (setq after (pmbah--state-file))
    (set-buffer-modified-p nil) (kill-buffer (current-buffer)))
  (with-temp-file ${JSON.stringify(outputPath)}
    (insert (pmbah--json-encode (list :target_preserved (if (equal before (pmbah--read-file target)) t :json-false)
                                    :old old :after after :events (plist-get (pmbah--read-state old) :event_count))))))
`);
  try {
    const result = await runEmacs(scriptPath);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(output.target_preserved, true);
    assert.equal(output.old, output.after);
    assert.equal(output.events, 2);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Emacs retains exclusive session ownership while capture is off and releases it on buffer close", { skip: emacs ? false : "emacs binary not available" }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pmbah-emacs-owner-"));
  const scriptPath = join(temp, "scenario.el");
  const outputPath = join(temp, "out.json");
  await writeFile(scriptPath, `;;; owners.el -*- lexical-binding: t; -*-
(load ${JSON.stringify(resolve("producers/emacs/pmbah-mode.el"))})
(setq pmbah-observe-process nil)
(let ((owner (generate-new-buffer "owner")) path blocked recovered)
  (with-current-buffer owner
    (pmbah-mode 1) (insert "owned") (pmbah-mode -1)
    (setq path (pmbah--state-file)))
  (with-temp-buffer
    (setq blocked (condition-case err (progn (pmbah-recover-session path) nil)
                    (user-error (error-message-string err)))))
  (kill-buffer owner)
  (with-temp-buffer
    (pmbah-recover-session path)
    (setq recovered pmbah--next-seq))
  (with-temp-file ${JSON.stringify(outputPath)}
    (insert (pmbah--json-encode (list :blocked blocked :recovered recovered)))))
`);
  try {
    const result = await runEmacs(scriptPath);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    assert.match(output.blocked, /already owned/);
    assert.equal(output.recovered, 1);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Emacs recovery locks reject a second process without stealing ownership", { skip: emacs ? false : "emacs binary not available" }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pmbah-emacs-process-lock-"));
  const documentPath = join(temp, "draft.txt");
  const holderPath = join(temp, "holder.el");
  const contenderPath = join(temp, "contender.el");
  const readyPath = join(temp, "ready");
  const releasePath = join(temp, "release");
  const setup = `(load ${JSON.stringify(resolve("producers/emacs/pmbah-mode.el"))})
(setq pmbah-observe-process nil pmbah-state-directory ${JSON.stringify(join(temp, "state"))})`;
  await writeFile(documentPath, "");
  await writeFile(holderPath, `;;; holder.el -*- lexical-binding: t; -*-
${setup}
(with-current-buffer (find-file-noselect ${JSON.stringify(documentPath)})
  (pmbah-mode 1) (insert "first owner") (pmbah-mode -1)
  (with-temp-file ${JSON.stringify(readyPath)} (insert "ready"))
  (while (not (file-exists-p ${JSON.stringify(releasePath)})) (sleep-for 0.02))
  (set-buffer-modified-p nil) (kill-buffer (current-buffer)))
`);
  await writeFile(contenderPath, `;;; contender.el -*- lexical-binding: t; -*-
${setup}
(with-current-buffer (find-file-noselect ${JSON.stringify(documentPath)})
  (condition-case err (progn (pmbah-mode 1) (princ "acquired"))
    (user-error (princ (error-message-string err)))))
`);
  const holder = spawn(emacs, ["--batch", "-Q", "-l", holderPath], { stdio: ["ignore", "ignore", "pipe"] });
  let holderErrors = "";
  holder.stderr.on("data", (chunk) => { holderErrors += chunk; });
  const finished = new Promise((resolveExit) => holder.on("close", resolveExit));
  try {
    let ready = false;
    for (let count = 0; count < 200; count += 1) {
      try { ready = (await readFile(readyPath, "utf8")) === "ready"; } catch {}
      if (ready) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    assert.equal(ready, true, holderErrors);
    const blocked = await runEmacs(contenderPath);
    assert.equal(blocked.status, 0, blocked.stderr);
    assert.match(blocked.stdout, /already owned by another Emacs process/);
    await writeFile(releasePath, "release");
    assert.equal(await finished, 0, holderErrors);
    const acquired = await runEmacs(contenderPath);
    assert.equal(acquired.status, 0, acquired.stderr);
    assert.equal(acquired.stdout, "acquired");
  } finally {
    if (holder.exitCode === null) holder.kill("SIGKILL");
    await finished;
    await rm(temp, { recursive: true, force: true });
  }
});

test("Emacs restores the writer's original read-only setting when leaving a frozen session", { skip: emacs ? false : "emacs binary not available" }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pmbah-emacs-readonly-"));
  const scriptPath = join(temp, "scenario.el");
  await writeFile(scriptPath, `;;; readonly.el -*- lexical-binding: t; -*-
(load ${JSON.stringify(resolve("producers/emacs/pmbah-mode.el"))})
(setq pmbah-observe-process nil)
(dolist (original '(nil t))
  (with-temp-buffer
    (pmbah-mode 1) (insert "draft") (setq buffer-read-only original)
    (cl-letf (((symbol-function 'pmbah--post-record) (lambda (_) (error "offline"))))
      (condition-case nil (pmbah-sign-buffer (list :surface "emacs") t) (error nil)))
    (unless buffer-read-only (error "frozen buffer not locked"))
    (pmbah-mode -1)
    (unless (eq buffer-read-only original) (error "original setting not restored on disable"))
    (pmbah-mode 1)
    (unless buffer-read-only (error "frozen buffer not locked on reenable"))
    (pmbah-discard-session)
    (unless (eq buffer-read-only original) (error "original setting not restored on discard"))))
(princ "preserved")
`);
  try {
    const result = await runEmacs(scriptPath);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout, "preserved");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Emacs saves every mutation and pauses safely when durable recovery fails", { skip: emacs ? false : "emacs binary not available" }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pmbah-emacs-durable-capture-"));
  const scriptPath = join(temp, "scenario.el");
  const outputPath = join(temp, "out.json");
  await writeFile(scriptPath, `;;; durable-capture.el -*- lexical-binding: t; -*-
(load ${JSON.stringify(resolve("producers/emacs/pmbah-mode.el"))})
(setq pmbah-observe-process nil)
(with-temp-buffer
  (pmbah-mode 1)
  (let (counts paused status blocked hooks retained retry-count frozen)
    (dotimes (_ 3)
      (insert "PRIVATE-DURABILITY-CANARY")
      (push (plist-get (pmbah--read-state (pmbah--state-file)) :event_count) counts))
    (cl-letf (((symbol-function 'pmbah--write-json-file) (lambda (&rest _) (error "disk full"))))
      (insert "unsaved"))
    (setq paused (if (and pmbah--save-failure buffer-read-only) t :json-false)
          status (pmbah-show-session-status)
          retained pmbah--next-seq
          blocked 0)
    (dotimes (_ 3)
      (condition-case nil (insert "must not append") (buffer-read-only (cl-incf blocked))))
    (setq hooks (if (and (memq #'pmbah--before-change before-change-functions)
                         (memq #'pmbah--after-change after-change-functions)) t :json-false))
    (pmbah-retry-save)
    (when (or buffer-read-only pmbah--save-failure) (error "capture did not resume"))
    (setq retry-count (plist-get (pmbah--read-state (pmbah--state-file)) :event_count))
    (insert "resumed")
    (cl-letf (((symbol-function 'pmbah--post-record) (lambda (_) (error "offline"))))
      (condition-case nil (pmbah-sign-buffer (list :surface "emacs") t) (error nil)))
    (setq frozen pmbah--frozen-record)
    (pmbah-retry-save)
    (unless (and buffer-read-only (equal frozen pmbah--frozen-record)) (error "save retry unfroze upload"))
    (let ((state (pmbah--read-file (pmbah--state-file))))
      (with-temp-file ${JSON.stringify(outputPath)}
        (insert (pmbah--json-encode (list :counts (vconcat (nreverse counts)) :paused paused
                                        :status status :retained retained :blocked blocked :hooks hooks
                                        :retry_count retry-count :state state)))))))
`);
  try {
    const result = await runEmacs(scriptPath);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    assert.deepEqual(output.counts, [1, 2, 3]);
    assert.equal(output.paused, true);
    assert.match(output.status, /Recovery save failed; recording paused: disk full/);
    assert.equal(output.retained, 4);
    assert.equal(output.blocked, 3);
    assert.equal(output.hooks, true);
    assert.equal(output.retry_count, 4);
    assert.equal(output.state.includes("PRIVATE-DURABILITY-CANARY"), false);
    assert.equal(output.state.includes("unsaved"), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
