import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

import { computeObservedLength, verifyRecord } from "../packages/format/src/index.ts";
import { createIngestApi } from "../apps/ingest-api/src/index.ts";
import { createRuntimeServer } from "../apps/ingest-api/src/server.ts";
import { InMemoryRecordStore } from "../packages/storage/src/index.ts";

const emacs = spawnSync("sh", ["-c", "command -v emacs"], { encoding: "utf8" }).stdout.trim();
const options = { skip: emacs ? false : "emacs binary not available" };
const modePath = resolve("producers/emacs/pmbah-mode.el");

// Emacs runs asynchronously so an ingest API served from this process can answer it.
async function runEmacs(temp, program, env = {}) {
  const script = join(temp, "scenario.el");
  const stateDirectory = join(temp, "state");
  await writeFile(script, `;;; continuation.el -*- lexical-binding: t; -*-
(require 'cl-lib)
(load ${JSON.stringify(modePath)})
(setq pmbah-state-directory ${JSON.stringify(stateDirectory)}
      pmbah-auto-resume nil)
(defvar pmbah-test-messages nil)
(advice-add 'message :before
            (lambda (format &rest args)
              (when format (push (apply #'format-message format args) pmbah-test-messages))))
(defun pmbah-test-output (value)
  (with-temp-file ${JSON.stringify(join(temp, "output.json"))}
    (insert (pmbah--json-encode value))))
${program}`);
  const result = await new Promise((resolveRun, rejectRun) => {
    const child = spawn(emacs, ["--batch", "-Q", "-l", script], {
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
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return { output: JSON.parse(await readFile(join(temp, "output.json"), "utf8")), stderr: result.stderr, stateDirectory };
}

async function ingestServer(t) {
  const store = new InMemoryRecordStore();
  const api = createIngestApi({ store, baseUrl: "http://pmbah.test" });
  const server = createRuntimeServer({ api, db: { async query() { return { rows: [] }; } } });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolveClose) => server.close(resolveClose)); });
  return { api, env: { PMBAH_API_BASE_URL: `http://127.0.0.1:${server.address().port}` } };
}

async function temporaryDirectory(t, prefix) {
  const temp = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(temp, { recursive: true, force: true }));
  return temp;
}

async function publishedRecord(api, response) {
  const fetched = await api.getRecord(response.short_signature);
  assert.equal(fetched.status, 200);
  const record = { manifest: fetched.body.manifest, events: fetched.body.events };
  const verification = verifyRecord(record);
  assert.equal(verification.valid, true, verification.errors.join("; "));
  return { record, observation: fetched.body.observation, stats: fetched.body.stats };
}

// Replays event shapes from a known starting length, as a continuation that
// claims the parent's final text does, and checks every position against it.
function lengthFrom(start, events) {
  let length = start;
  for (const event of events) {
    assert.equal(typeof event.pos, "number", `event ${event.seq} has a known position`);
    assert.ok(event.pos + event.del_len <= length, `event ${event.seq} lies within the text`);
    length = length - event.del_len + event.ins_len;
  }
  return length;
}

const continuesAtParentFinish = (parent, child) =>
  assert.equal(Date.parse(child.manifest.created_client_t),
    Date.parse(parent.manifest.created_client_t) + parent.manifest.duration_ms);

test("Emacs continues a live-signed buffer from the parent's final text without a gap", options, async (t) => {
  const { api, env } = await ingestServer(t);
  const temp = await temporaryDirectory(t, "pmbah-emacs-continuation-");
  const documentPath = join(temp, "essay.txt");
  await writeFile(documentPath, "");
  const { output } = await runEmacs(temp, `
(with-current-buffer (find-file-noselect ${JSON.stringify(documentPath)})
  (pmbah-mode 1)
  (insert "Hello brave world")
  (goto-char 7)
  (delete-char 6)
  (let ((parent-response (pmbah-sign-buffer t))
        parent-length child-response)
    (setq parent-length (buffer-size))
    (goto-char 7)
    (insert "new ")
    (goto-char (point-max))
    (insert "!")
    (setq child-response (pmbah-sign-buffer t))
    (pmbah-test-output (list :parent parent-response :child child-response
                             :parent_length parent-length :final_length (buffer-size)
                             :exact_ms (format-time-string "%3N" (pmbah--ms-to-time 1790000000123) t)
                             :round_trip (pmbah--time-to-ms (pmbah--ms-to-time 1790000000123))))
    (set-buffer-modified-p nil)))`, env);

  assert.equal(output.exact_ms, "123", "continuation start times keep exact milliseconds");
  assert.equal(output.round_trip, 1790000000123);
  const parent = (await publishedRecord(api, output.parent)).record;
  const published = await publishedRecord(api, output.child);
  const child = published.record;
  assert.equal(child.manifest.parent_record, parent.manifest.record_hash);
  assert.equal(computeObservedLength(parent.events), output.parent_length);
  // The service starts the child from the parent's length and knows its final length.
  assert.equal(published.stats.starting_length, output.parent_length);
  assert.equal(published.stats.observed_final_length, output.final_length);
  assert.equal(typeof child.events[0].pos, "number");
  assert.ok(child.events[0].pos <= output.parent_length);
  assert.equal(lengthFrom(output.parent_length, child.events), output.final_length);
  continuesAtParentFinish(parent, child);
});

