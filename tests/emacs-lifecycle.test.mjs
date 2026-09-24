import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const emacs = spawnSync("sh", ["-c", "command -v emacs"], { encoding: "utf8" }).stdout.trim();
const nativeOptions = { skip: emacs ? false : "emacs binary not available" };
const lisp = JSON.stringify;

async function scenario(directory, program, { allowCloseVeto = false } = {}) {
  const script = join(directory, "lifecycle.el");
  await writeFile(script, `;;; lifecycle.el -*- lexical-binding: t; -*-
(setq pmbah-state-directory ${lisp(join(directory, "state"))})
(load ${lisp(resolve("producers/emacs/pmbah-mode.el"))})
(setq pmbah-observe-process nil)
(defun lifecycle-open (file)
  (let ((buffer (find-file-noselect file)) (deadline (+ (float-time) 10)))
    (with-current-buffer buffer
      (while (and (bound-and-true-p pmbah--recovery-job) (< (float-time) deadline))
        (accept-process-output nil 0.02))
      (when (bound-and-true-p pmbah--recovery-job) (error "Automatic recovery did not finish")))
    buffer))
(defun lifecycle-close ()
  (set-buffer-modified-p nil)
  (kill-buffer (current-buffer)))
(defun lifecycle-check (condition message)
  (unless condition (error "%s" message)))
${program}
(princ "lifecycle-ok")
`);
  const result = spawnSync(emacs, ["--batch", "-Q", "-l", script], {
    encoding: "utf8", timeout: 30_000, maxBuffer: 1_000_000,
    env: { ...process.env, PMBAH_API_BASE_URL: "http://127.0.0.1:9" },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
  assert.match(result.stdout, /lifecycle-ok/);
  if (!allowCloseVeto) assert.doesNotMatch(result.stderr, /close cancelled/, "ordinary recovery must not strand helper buffers behind a close veto");
}

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), "pmbah-emacs-lifecycle-"));
  try { await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("Emacs remembers capture before the first edit and automatically resumes the same empty file session", nativeOptions, async () => {
  await fixture(async (directory) => {
    const file = join(directory, "empty.txt");
    await writeFile(file, "");
    await scenario(directory, `(let (session path)
  (with-current-buffer (lifecycle-open ${lisp(file)})
    (lifecycle-check (not pmbah-mode) "a new file opted itself in")
    (pmbah-mode 1)
    (setq session pmbah--session-id path (pmbah--state-file))
    (lifecycle-check (file-exists-p path) "empty session was not persisted")
    (lifecycle-check (eq (plist-get (pmbah--read-state path) :capture_enabled) t) "capture intent missing")
    (lifecycle-close))
  (with-current-buffer (lifecycle-open ${lisp(file)})
    (lifecycle-check pmbah-mode "reopening did not activate capture")
    (lifecycle-check (equal session pmbah--session-id) "empty session identity changed")
    (lifecycle-check (= pmbah--next-seq 0) "opening recorded file contents")
    (insert "first actual edit")
    (lifecycle-check (= pmbah--next-seq 1) "first edit was not captured")
    (lifecycle-close)))`);
  });
});

test("Emacs automatically reopens several independent files while leaving unrelated files alone", nativeOptions, async () => {
  await fixture(async (directory) => {
    const files = ["a.txt", "b.txt", "private.txt"].map((name) => join(directory, name));
    await Promise.all(files.map((file) => writeFile(file, "")));
    await scenario(directory, `(let (first second)
  (with-current-buffer (lifecycle-open ${lisp(files[0])})
    (pmbah-mode 1) (insert "A") (insert "B")
    (setq first pmbah--session-id)
    (let ((require-final-newline nil)) (save-buffer)) (lifecycle-close))
  (with-current-buffer (lifecycle-open ${lisp(files[1])})
    (pmbah-mode 1) (insert "C")
    (setq second pmbah--session-id)
    (let ((require-final-newline nil)) (save-buffer)) (lifecycle-close))
  (lifecycle-check (not (equal first second)) "different files shared a session")
  (with-current-buffer (lifecycle-open ${lisp(files[1])})
    (lifecycle-check (and pmbah-mode (equal second pmbah--session-id) (= pmbah--next-seq 1)) "second file recovered incorrectly")
    (goto-char (point-max)) (insert "D")
    (lifecycle-check (null (plist-get (car pmbah--events) :pos)) "reopen boundary claimed continuous capture")
    (lifecycle-close))
  (with-current-buffer (lifecycle-open ${lisp(files[0])})
    (lifecycle-check (and pmbah-mode (equal first pmbah--session-id) (= pmbah--next-seq 2)) "first file recovered incorrectly")
    (lifecycle-close))
  (with-current-buffer (lifecycle-open ${lisp(files[2])})
    (lifecycle-check (and (not pmbah-mode) (not pmbah--session-id) (not pmbah--owned-paths)) "unrelated file started recording")
    (lifecycle-close)))`);
    const stateNames = await readdir(join(directory, "state"));
    for (const name of stateNames.filter((name) => name.endsWith(".json"))) {
      const metadata = await readFile(join(directory, "state", name), "utf8");
      for (const file of files) assert.equal(metadata.includes(file), false, "local association exposed a document path");
    }
  });
});

test("Emacs file capture resumes across an actual process restart", nativeOptions, async () => {
  await fixture(async (directory) => {
    const file = join(directory, "restart.txt"), identity = join(directory, "identity");
    await writeFile(file, "");
    await scenario(directory, `(with-current-buffer (lifecycle-open ${lisp(file)})
  (pmbah-mode 1) (insert "recorded")
  (let ((session pmbah--session-id)) (with-temp-file ${lisp(identity)} (insert session)))
  (let ((require-final-newline nil)) (save-buffer)))`);
    await scenario(directory, `(with-current-buffer (lifecycle-open ${lisp(file)})
  (lifecycle-check pmbah-mode "restart did not enable capture")
  (lifecycle-check (equal pmbah--session-id (pmbah--read-file ${lisp(identity)})) "restart replaced session")
  (lifecycle-check (= pmbah--next-seq 1) "restart lost history or captured loaded text")
  (insert "continued")
  (lifecycle-check (= pmbah--next-seq 2) "restart did not capture the next edit")
  (lifecycle-close))`);
  });
});

test("Emacs remembers an explicit pause and manual enable resumes the same history", nativeOptions, async () => {
  await fixture(async (directory) => {
    const file = join(directory, "paused.txt");
    await writeFile(file, "");
    await scenario(directory, `(let (session)
  (with-current-buffer (lifecycle-open ${lisp(file)})
    (pmbah-mode 1) (insert "recorded") (setq session pmbah--session-id)
    (pmbah-mode -1)
    (lifecycle-check (eq (plist-get (pmbah--read-state (pmbah--state-file)) :capture_enabled) :json-false) "pause not persisted")
    (lifecycle-close))
  (with-current-buffer (lifecycle-open ${lisp(file)})
    (lifecycle-check (and (not pmbah-mode) (not buffer-read-only)) "paused file resumed automatically")
    (insert "private") (pmbah-mode 1)
    (lifecycle-check (equal session pmbah--session-id) "manual resume replaced paused session")
    (lifecycle-check (= pmbah--next-seq 1) "private edits entered the session")
    (insert "recorded again")
    (lifecycle-check (= pmbah--next-seq 2) "manual resume did not capture")
    (lifecycle-close))
  (with-current-buffer (lifecycle-open ${lisp(file)})
    (lifecycle-check pmbah-mode "manual resume did not persist opt-in")
    (lifecycle-close)))`);
  });
});

test("Emacs file association follows major-mode changes and renames while capture is active or paused", nativeOptions, async () => {
  await fixture(async (directory) => {
    for (const paused of [false, true]) {
      const file = join(directory, `before-${paused}.txt`), renamed = join(directory, `after-${paused}.txt`);
      await writeFile(file, "");
      await scenario(directory, `(let (session old-path)
  (with-current-buffer (lifecycle-open ${lisp(file)})
    (pmbah-mode 1) (insert "recorded")
    (setq session pmbah--session-id old-path (pmbah--state-file))
    ${paused ? "(pmbah-mode -1)" : ""}
    (text-mode)
    (let ((require-final-newline nil)) (write-file ${lisp(renamed)}))
    (lifecycle-check (not (file-exists-p old-path)) "rename left authoritative metadata under the old name")
    (lifecycle-close))
  (with-current-buffer (lifecycle-open ${lisp(renamed)})
    ${paused ? '(lifecycle-check (not pmbah-mode) "rename forgot pause") (pmbah-mode 1)' : '(lifecycle-check pmbah-mode "renamed file did not auto resume")'}
    (lifecycle-check (and (equal session pmbah--session-id) (= pmbah--next-seq 1)) "renamed file lost its session")
    (lifecycle-close)))`);
    }
  });
});

test("Emacs associates an unnamed captured buffer when it is first saved as a file", nativeOptions, async () => {
  await fixture(async (directory) => {
    const file = join(directory, "new-draft.txt");
    await scenario(directory, `(let (session old-path count)
  (with-current-buffer (generate-new-buffer "unnamed writing")
    (pmbah-mode 1) (insert "recorded before naming")
    (setq session pmbah--session-id old-path (pmbah--state-file))
    (let ((require-final-newline nil)) (write-file ${lisp(file)}))
    (setq count pmbah--next-seq)
    (lifecycle-check (not (file-exists-p old-path)) "unnamed metadata did not move")
    (lifecycle-close))
  (with-current-buffer (lifecycle-open ${lisp(file)})
    (lifecycle-check (and pmbah-mode (equal session pmbah--session-id) (= pmbah--next-seq count)) "saved scratch buffer did not resume")
    (lifecycle-close)))`);
  });
});

test("Emacs automatically restores frozen uploads read-only without retrying publication", nativeOptions, async () => {
  await fixture(async (directory) => {
    const file = join(directory, "frozen.txt");
    await writeFile(file, "");
    await scenario(directory, `(let (session frozen)
  (with-current-buffer (lifecycle-open ${lisp(file)})
    (pmbah-mode 1) (insert "seal this prefix")
    (let ((require-final-newline nil)) (save-buffer))
    (cl-letf (((symbol-function 'pmbah--post-record) (lambda (&rest _) (error "offline fixture"))))
      (condition-case nil (pmbah-sign-buffer (list :surface "emacs") t) (error nil)))
    (setq session pmbah--session-id frozen pmbah--frozen-record)
    (lifecycle-check frozen "fixture did not freeze a record")
    (lifecycle-close))
  (cl-letf (((symbol-function 'pmbah--post-record) (lambda (&rest _) (error "reopen must not publish"))))
    (with-current-buffer (lifecycle-open ${lisp(file)})
      (lifecycle-check (and pmbah-mode buffer-read-only (equal session pmbah--session-id) (equal frozen pmbah--frozen-record)) "frozen record was not restored intact")
      (condition-case nil (progn (insert "must fail") (error "frozen buffer accepted an edit")) (buffer-read-only nil))
      (lifecycle-close))))`);
  });
});

test("Emacs automatic recovery preserves corrupt metadata and journals and blocks silent uncaptured edits", nativeOptions, async () => {
  await fixture(async (directory) => {
    for (const damage of ["metadata", "journal"]) {
      const file = join(directory, `${damage}.txt`);
      await writeFile(file, "");
      await scenario(directory, `(let (metadata journal metadata-before journal-before)
  (with-current-buffer (lifecycle-open ${lisp(file)})
    (pmbah-mode 1) (insert "acknowledged")
    (setq metadata (pmbah--state-file) journal (pmbah--journal-file))
    (lifecycle-close))
  (with-temp-file ${damage === "metadata" ? "metadata" : "journal"} (insert "broken acknowledged state"))
  (setq metadata-before (pmbah--read-file metadata) journal-before (pmbah--read-file journal))
  (with-current-buffer (lifecycle-open ${lisp(file)})
    (lifecycle-check (and (not pmbah-mode) pmbah--recovery-error buffer-read-only) "failed recovery was silently editable")
    (lifecycle-check (and (not pmbah--session-id) (not pmbah--owned-paths)) "failed recovery installed partial state or kept locks")
    (condition-case nil (progn (insert "must fail") (error "failed recovery accepted uncaptured edit")) (buffer-read-only nil))
    (lifecycle-check (and (equal metadata-before (pmbah--read-file metadata)) (equal journal-before (pmbah--read-file journal))) "automatic recovery modified corrupt evidence")
    (lifecycle-check (not (file-exists-p (concat metadata ".stale"))) "automatic recovery retired the session")
    (pmbah-mode -1)
    (lifecycle-check (and (not buffer-read-only) (not pmbah--recovery-error)) "explicit private-edit choice did not unlock")
    (insert "private")
    (lifecycle-close))
  (lifecycle-check (and (equal metadata-before (pmbah--read-file metadata)) (equal journal-before (pmbah--read-file journal))) "private editing overwrote failed recovery evidence"))`);
    }
  });
});

test("Emacs automatic helper failure can be retried explicitly without replacing the saved session", nativeOptions, async () => {
  await fixture(async (directory) => {
    const file = join(directory, "helper-failure.txt");
    await writeFile(file, "");
    await scenario(directory, `(let (session saved path)
  (with-current-buffer (lifecycle-open ${lisp(file)})
    (pmbah-mode 1) (insert "kept")
    (setq session pmbah--session-id path (pmbah--state-file)) (lifecycle-close))
  (setq saved (pmbah--read-file path))
  (let ((pmbah-node-command "/pmbah-test-nonexistent-node"))
    (with-current-buffer (lifecycle-open ${lisp(file)})
      (lifecycle-check (and (not pmbah-mode) pmbah--recovery-error buffer-read-only) "helper failure did not protect the buffer")
      (lifecycle-check (and (not pmbah--session-id) (not pmbah--owned-paths)) "helper failure installed partial recovery")
      (lifecycle-check (equal saved (pmbah--read-file path)) "helper failure modified metadata")))
  (with-current-buffer (lifecycle-open ${lisp(file)})
    (pmbah-mode 1)
    (lifecycle-check (and pmbah-mode (not buffer-read-only) (not pmbah--recovery-error) (equal session pmbah--session-id) (= pmbah--next-seq 1)) "explicit recovery retry failed")
    (insert "continued")
    (lifecycle-check (= pmbah--next-seq 2) "recovery retry did not capture")
    (lifecycle-close)))`);
  });
});

test("Emacs can opt out of automatic recovery globally and resumes legacy metadata when enabled", nativeOptions, async () => {
  await fixture(async (directory) => {
    const file = join(directory, "legacy.txt");
    await writeFile(file, "");
    await scenario(directory, `(let (session path)
  (with-current-buffer (lifecycle-open ${lisp(file)})
    (pmbah-mode 1) (insert "old draft")
    (setq session pmbah--session-id path (pmbah--state-file)) (lifecycle-close))
  (let ((state (cl-loop for (key value) on (pmbah--read-state path) by #'cddr
                        unless (eq key :capture_enabled) append (list key value))))
    (pmbah--write-json-file path (pmbah--json-encode state)))
  (let ((pmbah-auto-resume nil))
    (with-current-buffer (lifecycle-open ${lisp(file)})
      (lifecycle-check (and (not pmbah-mode) (not pmbah--session-id)) "global opt-out was ignored")
      (lifecycle-close)))
  (with-current-buffer (lifecycle-open ${lisp(file)})
    (lifecycle-check (and pmbah-mode (equal session pmbah--session-id) (= pmbah--next-seq 1)) "legacy saved capture did not resume")
    (lifecycle-close)))`);
  });
});

test("Emacs prevents buffer close and ordinary exit while a captured edit cannot be saved", nativeOptions, async () => {
  await fixture(async (directory) => {
    const file = join(directory, "unsaved-capture.txt");
    await writeFile(file, "");
    await scenario(directory, `(let ((buffer (lifecycle-open ${lisp(file)})) session)
  (with-current-buffer buffer
    (pmbah-mode 1) (setq session pmbah--session-id)
    (cl-letf (((symbol-function 'pmbah--flush-journal) (lambda () (error "disk unavailable"))))
      (insert "pending capture")
      (lifecycle-check (and pmbah--save-failure pmbah--journal-pending) "fixture did not retain a failed event")
      (set-buffer-modified-p nil)
      (lifecycle-check (not (kill-buffer buffer)) "buffer close discarded pending history")
      (lifecycle-check (buffer-live-p buffer) "failed close killed the buffer")
      (lifecycle-check (not (run-hook-with-args-until-failure 'kill-emacs-query-functions)) "ordinary exit allowed pending history loss"))
    (pmbah-retry-save)
    (lifecycle-check (and (not pmbah--save-failure) (not pmbah--journal-pending)) "retry did not save pending capture")
    (lifecycle-check (kill-buffer buffer) "saved buffer could not close"))
  (with-current-buffer (lifecycle-open ${lisp(file)})
    (lifecycle-check (and pmbah-mode (equal session pmbah--session-id) (= pmbah--next-seq 1)) "saved event was not recovered after close")
    (lifecycle-close)))`, { allowCloseVeto: true });
  });
});

test("Emacs can save failed capture after pausing without turning capture back on", nativeOptions, async () => {
  await fixture(async (directory) => {
    const file = join(directory, "paused-unsaved.txt");
    await writeFile(file, "");
    await scenario(directory, `(let ((buffer (lifecycle-open ${lisp(file)})) session)
  (with-current-buffer buffer
    (pmbah-mode 1) (setq session pmbah--session-id)
    (cl-letf (((symbol-function 'pmbah--flush-journal) (lambda () (error "disk unavailable"))))
      (insert "pending capture") (pmbah-mode -1)
      (lifecycle-check (and (not pmbah-mode) pmbah--save-failure pmbah--journal-pending) "pausing lost the pending edit")
      (text-mode)
      (set-buffer-modified-p nil)
      (lifecycle-check (not (kill-buffer buffer)) "paused buffer lost its close protection after major-mode change"))
    (pmbah-retry-save)
    (lifecycle-check (and (not pmbah-mode) (not pmbah--save-failure) (not pmbah--journal-pending)) "retry-save did not preserve the pause")
    (lifecycle-check (eq (plist-get (pmbah--read-state (pmbah--state-file)) :capture_enabled) :json-false) "retry-save persisted enabled capture")
    (lifecycle-check (kill-buffer buffer) "saved paused buffer could not close"))
  (with-current-buffer (lifecycle-open ${lisp(file)})
    (lifecycle-check (not pmbah-mode) "saved paused file auto-enabled")
    (pmbah-mode 1)
    (lifecycle-check (and (equal session pmbah--session-id) (= pmbah--next-seq 1)) "paused save lost history")
    (lifecycle-close)))`, { allowCloseVeto: true });
  });
});

test("Emacs package reload upgrades active and paused legacy buffers without retaining global close hooks", nativeOptions, async () => {
  await fixture(async (directory) => {
    const active = join(directory, "active-upgrade.txt"), paused = join(directory, "paused-upgrade.txt");
    await Promise.all([writeFile(active, ""), writeFile(paused, "")]);
    await scenario(directory, `(let ((active (lifecycle-open ${lisp(active)}))
      (paused (lifecycle-open ${lisp(paused)})) active-session paused-session)
  (with-current-buffer active (pmbah-mode 1) (insert "active history") (setq active-session pmbah--session-id))
  (with-current-buffer paused (pmbah-mode 1) (insert "paused history") (pmbah-mode -1) (setq paused-session pmbah--session-id))
  ;; Reproduce the previous package's retained locals and global close hooks.
  (dolist (buffer (list active paused))
    (with-current-buffer buffer
      (kill-local-variable 'pmbah--capture-enabled)
      (dolist (function '(pmbah--write-state pmbah--cancel-sign-job pmbah--release-ownership))
        (remove-hook 'kill-buffer-hook function t))
      (remove-hook 'kill-buffer-query-functions #'pmbah--can-close-buffer t)
      (remove-hook 'after-set-visited-file-name-hook #'pmbah--follow-visited-file t)))
  (add-hook 'kill-buffer-hook #'pmbah--write-state)
  (add-hook 'kill-buffer-hook #'pmbah--cancel-sign-job)
  (add-hook 'kill-buffer-hook #'pmbah--release-ownership t)
  (load ${lisp(resolve("producers/emacs/pmbah-mode.el"))})
  (dolist (function '(pmbah--write-state pmbah--cancel-sign-job pmbah--release-ownership))
    (lifecycle-check (not (memq function (default-value 'kill-buffer-hook))) "reload retained a global session close hook"))
  (with-current-buffer active (lifecycle-close))
  (with-current-buffer paused (lifecycle-close))
  (with-current-buffer (lifecycle-open ${lisp(active)})
    (lifecycle-check (and pmbah-mode (equal active-session pmbah--session-id) (= pmbah--next-seq 1)) "upgraded active session did not auto resume")
    (lifecycle-close))
  (with-current-buffer (lifecycle-open ${lisp(paused)})
    (lifecycle-check (and (not pmbah-mode) (not buffer-read-only)) "upgraded paused session auto-enabled")
    (pmbah-mode 1)
    (lifecycle-check (and (equal paused-session pmbah--session-id) (= pmbah--next-seq 1)) "upgraded paused session lost history")
    (lifecycle-close)))`);
  });
});

test("Emacs initial capture persistence failure stops editing until the empty session is saved", nativeOptions, async () => {
  await fixture(async (directory) => {
    const file = join(directory, "first-save-failure.txt");
    await writeFile(file, "");
    await scenario(directory, `(let (session)
  (with-current-buffer (lifecycle-open ${lisp(file)})
    (cl-letf (((symbol-function 'pmbah--write-json-file) (lambda (&rest _) (error "cannot save initial opt-in"))))
      (pmbah-mode 1)
      (setq session pmbah--session-id)
      (lifecycle-check (and pmbah--save-failure buffer-read-only) "initial persistence failure allowed uncaptured editing")
      (condition-case nil (progn (insert "must fail") (error "initial save failure accepted an edit")) (buffer-read-only nil)))
    (pmbah-retry-save)
    (lifecycle-check (and pmbah-mode (not pmbah--save-failure) (not buffer-read-only)) "empty session save retry did not recover")
    (lifecycle-close))
  (with-current-buffer (lifecycle-open ${lisp(file)})
    (lifecycle-check (and pmbah-mode (equal session pmbah--session-id) (= pmbah--next-seq 0)) "initial save retry did not persist the empty session")
    (lifecycle-close)))`);
  });
});

test("Emacs leaves explicitly paused unsupported metadata untouched without blocking file editing", nativeOptions, async () => {
  await fixture(async (directory) => {
    const file = join(directory, "unsupported-paused.txt");
    await writeFile(file, "");
    await scenario(directory, `(let (path saved)
  (with-current-buffer (lifecycle-open ${lisp(file)})
    (pmbah-mode 1) (insert "paused future history") (pmbah-mode -1)
    (setq path (pmbah--state-file)) (lifecycle-close))
  (let ((state (pmbah--read-state path)))
    (setq state (plist-put state :format_version "future-unsupported"))
    (pmbah--write-json-file path (pmbah--json-encode state)))
  (setq saved (pmbah--read-file path))
  (with-current-buffer (lifecycle-open ${lisp(file)})
    (lifecycle-check (and (not pmbah-mode) (not pmbah--recovery-error) (not buffer-read-only) (not pmbah--owned-paths)) "paused unsupported session attempted recovery")
    (insert "private edit") (lifecycle-close))
  (lifecycle-check (and (equal saved (pmbah--read-file path)) (not (file-exists-p (concat path ".stale")))) "paused unsupported metadata was changed"))`);
  });
});

test("Emacs keeps recovered history exclusively owned if enabling capture is interrupted after recovery", nativeOptions, async () => {
  await fixture(async (directory) => {
    const file = join(directory, "interrupted-enable.txt");
    await writeFile(file, "");
    await scenario(directory, `(let (session metadata journal owner)
  (with-current-buffer (lifecycle-open ${lisp(file)})
    (pmbah-mode 1) (insert "acknowledged history")
    (setq session pmbah--session-id metadata (pmbah--state-file) journal (pmbah--journal-file))
    (lifecycle-close))
  (let ((pmbah-auto-resume nil)) (setq owner (lifecycle-open ${lisp(file)})))
  (with-current-buffer owner
    (let ((write-json (symbol-function 'pmbah--write-json-file)) (writes 0))
      (cl-letf (((symbol-function 'pmbah--write-json-file)
                 (lambda (&rest args)
                   (setq writes (1+ writes))
                   (if (= writes 2) (signal 'quit nil) (apply write-json args)))))
        (pmbah-mode 1))
      (lifecycle-check (and (= writes 2) pmbah--save-failure buffer-read-only) "interrupted post-recovery save did not protect retained capture"))
    (lifecycle-check (and pmbah-mode (equal session pmbah--session-id) (= pmbah--next-seq 1)) "interrupted enable lost installed recovery")
    (lifecycle-check (and (member metadata pmbah--owned-paths) (member journal pmbah--owned-paths)
                          (eq (file-locked-p metadata) t) (eq (file-locked-p journal) t)) "interrupted enable released retained history ownership")
    (lifecycle-check (and (local-variable-p 'kill-buffer-query-functions)
                          (memq #'pmbah--can-close-buffer kill-buffer-query-functions)) "interrupted enable omitted the close guard"))
  (with-temp-buffer
    (let (blocked)
      (condition-case nil (pmbah-recover-session metadata) (user-error (setq blocked t)))
      (lifecycle-check (and blocked (not pmbah--session-id) (not pmbah--owned-paths)) "another buffer acquired interrupted recovery")))
  (with-current-buffer owner
    (pmbah-retry-save) (insert "next edit")
    (lifecycle-check (and pmbah-mode (equal session pmbah--session-id) (= pmbah--next-seq 2)) "retry failed to continue retained recovery")
    (lifecycle-close))
  (lifecycle-check (and (not (file-locked-p metadata)) (not (file-locked-p journal))) "closing recovered buffer left ownership locks"))`);
  });
});

test("Emacs retains the original session when saving or archiving a clock retirement fails", nativeOptions, async () => {
  await fixture(async (directory) => {
    const file = join(directory, "retirement.txt");
    await writeFile(file, "");
    await scenario(directory, `(with-current-buffer (lifecycle-open ${lisp(file)})
  (pmbah-mode 1) (insert "retained history")
  (let* ((session pmbah--session-id) (metadata (pmbah--state-file)) (journal (pmbah--journal-file))
         (saved (pmbah--read-file metadata)) (events (pmbah--read-file journal)) blocked)
    (cl-letf (((symbol-function 'pmbah--write-json-file) (lambda (&rest _) (error "retirement save failed"))))
      (condition-case nil (pmbah--retire-live-session) (error (setq blocked t))))
    (lifecycle-check (and blocked (equal session pmbah--session-id) (= pmbah--next-seq 1)
                          (equal saved (pmbah--read-file metadata)) (equal events (pmbah--read-file journal))) "failed retirement save replaced history")
    (setq blocked nil)
    (let ((rename (symbol-function 'rename-file)))
      (cl-letf (((symbol-function 'rename-file)
                 (lambda (source target &optional overwrite)
                   (if (and (equal source metadata) (string-prefix-p (concat metadata ".stale-") target))
                       (error "retirement archive failed")
                     (funcall rename source target overwrite)))))
        (condition-case nil (pmbah--retire-live-session) (error (setq blocked t)))))
    (lifecycle-check (and blocked (equal session pmbah--session-id) (= pmbah--next-seq 1)
                          (equal saved (pmbah--read-file metadata)) (equal events (pmbah--read-file journal))) "failed retirement archive replaced history")
    (pmbah--retire-live-session)
    (let ((archives (directory-files pmbah-state-directory t (concat (regexp-quote (file-name-nondirectory metadata)) "\\\\.stale-"))))
      (lifecycle-check (= (length archives) 1) "successful retirement did not create one unique archive")
      (let ((archived (pmbah--read-state (car archives))))
        (lifecycle-check (and (equal (plist-get archived :session_id) session) (= (plist-get archived :event_count) 1)) "retirement archive lost the original session")))
    (lifecycle-check (and (not (equal session pmbah--session-id)) (= pmbah--next-seq 0)
                          (equal events (pmbah--read-file journal))) "successful retirement did not preserve journal and create a new session"))
  (lifecycle-close))`);
  });
});

test("Emacs protects capture hooks and records a gap when clock retirement fails during an edit", nativeOptions, async () => {
  await fixture(async (directory) => {
    const file = join(directory, "edit-retirement.txt");
    await writeFile(file, "");
    await scenario(directory, `(with-current-buffer (lifecycle-open ${lisp(file)})
  (pmbah-mode 1) (insert "existing history")
  (let ((session pmbah--session-id) (metadata (pmbah--state-file))
        (rename (symbol-function 'rename-file)))
    (cl-letf (((symbol-function 'pmbah--elapsed-ms) (lambda () pmbah-max-session-ms))
              ((symbol-function 'rename-file)
               (lambda (source target &optional overwrite)
                 (if (and (equal source metadata) (string-prefix-p (concat metadata ".stale-") target))
                     (error "clock archive unavailable")
                   (funcall rename source target overwrite)))))
      (insert "edit at clock limit"))
    (lifecycle-check (and pmbah-mode pmbah--save-failure buffer-read-only pmbah--pending-gap
                          (equal session pmbah--session-id) (= pmbah--next-seq 1)
                          (memq #'pmbah--after-change after-change-functions)) "failed clock retirement lost capture protection or history")
    (condition-case nil (progn (insert "must fail") (error "clock failure allowed more edits")) (buffer-read-only nil))
    (pmbah-retry-save) (insert "recorded after repair")
    (lifecycle-check (and (not pmbah--save-failure) (not buffer-read-only) (= pmbah--next-seq 2)
                          (null (plist-get (car pmbah--events) :pos))) "repair did not preserve the honest capture gap"))
  (lifecycle-close))`);
  });
});
