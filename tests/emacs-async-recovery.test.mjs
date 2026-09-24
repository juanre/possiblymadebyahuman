import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const emacs = spawnSync("sh", ["-c", "command -v emacs"], { encoding: "utf8" }).stdout.trim();
const nativeOptions = { skip: emacs ? false : "emacs binary not available" };
const lisp = JSON.stringify;

async function fixture(program) {
  const directory = await mkdtemp(join(tmpdir(), "pmbah-emacs-async-recovery-"));
  try {
    const helper = join(directory, "gated-helper.mjs");
    await writeFile(helper, `import { runJournalOperation } from ${JSON.stringify(resolve("producers/emacs/scripts/event-journal.mjs"))};
import { existsSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
let raw = ""; for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw);
if (input.operation === "inspect") {
  const name = basename(input.journal_path), root = ${JSON.stringify(directory)};
  writeFileSync(join(root, name + ".started"), "ready");
  const deadline = Date.now() + 10000;
  while (!existsSync(join(root, name + ".release"))) {
    if (Date.now() > deadline) throw new Error("Test never released the recovery gate");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
process.stdout.write(JSON.stringify(await runJournalOperation(input)));`);
    const script = join(directory, "async-recovery.el");
    await writeFile(script, `;;; async-recovery.el -*- lexical-binding: t; -*-
(setq pmbah-state-directory ${lisp(join(directory, "state"))})
(load ${lisp(resolve("producers/emacs/pmbah-mode.el"))})
(setq pmbah-observe-process nil)
(defvar async-fixture-root ${lisp(directory)})
(defvar async-fixture-helper ${lisp(helper)})
(defun async-check (condition message) (unless condition (error "%s" message)))
(defun async-wait (predicate)
  (let ((deadline (+ (float-time) 12)))
    (while (and (not (funcall predicate)) (< (float-time) deadline)) (accept-process-output nil 0.02))
    (async-check (funcall predicate) "Timed out waiting for recovery state")))
(defun async-await ()
  (async-wait (lambda () (not pmbah--recovery-job))))
(defun async-close () (set-buffer-modified-p nil) (kill-buffer (current-buffer)))
(defun async-gate-path (seed suffix)
  (expand-file-name (concat (file-name-nondirectory (plist-get seed :journal)) suffix) async-fixture-root))
(defun async-started (seed)
  (async-wait (lambda () (file-exists-p (async-gate-path seed ".started")))))
(defun async-release (seed)
  (with-temp-file (async-gate-path seed ".release") (insert "released")))
(defun async-seed (name &optional freeze)
  (let ((file (expand-file-name name async-fixture-root)) seed)
    (with-temp-file file)
    (with-current-buffer (find-file-noselect file)
      (pmbah-mode 1) (insert "private writing")
      (let ((require-final-newline nil)) (save-buffer))
      (when freeze
        (cl-letf (((symbol-function 'pmbah--post-record) (lambda (&rest _) (error "offline fixture"))))
          (condition-case nil (pmbah-sign-buffer (list :surface "emacs") t) (error nil))))
      (setq seed (list :file file :session pmbah--session-id :metadata (pmbah--state-file)
                       :journal (pmbah--journal-file) :frozen pmbah--frozen-record))
      (async-close))
    seed))
${program}
(princ "async-recovery-ok")
`);
    const result = spawnSync(emacs, ["--batch", "-Q", "-l", script], {
      encoding: "utf8", timeout: 35_000, maxBuffer: 1_000_000,
      env: { ...process.env, PMBAH_API_BASE_URL: "http://127.0.0.1:9" },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
    assert.match(result.stdout, /async-recovery-ok/);
    assert.doesNotMatch(result.stderr, /close cancelled/, "recovery must not strand helper buffers");
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("Emacs automatic recovery returns before verification and independent files stay responsive", nativeOptions, async () => {
  await fixture(`(let ((first (async-seed "first.txt")) (second (async-seed "second.txt")) a b timer-fired)
  (setq pmbah-helper-script async-fixture-helper)
  (setq a (find-file-noselect (plist-get first :file)) b (find-file-noselect (plist-get second :file)))
  (dolist (buffer (list a b))
    (with-current-buffer buffer
      (async-check (and pmbah--recovery-job buffer-read-only (not pmbah--session-id)) "opening waited for verification or exposed unverified capture")
      (condition-case nil (progn (insert "must fail") (error "recovery accepted an edit")) (buffer-read-only nil))))
  (run-with-timer 0 nil (lambda () (setq timer-fired t)))
  (with-temp-buffer (insert "other work") (async-check (= (buffer-size) 10) "other buffers were not editable"))
  (async-started first) (async-started second)
  (async-check timer-fired "event loop did not run during verification")
  (with-temp-buffer
    (let (blocked)
      (condition-case nil (pmbah-recover-session (plist-get first :metadata)) (user-error (setq blocked t)))
      (async-check (and blocked (not pmbah--session-id) (not pmbah--owned-paths)) "another buffer acquired a recovering session")))
  (async-release second)
  (with-current-buffer b
    (async-await)
    (async-check (and pmbah-mode (not buffer-read-only) (equal pmbah--session-id (plist-get second :session)) (= pmbah--next-seq 1)) "second file did not recover independently")
    (insert "continued") (async-check (= pmbah--next-seq 2) "second file did not capture"))
  (with-current-buffer a (async-check (and pmbah--recovery-job buffer-read-only) "second recovery incorrectly completed the first"))
  (async-release first)
  (with-current-buffer a
    (async-await)
    (async-check (and pmbah-mode (equal pmbah--session-id (plist-get first :session)) (= pmbah--next-seq 1)) "first file lost its own history")
    (async-close))
  (with-current-buffer b (async-close)))`);
});

test("Emacs closing a recovering buffer cancels its helper and stale callbacks cannot affect a later recovery", nativeOptions, async () => {
  await fixture(`(let* ((seed (async-seed "close.txt")) (saved (pmbah--read-file (plist-get seed :metadata))) old old-token old-process fresh fresh-token)
  (setq pmbah-helper-script async-fixture-helper)
  (setq old (find-file-noselect (plist-get seed :file)))
  (async-started seed)
  (with-current-buffer old
    (setq old-token (plist-get pmbah--recovery-job :token) old-process (plist-get pmbah--recovery-job :process))
    (async-check (async-close) "closing recovery was vetoed"))
  (async-check (and (not (buffer-live-p old)) (not (process-live-p old-process))) "closing left recovery work running")
  (async-check (and (not (file-locked-p (plist-get seed :metadata))) (not (file-locked-p (plist-get seed :journal)))) "closing left recovery ownership")
  (async-check (equal saved (pmbah--read-file (plist-get seed :metadata))) "closing rewrote saved history")
  (setq fresh (find-file-noselect (plist-get seed :file)))
  (with-current-buffer fresh (setq fresh-token (plist-get pmbah--recovery-job :token)))
  (pmbah--recovery-result old old-token 'inspect nil "late cancelled callback")
  (with-current-buffer fresh
    (async-check (and (equal fresh-token (plist-get pmbah--recovery-job :token)) buffer-read-only (not pmbah--recovery-error)) "late callback damaged a fresh recovery"))
  (async-release seed)
  (with-current-buffer fresh
    (async-await)
    (async-check (and pmbah-mode (equal pmbah--session-id (plist-get seed :session))) "reopening after cancellation lost the session")
    (async-close)))`);
});

test("Emacs refuses pause, discard and signing while recovery is pending without damaging the job", nativeOptions, async () => {
  await fixture(`(let ((seed (async-seed "pause.txt")) token)
  (setq pmbah-helper-script async-fixture-helper)
  (with-current-buffer (find-file-noselect (plist-get seed :file))
    (async-started seed) (setq token (plist-get pmbah--recovery-job :token))
    (dolist (command (list (lambda () (pmbah-mode -1)) #'pmbah-discard-session
                           (lambda () (pmbah-sign-buffer (list :surface "emacs") t))))
      (let (refused)
        (condition-case nil (funcall command) (user-error (setq refused t)))
        (async-check refused "unfinished recovery accepted a conflicting action")
        (async-check (and buffer-read-only (equal token (plist-get pmbah--recovery-job :token))) "refused action damaged pending recovery")))
    (async-check (eq (plist-get (pmbah--read-state (plist-get seed :metadata)) :capture_enabled) t) "refused pause changed saved capture intent")
    (async-release seed) (async-await)
    (pmbah-mode -1)
    (async-check (and (not pmbah-mode) (not buffer-read-only)) "verified session could not be paused")
    (async-check (eq (plist-get (pmbah--read-state (plist-get seed :metadata)) :capture_enabled) :json-false) "verified pause was not durable")
    (pmbah--recovery-result (current-buffer) token 'inspect nil "late callback")
    (async-check (and (not pmbah--recovery-error) (not buffer-read-only)) "stale result undid the pause")
    (insert "private edit") (async-close))
  (with-current-buffer (find-file-noselect (plist-get seed :file))
    (async-await)
    (async-check (and (not pmbah-mode) (not pmbah--recovery-job) (not buffer-read-only)) "paused recovery restarted on reopen")
    (async-close)))`);
});

test("Emacs major-mode changes and reverts preserve protection while recovery is pending", nativeOptions, async () => {
  await fixture(`(let ((seed (async-seed "revert.txt")) token)
  (setq pmbah-helper-script async-fixture-helper)
  (with-current-buffer (find-file-noselect (plist-get seed :file))
    (async-started seed) (setq token (plist-get pmbah--recovery-job :token))
    (text-mode)
    (async-check (and buffer-read-only (equal token (plist-get pmbah--recovery-job :token))) "major-mode change lost recovery protection")
    (with-temp-file (plist-get seed :file) (insert "external edit"))
    (revert-buffer t t)
    (async-check (and buffer-read-only (equal token (plist-get pmbah--recovery-job :token))) "revert lost recovery protection")
    (async-release seed) (async-await)
    (async-check (and pmbah-mode (not buffer-read-only) (= pmbah--next-seq 1) (equal (buffer-string) "external edit")) "recovery captured loaded text or lost reverted text")
    (goto-char (point-max)) (insert "next edit")
    (async-check (null (plist-get (car pmbah--events) :pos)) "recovery claimed uninterrupted capture across revert")
    (async-close)))`);
});

test("Emacs failed async metadata commit leaves recovery retryable with original bytes and no ownership", nativeOptions, async () => {
  for (const failure of ["error", "quit"]) {
    await fixture(`(let* ((seed (async-seed "commit-failure.txt")) (saved (pmbah--read-file (plist-get seed :metadata)))
       (journal (pmbah--read-file (plist-get seed :journal))))
  (setq pmbah-helper-script async-fixture-helper)
  (with-current-buffer (find-file-noselect (plist-get seed :file))
    (async-started seed)
    (cl-letf (((symbol-function 'pmbah--write-json-file) (lambda (&rest _) (signal '${failure} ${failure === "quit" ? "nil" : "'(\"commit unavailable\")"}))))
      (async-release seed) (async-await))
    (async-check (and (not pmbah-mode) (not pmbah--session-id) (not pmbah--owned-paths) pmbah--recovery-error buffer-read-only) "failed commit exposed partial recovery")
    (async-check (and (equal saved (pmbah--read-file (plist-get seed :metadata))) (equal journal (pmbah--read-file (plist-get seed :journal)))) "failed commit changed acknowledged history")
    (pmbah-mode 1)
    (async-check (and pmbah-mode (not buffer-read-only) (equal pmbah--session-id (plist-get seed :session))) "commit failure could not be retried")
    (async-close)))`);
  }
});

test("Emacs async frozen recovery stays read-only after verification and never publishes automatically", nativeOptions, async () => {
  await fixture(`(let ((seed (async-seed "frozen.txt" t)))
  (async-check (plist-get seed :frozen) "fixture did not create a frozen record")
  (setq pmbah-helper-script async-fixture-helper)
  (cl-letf (((symbol-function 'pmbah--post-record) (lambda (&rest _) (error "automatic recovery must not publish"))))
    (with-current-buffer (find-file-noselect (plist-get seed :file))
      (async-started seed)
      (async-check buffer-read-only "unverified frozen file was editable")
      (async-release seed) (async-await)
      (async-check (and pmbah-mode buffer-read-only (equal pmbah--frozen-record (plist-get seed :frozen))) "verified frozen record lost its lock or changed")
      (condition-case nil (progn (insert "must fail") (error "verified frozen buffer accepted edits")) (buffer-read-only nil))
      (async-close))))`);
});

test("Emacs follows a filename change made while background verification is pending", nativeOptions, async () => {
  await fixture(`(let* ((seed (async-seed "rename-source.txt")) (target (expand-file-name "rename-target.txt" async-fixture-root))
       new-path token)
  (setq pmbah-helper-script async-fixture-helper)
  (with-current-buffer (find-file-noselect (plist-get seed :file))
    (async-started seed) (setq token (plist-get pmbah--recovery-job :token))
    (set-visited-file-name target t)
    (setq new-path (pmbah--preferred-state-file))
    (async-check (and buffer-read-only (equal token (plist-get pmbah--recovery-job :token))) "rename abandoned protected recovery")
    (async-check (file-exists-p (plist-get seed :metadata)) "rename moved unverified metadata")
    (async-release seed) (async-await)
    (async-check (and pmbah-mode (equal pmbah--session-id (plist-get seed :session)) (equal new-path (pmbah--state-file))) "verified recovery did not follow renamed file")
    (async-check (and (file-exists-p new-path) (not (file-exists-p (plist-get seed :metadata)))) "verified rename left the old association")
    (let ((require-final-newline nil)) (save-buffer)) (async-close))
  (with-current-buffer (find-file-noselect target)
    (async-await)
    (async-check (and pmbah-mode (equal pmbah--session-id (plist-get seed :session))) "renamed file did not resume the recovered session")
    (async-close)))`);
});

test("Emacs repeated async helper startup failures release all helper resources and leave recovery retryable", nativeOptions, async () => {
  await fixture(`(let* ((seed (async-seed "startup.txt")) (saved (pmbah--read-file (plist-get seed :metadata)))
       (buffers (buffer-list)) (processes (process-list)))
  (dotimes (_ 3)
    (let ((pmbah-node-command "/pmbah-test-missing-node"))
      (with-current-buffer (find-file-noselect (plist-get seed :file))
        (async-await)
        (async-check (and pmbah--recovery-error buffer-read-only (not pmbah--session-id) (not pmbah--owned-paths)) "startup failure exposed or owned a partial session")
        (async-close)))
    (async-check (not (cl-set-difference (process-list) processes)) "failed startup leaked a helper process")
    (async-check (not (cl-find-if (lambda (buffer) (string-match-p "pmbah-node" (buffer-name buffer)))
                                  (cl-set-difference (buffer-list) buffers))) "failed startup leaked helper buffers"))
  (async-check (equal saved (pmbah--read-file (plist-get seed :metadata))) "startup failures modified saved history")
  (with-current-buffer (find-file-noselect (plist-get seed :file))
    (async-await)
    (async-check (and pmbah-mode (not buffer-read-only) (equal pmbah--session-id (plist-get seed :session))) "startup failure prevented recovery after repair")
    (async-close)))`);
});

test("Emacs retains the inspection worker when metadata callbacks complete inline during startup", nativeOptions, async () => {
  await fixture(`(let* ((seed (async-seed "inline-callback.txt"))
       (metadata-process (make-pipe-process :name "fixture-metadata" :noquery t))
       (inspect-process (make-pipe-process :name "fixture-inspect" :noquery t)))
  (unwind-protect
      (cl-letf (((symbol-function 'pmbah--run-node-script-async)
                 (lambda (_script payload callback)
                   (if (equal (plist-get payload :operation) "read-recovery")
                       (progn (funcall callback (pmbah--parse-public-json (pmbah--read-file (plist-get seed :metadata))) nil)
                              metadata-process)
                     inspect-process))))
        (with-current-buffer (find-file-noselect (plist-get seed :file))
          (async-check (and pmbah--recovery-job (eq (plist-get pmbah--recovery-job :stage) 'inspect)
                            (eq (plist-get pmbah--recovery-job :process) inspect-process)) "metadata startup replaced the active inspection process")
          (async-close)
          (async-check (not (process-live-p inspect-process)) "close failed to cancel the active inspection process")))
    (when (process-live-p metadata-process) (delete-process metadata-process))
    (when (process-live-p inspect-process) (delete-process inspect-process))))`);
});

test("Emacs migrates legacy arrays in the recovery worker before installing the verified session", nativeOptions, async () => {
  await fixture(`(let* ((seed (async-seed "legacy.txt"))
       (journal (pmbah--read-file (plist-get seed :journal)))
       (event (json-parse-string (string-trim journal) :object-type 'plist :array-type 'list))
       (state (pmbah--read-state (plist-get seed :metadata))))
  (setq state (plist-put state :storage_version 1))
  (setq state (plist-put state :events (vector event)))
  (pmbah--write-json-file (plist-get seed :metadata) (pmbah--json-encode state))
  (delete-file (plist-get seed :journal))
  (setq pmbah-helper-script async-fixture-helper)
  (with-current-buffer (find-file-noselect (plist-get seed :file))
    (async-started seed)
    (async-check (and buffer-read-only (not pmbah--events) (not pmbah--session-id)
                      (not (plist-member (plist-get pmbah--recovery-job :state) :events))) "legacy array entered unverified live state")
    (async-check (= (plist-get (pmbah--read-state (plist-get seed :metadata)) :storage_version) 1) "legacy metadata was replaced before verification")
    (async-release seed) (async-await)
    (async-check (and pmbah-mode (equal pmbah--session-id (plist-get seed :session)) (= pmbah--next-seq 1)) "legacy recovery lost its history")
    (async-check (equal journal (pmbah--read-file (plist-get seed :journal))) "legacy migration changed numeric events")
    (async-check (= (plist-get (pmbah--read-state (plist-get seed :metadata)) :storage_version) 2) "legacy metadata was not upgraded")
    (async-check (not (file-exists-p (concat (plist-get seed :journal) ".migrating"))) "legacy migration left its staging file")
    (async-close)))`);
});

test("Emacs interactive recovery associates a saved non-file session with an unused file buffer", nativeOptions, async () => {
  await fixture(`(let ((target (expand-file-name "recovered-file.txt" async-fixture-root)) seed source-path)
  (with-current-buffer (generate-new-buffer "saved non-file draft")
    (pmbah-mode 1) (insert "private scratch writing")
    (setq seed (list :session pmbah--session-id :journal (pmbah--journal-file)))
    (setq source-path (pmbah--state-file)) (async-close))
  (with-temp-file target)
  (setq pmbah-helper-script async-fixture-helper)
  (with-current-buffer (find-file-noselect target)
    (cl-letf (((symbol-function 'completing-read) (lambda (&rest _) source-path)))
      (let ((noninteractive nil)) (call-interactively #'pmbah-recover-session)))
    (async-check (and pmbah--recovery-job buffer-read-only (not pmbah--session-id)) "interactive recovery did not run asynchronously")
    (async-started seed) (async-release seed) (async-await)
    (async-check (and pmbah-mode (equal pmbah--session-id (plist-get seed :session)) (= pmbah--next-seq 1) (= (buffer-size) 0)) "non-file recovery changed history or restored text")
    (async-check (and (equal (pmbah--state-file) (pmbah--preferred-state-file)) (not (file-exists-p source-path))) "non-file recovery did not associate the target file")
    (async-close))
  (with-current-buffer (find-file-noselect target)
    (async-await)
    (async-check (and pmbah-mode (equal pmbah--session-id (plist-get seed :session))) "newly associated file did not auto recover")
    (async-close)))`);
});

test("Emacs shutdown cleanup cancels all recovery workers before releasing ownership", nativeOptions, async () => {
  await fixture(`(let ((first (async-seed "shutdown-first.txt")) (second (async-seed "shutdown-second.txt")) buffers processes)
  (setq pmbah-helper-script async-fixture-helper)
  (dolist (seed (list first second))
    (let ((buffer (find-file-noselect (plist-get seed :file))))
      (push buffer buffers) (async-started seed)
      (with-current-buffer buffer (push (plist-get pmbah--recovery-job :process) processes))))
  (async-check (run-hook-with-args-until-failure 'kill-emacs-query-functions) "pending verification prevented ordinary exit")
  (run-hooks 'kill-emacs-hook)
  (dolist (process processes) (async-check (not (process-live-p process)) "shutdown left a recovery worker alive"))
  (dolist (buffer buffers)
    (with-current-buffer buffer
      (async-check (and (not pmbah--recovery-job) (not pmbah--owned-paths) (not pmbah--session-id)) "shutdown retained unverified ownership")
      (async-close)))
  (dolist (seed (list first second))
    (async-check (and (not (file-locked-p (plist-get seed :metadata))) (not (file-locked-p (plist-get seed :journal)))
                      (eq (plist-get (pmbah--read-state (plist-get seed :metadata)) :capture_enabled) t)) "shutdown changed capture intent or retained locks")))`);
});