test("Emacs keeps a continuation gap unless this process froze the unchanged buffer", options, async (t) => {
  const temp = await temporaryDirectory(t, "pmbah-emacs-continuation-gap-");
  const paths = Object.fromEntries(["retry", "modified", "restart", "emptied", "paused"].map((name) => [name, join(temp, `${name}.txt`)]));
  await Promise.all(Object.values(paths).map((path) => writeFile(path, "")));
  const { output } = await runEmacs(temp, `
(defvar pmbah-test-upload nil "Called with no arguments during the upload.")
(defvar pmbah-test-fail nil "Non-nil makes the next upload fail.")
(defun pmbah-test-post (descriptor)
  (when pmbah-test-upload (funcall pmbah-test-upload))
  (when pmbah-test-fail (setq pmbah-test-fail nil) (user-error "Network unavailable"))
  (let ((hash (alist-get 'record_hash (alist-get 'manifest descriptor))))
    (list (cons 'record_hash hash) (cons 'url (concat "https://example.test/" (substring hash 3 11))))))
(defun pmbah-test-first-pos (path setup)
  "Sign PATH once after SETUP ran against the frozen buffer, then report the next edit."
  (let ((buffer (find-file-noselect path)) parent)
    (with-current-buffer buffer
      (pmbah-mode 1)
      (insert "Some words")
      (setq buffer (funcall setup buffer))
      (with-current-buffer buffer
        (setq parent pmbah--parent-record)
        (goto-char (point-max))
        (insert ".")
        (prog1 (list :parent (if parent t :json-false)
                     :pos (plist-get (car pmbah--events) :pos))
          (set-buffer-modified-p nil))))))
(defun pmbah-test-reopen (path save)
  "Return a setup that fails one upload, reopens PATH from disk, and retries it.
With SAVE the file on disk holds the frozen text; otherwise it stays empty."
  (lambda (buffer)
    (when save (save-buffer))
    (setq pmbah-test-fail t)
    (condition-case nil (pmbah-sign-buffer t) (user-error nil))
    (set-buffer-modified-p nil)
    (kill-buffer buffer)
    (with-current-buffer (find-file-noselect path)
      (pmbah-mode 1)
      (unless pmbah--frozen-record (error "The frozen record was not recovered"))
      (pmbah-sign-buffer t)
      (current-buffer))))
(cl-letf (((symbol-function 'pmbah--post-record) #'pmbah-test-post))
  (pmbah-test-output
   (list
    :retry (pmbah-test-first-pos ${JSON.stringify(paths.retry)}
             (lambda (buffer)
               (setq pmbah-test-fail t)
               (condition-case nil (pmbah-sign-buffer t) (user-error nil))
               (pmbah-sign-buffer t)
               buffer))
    :modified (pmbah-test-first-pos ${JSON.stringify(paths.modified)}
                (lambda (buffer)
                  (let ((pmbah-test-upload
                         (lambda () (let ((inhibit-read-only t)) (goto-char (point-min)) (insert "unrecorded ")))))
                    (pmbah-sign-buffer t))
                  buffer))
    :restart (pmbah-test-first-pos ${JSON.stringify(paths.restart)} (pmbah-test-reopen ${JSON.stringify(paths.restart)} t))
    :emptied (pmbah-test-first-pos ${JSON.stringify(paths.emptied)} (pmbah-test-reopen ${JSON.stringify(paths.emptied)} nil))
    :paused (pmbah-test-first-pos ${JSON.stringify(paths.paused)}
              (lambda (buffer)
                (setq pmbah-test-fail t)
                (condition-case nil (pmbah-sign-buffer t) (user-error nil))
                (pmbah-mode -1)
                (pmbah-mode 1)
                (pmbah-sign-buffer t)
                buffer)))))`);

  for (const name of ["retry", "modified", "restart", "emptied", "paused"]) assert.equal(output[name].parent, true, name);
  assert.equal(output.retry.pos, 10, "a retried upload from the same unchanged freeze still continues exactly");
  assert.equal(output.modified.pos, null, "a change made while frozen breaks continuity");
  assert.equal(output.restart.pos, null, "a record recovered from disk cannot vouch for the buffer text");
  assert.equal(output.emptied.pos, null, "an empty buffer does not claim the parent's text either");
  assert.equal(output.paused.pos, null, "pausing capture while frozen breaks continuity");
});

