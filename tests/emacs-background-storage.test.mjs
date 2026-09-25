import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const emacs = spawnSync("sh", ["-c", "command -v emacs"], { encoding: "utf8" }).stdout.trim();
const nativeOptions = { skip: emacs ? false : "emacs binary not available" };
const lisp = JSON.stringify;

async function fixture(program, { loseAcknowledgement = false, fragmentReplies = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pmbah-emacs-background-storage-"));
  try {
    const helper = join(directory, "gated-writer.mjs");
    await writeFile(helper, `import { writeSession, runWriter } from ${lisp(resolve("producers/emacs/scripts/session-writer.mjs"))};
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
const root = ${lisp(directory)};
const output = ${fragmentReplies} ? new Writable({ write(chunk, encoding, done) {
  const middle = Math.floor(chunk.length / 2);
  process.stdout.write(chunk.subarray(0, middle));
  setTimeout(() => process.stdout.write(chunk.subarray(middle), done), 5);
} }) : process.stdout;
await runWriter(process.stdin, output, async (input) => {
  writeFileSync(join(root, "writer.started"), "ready");
  const deadline = Date.now() + 12000;
  while (!existsSync(join(root, "writer.release"))) {
    if (Date.now() > deadline) throw new Error("Storage test never released its worker");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const reply = await writeSession(input);
  if (${loseAcknowledgement} && !existsSync(join(root, "writer.crashed"))) {
    writeFileSync(join(root, "writer.crashed"), "durable"); process.exit(17);
  }
  return reply;
});`);
    const script = join(directory, "background-storage.el");
    await writeFile(script, `;;; background-storage.el -*- lexical-binding: t; -*-
(setq pmbah-state-directory ${lisp(join(directory, "state"))})
(load ${lisp(resolve("producers/emacs/pmbah-mode.el"))})
(setq pmbah-observe-process nil pmbah--background-persistence t
      pmbah-writer-script ${lisp(helper)} pmbah--writer-timeout 15)
(defvar storage-root ${lisp(directory)})
(defun storage-check (value message) (unless value (error "%s" message)))
(defun storage-wait (predicate)
  (let ((deadline (+ (float-time) 12)))
    (while (and (not (funcall predicate)) (< (float-time) deadline))
      (accept-process-output nil 0.02))
    (storage-check (funcall predicate)
                   (format "Storage wait timed out: saved=%S pending=%S failure=%S"
                           pmbah--journal-count (length pmbah--journal-pending) pmbah--save-failure))))
(defun storage-started ()
  (storage-wait (lambda () (file-exists-p (expand-file-name "writer.started" storage-root)))))
(defun storage-release ()
  (with-temp-file (expand-file-name "writer.release" storage-root) (insert "released")))
(defun storage-release-soon () (run-with-timer 0.05 nil #'storage-release))
(defun storage-clean-p ()
  (and (not pmbah--writer-request) (not pmbah--writer-retry)
       (not pmbah--journal-pending) (not pmbah--writer-dirty) (not pmbah--writer-timer)))
(defun storage-read (path)
  (with-temp-buffer (insert-file-contents path)
    (json-parse-buffer :object-type 'plist :array-type 'list :null-object nil :false-object :json-false)))
(defun storage-events (path)
  (with-temp-buffer (insert-file-contents path)
    (mapcar (lambda (line) (json-parse-string line :object-type 'plist :null-object nil :false-object :json-false))
            (split-string (buffer-string) "\\n" t))))
(defun storage-new (&optional name)
  (let ((file (expand-file-name (or name "writing.txt") storage-root)))
    (with-temp-file file)
    (set-buffer (find-file-noselect file))
    (pmbah-mode 1)))
(defun storage-close () (set-buffer-modified-p nil) (kill-buffer (current-buffer)))
${program}
(princ "background-storage-ok")
`);
    const result = spawnSync(emacs, ["--batch", "-Q", "-l", script], {
      encoding: "utf8", timeout: 35_000, maxBuffer: 1_000_000,
      env: { ...process.env, PMBAH_API_BASE_URL: "http://127.0.0.1:9" },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
    assert.match(result.stdout, /background-storage-ok/);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("Emacs capture hooks do no disk writes or process launches while storage is slow", nativeOptions, async () => {
  await fixture(`(storage-new)
  (cl-letf (((symbol-function 'write-region) (lambda (&rest _) (error "Disk write in capture hook")))
            ((symbol-function 'make-process) (lambda (&rest _) (error "Process launch in capture hook"))))
    (insert "α") (insert "😀"))
  (storage-check (and (= pmbah--next-seq 2) (not pmbah--save-failure)) "capture performed synchronous work")
  (pmbah--pump-storage) (storage-started)
  (cl-letf (((symbol-function 'write-region) (lambda (&rest _) (error "Disk write while worker pending")))
            ((symbol-function 'make-process) (lambda (&rest _) (error "Process launch while worker pending"))))
    (insert "c") (delete-char -1) (insert "d"))
  (storage-check (and (= pmbah--next-seq 5) (= pmbah--journal-count 0)
                      (= (length pmbah--journal-pending) 5) (not pmbah--save-failure))
                 "slow worker blocked or lost capture")
  (let ((expected (reverse pmbah--events)))
    (storage-release) (storage-wait #'storage-clean-p)
    (storage-check (equal expected (storage-events (pmbah--journal-file))) "journal reordered or duplicated captured events")
    (storage-check (= pmbah--journal-count 5) "durable cursor missed events"))
  (storage-close)`);
});

test("Emacs checkpoints reference only acknowledged durable prefixes", nativeOptions, async () => {
  await fixture(`(storage-new) (insert "first") (pmbah--pump-storage) (storage-started)
  (let (observed)
    (setq pmbah-observe-process t)
    (cl-letf (((symbol-function 'pmbah--observation-kick)
               (lambda ()
                 (let ((payload (pmbah--chain-tip-payload)))
                   (storage-check (= (plist-get payload :event_count) pmbah--journal-count) "checkpoint count used unacknowledged events")
                   (storage-check (= (plist-get payload :end_byte) pmbah--journal-bytes) "checkpoint byte cursor used unacknowledged events")
                   (storage-check (<= (plist-get payload :end_byte) (file-attribute-size (file-attributes (pmbah--journal-file)))) "checkpoint outran disk")
                   (push pmbah--journal-count observed)
                   (setq pmbah--observation-committed-count pmbah--journal-count)))))
      (insert "second") (pmbah--observation-after-event)
      (storage-check (null observed) "checkpoint ran before storage acknowledgement")
      (storage-release) (storage-wait #'storage-clean-p)
      (storage-check (equal (reverse observed) '(1 2)) "checkpoint did not follow acknowledged prefixes")))
  (setq pmbah-observe-process nil) (storage-close)`);
});

test("Emacs bounds pending capture to 256 events and resumes after durable acknowledgement", nativeOptions, async () => {
  await fixture(`(storage-new) (insert "a") (pmbah--pump-storage) (storage-started)
  (dotimes (_ 255) (insert "a"))
  (storage-check (and (= (length pmbah--journal-pending) 256) buffer-read-only pmbah--storage-backpressure) "pending queue did not apply backpressure")
  (let (blocked)
    (condition-case nil (insert "must not capture") (buffer-read-only (setq blocked t)))
    (storage-check (and blocked (= pmbah--next-seq 256)) "backpressure allowed another edit"))
  (storage-release) (storage-wait #'storage-clean-p)
  (storage-check (and (= pmbah--journal-count 256) (not buffer-read-only) (not pmbah--storage-backpressure)) "acknowledgement did not resume capture")
  (insert "continued") (storage-wait #'storage-clean-p)
  (storage-check (= pmbah--journal-count 257) "resumed capture lost its event")
  (storage-close)`);
});

test("Emacs retries a worker crash after commit without duplicating events", nativeOptions, async () => {
  await fixture(`(storage-new) (insert "a") (insert "b") (pmbah--pump-storage) (storage-started)
  (storage-release) (storage-wait (lambda () pmbah--save-failure))
  (storage-check (and buffer-read-only pmbah--writer-retry (= pmbah--journal-count 0)
                      (= (length (storage-events (pmbah--journal-file))) 2)) "uncertain committed request was not retained")
  (pmbah-retry-save)
  (storage-check (and (not pmbah--save-failure) (not buffer-read-only) (= pmbah--journal-count 2)
                      (not pmbah--journal-pending) (not pmbah--writer-retry)) "retry did not recover committed request")
  (insert "c") (storage-wait #'storage-clean-p)
  (storage-check (equal (mapcar (lambda (event) (plist-get event :seq)) (storage-events (pmbah--journal-file))) '(0 1 2)) "retry duplicated or dropped events")
  (storage-close)`, { loseAcknowledgement: true });
});

test("Emacs retains metadata changes made while an older snapshot is being saved", nativeOptions, async () => {
  await fixture(`(storage-new) (insert "a") (pmbah--pump-storage) (storage-started)
  (setq pmbah--pending-gap t) (pmbah--write-state)
  (storage-check pmbah--writer-dirty "metadata change was not queued")
  (storage-release) (storage-wait #'storage-clean-p)
  (storage-check (eq (plist-get (storage-read (pmbah--state-file)) :pending_gap) t) "old acknowledgement erased newer metadata")
  (storage-close)`);
});

test("Emacs acknowledges pending ownership and cursors with keyboard quits inhibited", nativeOptions, async () => {
  await fixture(`(storage-new) (insert "a") (pmbah--pump-storage) (storage-started)
  (let ((original (symbol-function 'butlast)) checked)
    (cl-letf (((symbol-function 'butlast)
               (lambda (list &optional count)
                 (when (and pmbah--writer-request (eq list pmbah--journal-pending))
                   (storage-check inhibit-quit "acknowledgement can be interrupted while transferring pending ownership")
                   (setq checked t))
                 (funcall original list count))))
      (storage-release) (storage-wait #'storage-clean-p))
    (storage-check (and checked (= pmbah--journal-count 1) (not pmbah--journal-pending)) "atomic acknowledgement was not exercised"))
  (storage-close)`);
});

test("Emacs sends large batches only in credited small frames and accepts fragmented replies", nativeOptions, async () => {
  await fixture(`(storage-new)
  (let ((original (symbol-function 'process-send-string)) (frames 0))
    (cl-letf (((symbol-function 'process-send-string)
               (lambda (process bytes)
                 (when (eq process pmbah--writer)
                   (storage-check pmbah--writer-ready "parent wrote before the storage worker was ready")
                   (storage-check (<= (string-bytes bytes) 4096) "parent sent an oversized pipe write")
                   (setq frames (1+ frames)))
                 (funcall original process bytes))))
      (dotimes (_ 256) (insert "a"))
      (pmbah--pump-storage) (storage-started)
      (storage-check (> frames 1) "fixture did not exercise a multi-frame request")
      (storage-check (= pmbah--journal-count 0) "transport credit prematurely acknowledged events")
      (storage-release) (storage-wait #'storage-clean-p))
    (storage-check (and (= pmbah--journal-count 256) (not pmbah--save-failure)
                        (not buffer-read-only)) "fragmented acknowledgement lost a durable batch"))
  (storage-close)`, { fragmentReplies: true });
});

test("Emacs preserves storage backpressure through major-mode changes and marks bypassed edits as gaps", nativeOptions, async () => {
  await fixture(`(storage-new) (insert "a") (pmbah--pump-storage) (storage-started)
  (dotimes (_ 255) (insert "a"))
  (text-mode)
  (storage-check (and pmbah-mode buffer-read-only pmbah--storage-backpressure
                      (= (length pmbah--journal-pending) 256)) "major mode change lost bounded capture state")
  (let ((inhibit-read-only t)) (insert "forced private edit"))
  (storage-check (and pmbah--pending-gap (= pmbah--next-seq 256)
                      (= (length pmbah--journal-pending) 256)) "bypassing backpressure expanded capture or hid a gap")
  (storage-release) (storage-wait #'storage-clean-p)
  (storage-check (not buffer-read-only) "major mode prevented unlocking after storage caught up")
  (insert "continued") (storage-wait #'storage-clean-p)
  (let ((last (car (last (storage-events (pmbah--journal-file))))))
    (storage-check (and (= (plist-get last :seq) 256) (null (plist-get last :pos))) "next captured edit did not disclose the unknown gap"))
  (storage-close)`);
});

test("Emacs recovers an idle writer failure and persists the next edit", nativeOptions, async () => {
  await fixture(`(storage-new) (insert "a") (pmbah--pump-storage) (storage-started)
  (storage-release) (storage-wait #'storage-clean-p)
  (storage-check (and (process-live-p pmbah--writer) (not pmbah--writer-request)) "fixture did not reach idle worker")
  (delete-process pmbah--writer)
  (storage-wait (lambda () pmbah--save-failure))
  (storage-check (and buffer-read-only (not pmbah--writer-retry)) "idle worker failure lost its pause state")
  (pmbah-retry-save)
  (storage-check (and (not pmbah--save-failure) (not buffer-read-only)) "idle worker failure was not recoverable")
  (insert "b") (storage-wait #'storage-clean-p)
  (storage-check (and (= pmbah--journal-count 2)
                      (= (length (storage-events (pmbah--journal-file))) 2)) "next edit after idle worker recovery was not saved")
  (storage-close)`);
});

test("Emacs closing a buffer drains its active writer before releasing session ownership", nativeOptions, async () => {
  await fixture(`(storage-new) (insert "a") (pmbah--pump-storage) (storage-started)
  (let ((buffer (current-buffer)) (metadata (pmbah--state-file)) (process pmbah--writer))
    (run-with-timer 0.05 nil
                    (lambda ()
                      (storage-check (eq (file-locked-p metadata) t) "close released ownership before pending write completed")
                      (storage-release)))
    (storage-close)
    (storage-check (not (buffer-live-p buffer)) "buffer close did not complete")
    (storage-check (not (process-live-p process)) "closed buffer retained a live writer")
    (storage-check (not (file-locked-p metadata)) "closed buffer retained recovery ownership")
    (storage-check (= (plist-get (storage-read metadata) :event_count) 1) "close released unsaved history"))`);
});

test("Emacs file rename waits for pending writes before moving recovery metadata", nativeOptions, async () => {
  await fixture(`(storage-new) (insert "a") (pmbah--pump-storage) (storage-started)
  (let ((old-path (pmbah--state-file)) (journal (pmbah--journal-file)))
    (storage-release-soon)
    (set-visited-file-name (expand-file-name "renamed.txt" storage-root) t)
    (storage-check (and (not (equal old-path (pmbah--state-file))) (not (file-exists-p old-path))) "rename left stale recovery metadata")
    (storage-check (and (not (file-locked-p old-path)) (eq (file-locked-p (pmbah--state-file)) t)) "rename did not transfer recovery ownership")
    (storage-check (= (plist-get (storage-read (pmbah--state-file)) :event_count) 1) "rename lost pending event")
    (storage-check (and (equal journal (pmbah--journal-file)) (not pmbah--writer)) "rename retained a worker using the old metadata path"))
  (storage-close)`);
});

test("Emacs discard drains the old writer before deleting and starting a fresh session", nativeOptions, async () => {
  await fixture(`(storage-new) (insert "a") (pmbah--pump-storage) (storage-started)
  (let ((old-session pmbah--session-id) (old-journal (pmbah--journal-file)) (process pmbah--writer))
    (storage-release-soon) (pmbah-discard-session)
    (storage-check (and (not (equal old-session pmbah--session-id)) (not (file-exists-p old-journal))
                        (not (process-live-p process)) (= pmbah--next-seq 0)) "discard raced an old write")
    (insert "new") (storage-wait #'storage-clean-p)
    (storage-check (and (= pmbah--journal-count 1)
                        (equal (plist-get (storage-read (pmbah--state-file)) :session_id) pmbah--session-id)
                        (not (file-exists-p old-journal))) "old worker resurrected discarded history"))
  (storage-close)`);
});
