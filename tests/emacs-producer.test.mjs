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
function runEmacs(scriptPath, env = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(emacs, ["--batch", "-Q", "-l", scriptPath], {
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
    const result = await runEmacs(scriptPath);
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
(load ${JSON.stringify(modePath)})
(setq pmbah-helper-script ${JSON.stringify(helperPath)})
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
                         :status_after_sign status-after-sign)))
      (with-temp-file ${JSON.stringify(outputPath)}
        (insert (pmbah--json-encode output))))))
`);

  try {
    const result = await runEmacs(scriptPath, { PMBAH_API_BASE_URL: `http://127.0.0.1:${port}` });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    assert.match(output.response.short_signature, /^[1-9A-HJ-NP-Za-km-z]+$/);

    const fetched = await api.getRecord(output.response.short_signature);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.manifest.producer.id, "emacs");
    assert.equal(fetched.body.manifest.format_version, "0.2");
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
  (let* ((transient-1 (pmbah-test-outcome 'transient 0 "connection refused"))
         (transient-2 (pmbah-test-outcome 'transient 503 "unavailable"))
         (transient-7 (progn (dotimes (_ 5) (pmbah-test-outcome 'rate_limited 429 "slow down"))
                             (pmbah-test-outcome 'transient 0 "still down")))
         (ok-1 (pmbah-test-outcome 'ok 201 (pmbah-test-ok-payload 1 "cp-1" "b3:00")))
         (ok-3 (pmbah-test-outcome 'ok 201 (pmbah-test-ok-payload 3 "cp-3" "b3:02")))
         (conflict (pmbah-test-outcome 'conflict 409 "checkpoint_stale"))
         (after-conflict-ok (pmbah-test-outcome 'ok 200 (pmbah-test-ok-payload 3 "cp-3" "b3:02")))
         (unavailable (pmbah-test-outcome 'unavailable 404 "observation_unavailable"))
         (output (list :transient_1 transient-1 :transient_2 transient-2 :transient_7 transient-7
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
    assert.equal(output.transient_1.state, "unknown");
    assert.equal(output.transient_1.backoff_ms, 1000);
    assert.equal(output.transient_1.in_flight, false);
    assert.equal(output.transient_2.backoff_ms, 2000);
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