const copyProgram = (source, target, extra) => `
(defvar pmbah-test-prompts nil)
(defvar pmbah-test-answer t)
(defun pmbah-test-copy (target)
  (cl-letf (((symbol-function 'y-or-n-p)
             (lambda (prompt) (push prompt pmbah-test-prompts) pmbah-test-answer))
            ((symbol-function 'read-file-name)
             (lambda (&rest _) target)))
    (condition-case error (pmbah-copy-file)
      (user-error (list :error (error-message-string error))))))
${extra}`;

test("pmbah-copy-file publishes first, then records the original and the copy as separate continuations", options, async (t) => {
  const { api, env } = await ingestServer(t);
  const temp = await temporaryDirectory(t, "pmbah-emacs-copy-");
  const sourcePath = join(temp, "draft.txt");
  const copyPath = join(temp, "copy.txt");
  const secondCopyPath = join(temp, "second.txt");
  await writeFile(sourcePath, "");
  const { output, stateDirectory } = await runEmacs(temp, copyProgram(sourcePath, copyPath, `
(let ((source (find-file-noselect ${JSON.stringify(sourcePath)}))
      copy second copy-prompts second-prompts copy-message)
  (with-current-buffer source
    (pmbah-mode 1)
    (insert "Shared opening. ")
    (setq copy (pmbah-test-copy ${JSON.stringify(copyPath)})
          copy-prompts pmbah-test-prompts
          copy-message (vconcat pmbah-test-messages)
          pmbah-test-prompts nil)
    ;; The original is still an exact, empty continuation: copying needs no publication.
    (setq second (pmbah-test-copy ${JSON.stringify(secondCopyPath)})
          second-prompts pmbah-test-prompts))
  (let ((describe
         (lambda (buffer)
           (with-current-buffer buffer
             (list :session pmbah--session-id :parent pmbah--parent-record
                   :start_ms (pmbah--time-to-ms pmbah--session-start-time)
                   :observed pmbah--observation-session-id
                   :state_path (pmbah--state-file) :enabled (if pmbah-mode t :json-false)
                   :file buffer-file-name :count pmbah--next-seq))))
        before)
    (setq before (list :source (funcall describe source) :copy (funcall describe copy)
                       :second (funcall describe second)))
    (with-current-buffer source (goto-char (point-max)) (insert "Original ending."))
    (with-current-buffer copy (goto-char (point-min)) (insert "Copy: "))
    (dolist (buffer (list source copy))
      (with-current-buffer buffer
        (unless (and (pmbah--observation-wait 10) pmbah--observation-token)
          (error "The first checkpoint of %s was not observed" (buffer-name)))))
    (let ((after (list :source (funcall describe source) :copy (funcall describe copy)))
          (first-events (list :source (with-current-buffer source (car pmbah--events))
                              :copy (with-current-buffer copy (car pmbah--events))))
          (source-response (with-current-buffer source (pmbah-sign-buffer t)))
          (copy-response (with-current-buffer copy (pmbah-sign-buffer t))))
      (pmbah-test-output (list :before before :after after :first_events first-events
                               :copy_prompts (vconcat copy-prompts) :second_prompts (vconcat second-prompts)
                               :copy_message copy-message
                               :source_response source-response :copy_response copy-response)))
    (dolist (buffer (list source copy second))
      (with-current-buffer buffer (set-buffer-modified-p nil)))))`), env);

  const { before, after } = output;
  assert.deepEqual(output.copy_prompts, ["Publish the recorded history before copying? A published record is permanent. "]);
  assert.deepEqual(output.second_prompts, []);
  assert.equal(await readFile(copyPath, "utf8"), "Shared opening. ");
  assert.equal(await readFile(secondCopyPath, "utf8"), "Shared opening. ");
  assert.match(before.source.parent, /^b3:[0-9a-f]{64}$/);
  const sessions = new Set([before.source.session, before.copy.session, before.second.session]);
  assert.equal(sessions.size, 3, "each buffer records its own session");
  for (const name of ["copy", "second"]) {
    const described = before[name];
    assert.equal(described.parent, before.source.parent);
    assert.equal(described.start_ms, before.source.start_ms);
    assert.equal(described.enabled, true);
    assert.equal(described.count, 0);
    assert.equal(described.observed, described.session, "each copy has its own server observation");
    const truename = await realpath(described.file);
    assert.equal(described.state_path, join(stateDirectory, `${createHash("sha256").update(truename).digest("hex")}.json`));
    assert.equal((await stat(described.state_path)).isFile(), true);
  }
  assert.equal(after.source.count, 1);
  assert.equal(after.copy.count, 1, "edits in one buffer do not reach the other");
  assert.equal(output.first_events.source.pos, 16);
  assert.equal(output.first_events.copy.pos, 0);
  assert.ok(output.copy_message.some((line) => /now record separately as continuations of http:\/\/pmbah\.test\//.test(line)), output.copy_message.join("\n"));

  const parentHash = before.source.parent;
  const source = await publishedRecord(api, output.source_response);
  const copy = await publishedRecord(api, output.copy_response);
  for (const published of [source, copy]) {
    assert.equal(published.record.manifest.parent_record, parentHash);
    assert.equal(lengthFrom(16, published.record.events), 16 + published.record.events[0].ins_len);
    assert.equal(published.stats.starting_length, 16, "the service starts each copy from the parent's length");
    assert.equal(published.stats.observed_final_length, 16 + published.record.events[0].ins_len);
    assert.equal(published.observation.observed_session_id, published.record.manifest.session_id);
  }
  assert.equal(source.record.manifest.created_client_t, copy.record.manifest.created_client_t);
  assert.notEqual(source.record.manifest.session_id, copy.record.manifest.session_id);
});

test("pmbah-copy-file refuses without creating files or publishing", options, async (t) => {
  const temp = await temporaryDirectory(t, "pmbah-emacs-copy-refusals-");
  const sourcePath = join(temp, "draft.txt");
  const existingPath = join(temp, "existing.txt");
  const targetPath = join(temp, "target.txt");
  await writeFile(sourcePath, "");
  await writeFile(existingPath, "EXISTING");
  const { output } = await runEmacs(temp, copyProgram(sourcePath, targetPath, `
(cl-letf (((symbol-function 'pmbah--post-record) (lambda (_) (error "unexpected upload"))))
  (let (result)
    (with-temp-buffer
      (pmbah-mode 1)
      (insert "unnamed")
      (push (cons 'unnamed (pmbah-test-copy ${JSON.stringify(targetPath)})) result))
    (with-current-buffer (find-file-noselect ${JSON.stringify(sourcePath)})
      (insert "unrecorded")
      (push (cons 'disabled (pmbah-test-copy ${JSON.stringify(targetPath)})) result)
      (pmbah-mode 1)
      (push (cons 'unpublished (pmbah-test-copy ${JSON.stringify(targetPath)})) result)
      (insert " and recorded")
      (let ((pmbah-test-answer nil))
        (push (cons 'declined (pmbah-test-copy ${JSON.stringify(targetPath)})) result))
      (push (cons 'existing (pmbah-test-copy ${JSON.stringify(existingPath)})) result)
      (let ((state (with-current-buffer (find-file-noselect ${JSON.stringify(targetPath)})
                     (prog1 (pmbah--preferred-state-file) (kill-buffer)))))
        (pmbah--write-json-file state "{}")
        (push (cons 'state (pmbah-test-copy ${JSON.stringify(targetPath)})) result))
      (push (cons 'count pmbah--next-seq) result)
      (push (cons 'frozen (if pmbah--frozen-record t :json-false)) result)
      (push (cons 'writable (if buffer-read-only :json-false t)) result)
      (set-buffer-modified-p nil))
    (pmbah-test-output result)))`));

  assert.match(output.unnamed.error, /visiting a file/);
  assert.match(output.disabled.error, /pmbah-mode/);
  assert.match(output.unpublished.error, /published record/);
  assert.match(output.declined.error, /only continue a published record/);
  assert.match(output.existing.error, /already exists/);
  assert.match(output.state.error, /recovery state/);
  assert.equal(output.count, 1, "refusals leave the recorded history unsigned");
  assert.equal(output.frozen, false);
  assert.equal(output.writable, true);
  assert.equal(await readFile(existingPath, "utf8"), "EXISTING");
  await assert.rejects(stat(targetPath), { code: "ENOENT" });
});

async function publishHelper(temp, outcome) {
  const helper = join(temp, "publish-helper.mjs");
  await writeFile(helper, `import { runJournalOperation } from ${JSON.stringify(resolve("producers/emacs/scripts/event-journal.mjs"))};
let raw = ""; for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw);
if (input.operation !== "publish") { process.stdout.write(JSON.stringify(await runJournalOperation(input))); }
else {
  await new Promise((resolve) => setTimeout(resolve, 300));
  process.stdout.write(JSON.stringify(${outcome === "accepted"
    ? `{ record_hash: input.manifest.record_hash, short_signature: "async", url: "https://example.test/async", created: true }`
    : `{ error: { code: "server_error", message: "upload refused" } }`}));
}`);
  return helper;
}

for (const outcome of ["accepted", "failed"]) {
  test(`pmbah-copy-file waits for an interactive ${outcome} upload before copying`, options, async (t) => {
    const temp = await temporaryDirectory(t, "pmbah-emacs-copy-async-");
    const sourcePath = join(temp, "draft.txt");
    const targetPath = join(temp, "copy.txt");
    await writeFile(sourcePath, "");
    const helper = await publishHelper(temp, outcome);
    const { output } = await runEmacs(temp, copyProgram(sourcePath, targetPath, `
(setq pmbah-observe-process nil)
(with-current-buffer (find-file-noselect ${JSON.stringify(sourcePath)})
  (pmbah-mode 1)
  (insert "async text")
  (setq-local pmbah-helper-script ${JSON.stringify(helper)})
  (let (copied-early job-started final-message)
    (cl-letf (((symbol-function 'y-or-n-p) (lambda (_) t))
              ((symbol-function 'pmbah--y-or-n-p-default-yes) (lambda (_) nil))
              ((symbol-function 'read-file-name) (lambda (&rest _) ${JSON.stringify(targetPath)})))
      (let ((noninteractive nil))
        (call-interactively #'pmbah-copy-file)))
    (setq copied-early (file-exists-p ${JSON.stringify(targetPath)})
          job-started (if pmbah--sign-job t :json-false))
    (let ((deadline (+ (float-time) 10)))
      (while (and pmbah--sign-job (< (float-time) deadline)) (accept-process-output nil 0.02)))
    (setq final-message (vconcat pmbah-test-messages))
    (let ((copy (get-file-buffer ${JSON.stringify(targetPath)})))
      (pmbah-test-output
       (list :copied_early (if copied-early t :json-false) :job_started job-started
             :job_finished (if pmbah--sign-job :json-false t)
             :copied (if (file-exists-p ${JSON.stringify(targetPath)}) t :json-false)
             :message final-message
             :source_parent pmbah--parent-record
             :copy_parent (and copy (with-current-buffer copy pmbah--parent-record))
             :copy_gap (and copy (with-current-buffer copy (if pmbah--pending-gap t :json-false))))))
    (set-buffer-modified-p nil)))`));

    assert.equal(output.copied_early, false, "the copy waits for publication");
    assert.equal(output.job_started, true);
    assert.equal(output.job_finished, true);
    if (outcome === "accepted") {
      assert.equal(output.copied, true);
      assert.match(output.source_parent, /^b3:[0-9a-f]{64}$/);
      assert.equal(output.copy_parent, output.source_parent);
      assert.equal(output.copy_gap, false);
      assert.ok(output.message.some((line) => /now record separately as continuations of https:\/\/example\.test\/async/.test(line)), output.message.join("\n"));
    } else {
      assert.equal(output.copied, false);
      assert.equal(output.source_parent, null);
      assert.ok(output.message.some((line) => /upload refused.*copy was not made/.test(line)), output.message.join("\n"));
    }
  });
}
