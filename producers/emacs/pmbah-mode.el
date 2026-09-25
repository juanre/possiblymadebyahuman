;;; pmbah-mode.el --- PMBAH content-blind Emacs producer -*- lexical-binding: t; -*-

;; Copyright (c) 2026
;; SPDX-License-Identifier: MIT
;; Version: 0.1.0
;; Package-Requires: ((emacs "29.1"))
;; Keywords: convenience, writing

;;; Commentary:

;; pmbah-mode records Emacs buffer mutations as content-blind
;; PossiblyMadeByAHuman writing records.  It hooks `after-change-functions`,
;; records mutation shape (positions/lengths/timing/source), computes hashes
;; locally through the shared format helper, uploads only the public record, and
;; copies the returned short URL to the kill ring.

;;; Code:

(require 'cl-lib)
(require 'json)
(require 'seq)
(require 'subr-x)
(require 'url)
(require 'url-http)

(defgroup pmbah nil
  "Content-blind PMBAH writing-record producer."
  :group 'convenience
  :prefix "pmbah-")

(defcustom pmbah-api-base-url
  (or (getenv "PMBAH_API_BASE_URL") "https://possiblymadebyahuman.com")
  "Base URL for the PMBAH ingest API.
The producer publishes through `/api/record-uploads` below this URL.  The default is
the public PMBAH service; set `PMBAH_API_BASE_URL` or customize this variable
to use a local `make local-container` stack."
  :type 'string
  :group 'pmbah)

(defcustom pmbah-node-command
  (or (getenv "PMBAH_NODE") "node")
  "Node.js executable used by the local record-building helper.
The helper receives process metadata and computes public process hashes.
At signing it may also receive selected text transiently for the local binding."
  :type 'string
  :group 'pmbah)

(defconst pmbah--source-directory
  (file-name-directory (or load-file-name buffer-file-name default-directory))
  "Directory containing pmbah-mode.el, used to locate the helper scripts.")

(defcustom pmbah-helper-script
  (expand-file-name "scripts/event-journal.mjs" pmbah--source-directory)
  "Local helper script that computes PMBAH BLAKE3 hashes and hash chains."
  :type 'file
  :group 'pmbah)

(defcustom pmbah-chain-tip-script
  (expand-file-name "scripts/chain-tip.mjs" pmbah--source-directory)
  "Local helper script that computes the public chain tip for a checkpoint.
It receives a private journal descriptor and reads only new public events."
  :type 'file
  :group 'pmbah)

(defcustom pmbah-writer-script
  (expand-file-name "scripts/session-writer.mjs" pmbah--source-directory)
  "Persistent local worker that durably saves numeric events off the UI thread."
  :type 'file
  :group 'pmbah)

(defvar pmbah--background-persistence (not noninteractive)
  "Use background persistence in interactive Emacs; batch callers save synchronously.")
(defconst pmbah--pending-event-limit 256
  "Maximum captured events awaiting durable storage before editing pauses.")
(defvar-local pmbah--writer nil)
(defvar-local pmbah--writer-ready nil)
(defvar-local pmbah--writer-credit nil)
(defvar-local pmbah--writer-request nil)
(defvar-local pmbah--writer-retry nil)
(defvar-local pmbah--writer-dirty nil)
(defvar-local pmbah--writer-timer nil)
(defvar-local pmbah--writer-watchdog nil)
(defvar-local pmbah--writer-output "")
(defvar-local pmbah--writer-draining nil)
(defvar-local pmbah--storage-backpressure nil)
(defvar pmbah--writer-sequence 0)
(defvar pmbah--writer-timeout 10
  "Seconds allowed for one bounded storage request before reporting failure.")

(defcustom pmbah-observe-process t
  "Non-nil requests server-observed checkpoints while writing.
Each checkpoint sends the event count and the public hash-chain tip of the
events captured so far to the ingest API, which stamps when it saw that
prefix.  Checkpoints contain no text and no text-derived hashes.  When nil,
records are uploaded without any observation request."
  :type 'boolean
  :group 'pmbah)

(defcustom pmbah-observation-base-url nil
  "Base URL for checkpoint requests, or nil to use `pmbah-api-base-url'."
  :type '(choice (const :tag "Same as pmbah-api-base-url" nil) string)
  :group 'pmbah)

(defcustom pmbah-state-directory (locate-user-emacs-file "pmbah/")
  "Directory holding session recovery state and accepted-link archives.
A file-visiting buffer's session is stored under the SHA-256 of the file's
true name, readable only by the owner.  State files hold the session id,
start time, journal prefix, frozen manifest, and observation token; never
document text. Non-file buffers use session UUIDs and `pmbah-recover-session'."
  :type 'directory
  :group 'pmbah)

(defcustom pmbah-auto-resume t
  "Automatically recover opted-in file sessions when visiting their files.
Only files with saved, enabled PMBAH sessions are resumed.  Explicitly paused
sessions and files without saved state are left alone.  Load `pmbah-mode' in
your init file so this also works after restarting Emacs."
  :type 'boolean
  :group 'pmbah)

(defconst pmbah-producer-version "0.1.1")
(defconst pmbah-format-version "0.3")

(defconst pmbah-max-session-ms 9007199254740991
  "Largest exact JSON/JavaScript integer for elapsed milliseconds in a record.")

(defconst pmbah-observation-every-n-events 50
  "Checkpoint once this many events accumulate since the last commitment.")
(defconst pmbah-observation-every-seconds 60
  "Checkpoint when new events exist and this long passed since the last attempt.")
(defconst pmbah-observation-backoff-initial-ms 1000)
(defconst pmbah-observation-backoff-max-ms 60000)
(defconst pmbah-observation-commitment-retention 32
  "Commitments kept locally: the oldest anchor plus the most recent ones.")
(defconst pmbah-observation-flush-timeout-seconds 15
  "How long `pmbah-sign-buffer' waits for the final checkpoint before uploading.")
(defconst pmbah-observation-flush-rounds 2
  "Checkpoint rounds the pre-sign flush may run to cover late-arriving events.")
(defvar pmbah-observation-request-timeout-seconds 30
  "Seconds a checkpoint attempt may take before it counts as a transient failure.")

(defvar pmbah-mode)
(defvar url-http-response-status)
(defvar url-http-end-of-headers)

(defvar-local pmbah--session-id nil)
(defvar-local pmbah--capture-enabled nil
  "Durable intent to resume capture when this file is next visited.")
(defvar-local pmbah--recovery-job nil
  "Pending background recovery; its cursor is never installed before verification.")
(defvar-local pmbah--recovery-error nil
  "Automatic recovery failure keeping this buffer read-only until addressed.")
(defvar-local pmbah--session-start-time nil)
(defvar-local pmbah--events nil
  "Bounded newest-first tail, at most 256 numeric events; the journal is authoritative.")
(defvar-local pmbah--journal-bytes 0)
(defvar-local pmbah--journal-count 0)
(defvar-local pmbah--journal-pending nil)
(defvar-local pmbah--journal-repair nil)
(defvar-local pmbah--chain-tip-byte-offset 0)
(defvar-local pmbah--chain-tip-last-time 0)
(defvar-local pmbah--frozen-byte-length nil)
(defvar-local pmbah--upload-id nil)
(defvar-local pmbah--next-seq 0)
(defvar-local pmbah--session-format nil)
(defvar-local pmbah--parent-record nil)
(defvar-local pmbah--frozen-record nil
  "Serialized manifest only; its immutable events stay in the journal prefix.")
(defvar-local pmbah--frozen-upload nil
  "Serialized small observation envelope, fixed before its first upload attempt.")
(defvar-local pmbah--uploaded-response nil)
(defvar-local pmbah--uploaded-at-ms nil)
(defvar-local pmbah--signed-duration-ms nil)
(defvar-local pmbah--signing nil)
(defvar-local pmbah--sign-job nil "Current asynchronous interactive signing operation.")
(defvar-local pmbah--read-only-lock nil)
(defvar-local pmbah--previous-read-only nil)
(defvar-local pmbah--owned-paths nil
  "Recovery paths locked by this live buffer, including while capture is off.")
(defvar-local pmbah--save-failure nil
  "Latest recovery write failure; capture stays read-only until explicitly saved.")
(defvar-local pmbah--pending-gap nil
  "Non-nil until a real mutation marks an unknown capture baseline.")
(defvar-local pmbah--observed-tick nil
  "Last observed character modification tick; never a text snapshot.")
(defvar-local pmbah--state-path nil
  "State file this buffer's session was last written to.
When the visited file is renamed, the state file moves with it.")
(defvar-local pmbah--chain-tip nil
  "Public hash-chain tip over the first `pmbah--chain-tip-event-count' events.
Checkpoints advance from it instead of rehashing the whole session.")
(defvar-local pmbah--chain-tip-event-count 0)

;; Observation state: what the server has committed to for this session.
(defvar-local pmbah--observation-state 'disabled
  "One of `disabled', `unknown', `known', `partial', or `diverged'.")
(defvar-local pmbah--observation-session-id nil
  "Server observation identity, independent of the immutable writing-session ID.
Legacy sessions use the writing-session ID until observation access is lost.")
(defvar-local pmbah--observation-token nil
  "Bearer token returned by the first successful checkpoint.")
(defvar-local pmbah--observation-committed-count 0
  "Number of leading events the server has committed to.")
(defvar-local pmbah--observation-last-attempt nil
  "`float-time' of the most recent checkpoint attempt, or nil.")
(defvar-local pmbah--observation-in-flight nil)
(defvar-local pmbah--observation-queued nil)
(defvar-local pmbah--observation-attempt 0
  "Counter identifying the current checkpoint attempt.
Callbacks and the watchdog act only when their attempt is still the current
one, so a late or duplicate result cannot touch a later attempt.")
(defvar-local pmbah--observation-request nil
  "Process or buffer of the helper or HTTP request currently in flight.")
(defvar-local pmbah--observation-watchdog nil
  "Timer that fails the in-flight attempt when it takes too long.")
(defvar-local pmbah--observation-backoff-ms 0)
(defvar-local pmbah--observation-commitments nil
  "Chronological list of commitment plists returned by the server.")
(defvar-local pmbah--observation-last-failure nil)

(defun pmbah--mode-line ()
  "Return a compact mode-line session status."
  (cond
   (pmbah--recovery-job " PMBAH:recovering")
   (pmbah--save-failure " PMBAH:save!")
   (pmbah--storage-backpressure " PMBAH:saving")
   ((and pmbah-mode pmbah--session-id)
      (format " PMBAH:%d%s" pmbah--next-seq (pmbah--observation-mode-line-mark)))
   (t " PMBAH")))

(defun pmbah--observation-mode-line-mark ()
  "Return a one-character mark for the observation state, or an empty string."
  (cond
   ((not pmbah-observe-process) "")
   ((eq pmbah--observation-state 'known) "✓")
   ((eq pmbah--observation-state 'diverged) "✗")
   (t "·")))

;;;###autoload
(define-minor-mode pmbah-mode
  "Record this buffer's mutation history as a content-blind PMBAH session.

The mode records buffer mutations, not physical keystrokes.  Uploaded records
contain event shape, public process hashes, and an optional text binding.
Plaintext is never stored or uploaded. At signing, selected text may be
passed transiently to the local helper solely to compute that binding."
  :lighter (:eval (pmbah--mode-line))
  (when pmbah--recovery-job
    ;; `define-minor-mode' changes its flag before calling this body.
    (setq pmbah-mode t)
    (user-error "PMBAH is recovering this session; wait before changing capture"))
  (if pmbah-mode
      (condition-case error
          (let ((path (and (not pmbah--session-id) (pmbah--state-file))))
            (if (and (called-interactively-p 'interactive) path (file-exists-p path))
                (pmbah--start-recovery path)
              (pmbah--begin-capture)
              (pmbah--activate-capture)))
        ((error quit)
         (let ((inhibit-quit t))
           (setq pmbah-mode nil)
           (if pmbah--recovery-error (pmbah--lock-buffer) (pmbah--unlock-buffer))
           (if pmbah--session-id
               (pmbah--reinstall-capture)
             (pmbah--release-ownership))
           (remove-hook 'before-change-functions #'pmbah--before-change t)
           (remove-hook 'after-change-functions #'pmbah--after-change t))
         (signal (car error) (cdr error))))
    (pmbah--cancel-sign-job)
    (setq pmbah--pending-gap t
          pmbah--capture-enabled nil
          pmbah--recovery-error nil)
    (pmbah--unlock-buffer)
    (remove-hook 'before-change-functions #'pmbah--before-change t)
    (remove-hook 'after-change-functions #'pmbah--after-change t)
    (pmbah--save-lifecycle)))

(defun pmbah--activate-capture ()
  "Enable hooks only after this buffer owns a verified live session."
  (setq pmbah-mode t pmbah--capture-enabled t pmbah--recovery-error nil)
  (pmbah--unlock-buffer)
  (pmbah--save-lifecycle)
  (pmbah--reinstall-capture)
  (add-hook 'kill-emacs-hook #'pmbah--write-all-state))

;; Session state outlives `kill-all-local-variables', so changing the major
;; mode or reverting the buffer keeps recording into the same session.
(defconst pmbah--session-variables '(pmbah--session-id
                    pmbah--capture-enabled
                    pmbah--session-start-time
                    pmbah--events
                    pmbah--journal-bytes
                    pmbah--journal-count
                    pmbah--journal-pending
                    pmbah--journal-repair
                    pmbah--chain-tip-byte-offset
                    pmbah--chain-tip-last-time
                    pmbah--frozen-byte-length
                    pmbah--upload-id
                    pmbah--next-seq
                    pmbah--session-format
                    pmbah--parent-record
                    pmbah--frozen-record
                    pmbah--frozen-upload
                    pmbah--uploaded-response
                    pmbah--uploaded-at-ms
                    pmbah--signed-duration-ms
                    pmbah--signing
                    pmbah--sign-job
                    pmbah--read-only-lock
                    pmbah--previous-read-only
                    pmbah--owned-paths
                    pmbah--save-failure
                    pmbah--pending-gap
                    pmbah--observed-tick
                    pmbah--state-path
                    pmbah--chain-tip
                    pmbah--chain-tip-event-count
                    pmbah--observation-state
                    pmbah--observation-session-id
                    pmbah--observation-token
                    pmbah--observation-committed-count
                    pmbah--observation-last-attempt
                    pmbah--observation-in-flight
                    pmbah--observation-queued
                    pmbah--observation-attempt
                    pmbah--observation-request
                    pmbah--observation-watchdog
                    pmbah--observation-backoff-ms
                    pmbah--observation-commitments
                    pmbah--observation-last-failure)
  "Buffer-local state installed together after successful recovery.")

(dolist (variable (append '(pmbah-mode pmbah--recovery-error pmbah--recovery-job
                           pmbah--writer pmbah--writer-ready pmbah--writer-credit
                           pmbah--writer-request pmbah--writer-retry
                           pmbah--writer-dirty pmbah--writer-timer pmbah--writer-watchdog
                           pmbah--writer-output pmbah--storage-backpressure)
                         pmbah--session-variables))
  (put variable 'permanent-local t))

(defun pmbah--reinstall-capture ()
  "Restore capture and session lifecycle hooks after a major-mode change."
  (when pmbah--recovery-job
    (pmbah--lock-buffer)
    (add-hook 'kill-buffer-hook #'pmbah--cancel-recovery nil t))
  ;; Paused sessions still own their recovery files and must follow renames.
  (when (and (local-variable-p 'pmbah--session-id) pmbah--session-id)
    (add-hook 'after-set-visited-file-name-hook #'pmbah--follow-visited-file nil t)
    (add-hook 'kill-buffer-query-functions #'pmbah--can-close-buffer nil t)
    (remove-hook 'kill-buffer-hook #'pmbah--write-state t)
    (add-hook 'kill-buffer-hook #'pmbah--close-storage nil t)
    (add-hook 'kill-buffer-hook #'pmbah--cancel-sign-job nil t)
    (add-hook 'kill-buffer-hook #'pmbah--observation-abandon-attempt nil t)
    (add-hook 'kill-buffer-hook #'pmbah--release-ownership t t))
  (when (and (local-variable-p 'pmbah--recovery-error) pmbah--recovery-error)
    (pmbah--lock-buffer))
  (when (and pmbah-mode pmbah--session-id)
    (when (or pmbah--signing pmbah--frozen-record pmbah--save-failure pmbah--storage-backpressure)
      (pmbah--lock-buffer))
    (pmbah--check-capture-gap)
    (add-hook 'before-change-functions #'pmbah--before-change nil t)
    (add-hook 'before-revert-hook #'pmbah--mark-capture-gap nil t)
    (add-hook 'after-change-functions #'pmbah--after-change nil t)))

(defun pmbah--mark-capture-gap ()
  "Mark a boundary whose intervening changes may not have been observed."
  (when pmbah--session-id
    (setq pmbah--pending-gap t)))

(defun pmbah--check-capture-gap ()
  "Detect changes made while the capture hooks were suppressed."
  (when (and pmbah--observed-tick
             (/= pmbah--observed-tick (buffer-chars-modified-tick)))
    (pmbah--mark-capture-gap)))

(defun pmbah--before-change (_beg _end)
  "Check continuity before the next observed character change."
  ;; Do not throw from modification hooks: Emacs removes a failing hook.
  ;; `buffer-read-only' blocks ordinary edits before hooks run. Deliberate
  ;; inhibit-read-only edits remain private and cannot alter the sealed record.
  (when (and pmbah-mode (not pmbah--signing) (not pmbah--frozen-record))
    (pmbah--check-capture-gap)))

(defun pmbah--lock-buffer ()
  "Prevent ordinary edits while building or retaining a frozen record."
  (unless pmbah--read-only-lock
    (setq pmbah--previous-read-only buffer-read-only
          pmbah--read-only-lock t))
  (setq buffer-read-only t))

(defun pmbah--unlock-buffer ()
  "Restore the buffer's read-only setting from before PMBAH locked it."
  (when pmbah--read-only-lock
    (setq buffer-read-only pmbah--previous-read-only
          pmbah--read-only-lock nil
          pmbah--previous-read-only nil)))

(defun pmbah--begin-capture ()
  "Continue this buffer's session, resume it from disk, or start fresh."
  (unless pmbah--session-id
    (let* ((path (pmbah--state-file))
           (_lock (when path (pmbah--claim-state path)))
           (state (and path (file-exists-p path) (pmbah--read-state path)))
           (blocker (and path (file-exists-p path) (pmbah--state-resume-blocker state))))
      (cond
       (blocker (user-error "Cannot recover saved session: %s" blocker))
       (state (pmbah--resume-session state path))
       (t (pmbah--start-session))))))

(defun pmbah--auto-resume ()
  "Verify an opted-in file session in a worker without blocking Emacs."
  (when (and pmbah-auto-resume buffer-file-name
             (not (buffer-base-buffer)) (not pmbah-mode)
             (not pmbah--session-id) (not pmbah--recovery-job))
    (let ((path (pmbah--preferred-state-file)))
      (when (file-exists-p path)
        (condition-case error
            (pmbah--start-recovery path t)
          ((error quit)
           (unless pmbah--recovery-error
             (pmbah--recovery-failed (error-message-string error)))))))))

(defun pmbah--start-recovery (path &optional automatic)
  "Start background recovery from PATH, respecting paused state when AUTOMATIC."
  (when (or pmbah--recovery-job pmbah--session-id)
    (user-error "This buffer already owns a PMBAH session"))
  (setq pmbah--recovery-job (list :token (pmbah--uuid-v4) :path path :automatic automatic)
        pmbah--recovery-error nil
        pmbah-mode t)
  (pmbah--lock-buffer)
  (pmbah--reinstall-capture)
  (condition-case error
      (progn
        (unless automatic
          (pmbah--claim-state path)
          (setq pmbah--recovery-job (plist-put pmbah--recovery-job :claimed t)))
        (pmbah--start-recovery-helper (if automatic 'probe 'metadata)
                                      (list :operation "read-recovery" :state_path path
                                            :skip_paused (if automatic t :json-false)))
        (message "PMBAH is recovering %s; this buffer stays read-only until verification finishes" (buffer-name)))
    ((error quit)
     (pmbah--recovery-failed (error-message-string error))
     (signal (car error) (cdr error)))))

(defun pmbah--start-recovery-helper (stage payload)
  "Run one recovery STAGE with PAYLOAD under the current job token."
  (setq pmbah--recovery-job (plist-put pmbah--recovery-job :stage stage))
  (let* ((token (plist-get pmbah--recovery-job :token))
         (process (pmbah--run-node-script-async
                   pmbah-helper-script payload
                   (apply-partially #'pmbah--recovery-result (current-buffer) token stage))))
    (when (and (equal token (plist-get pmbah--recovery-job :token))
               (eq stage (plist-get pmbah--recovery-job :stage)))
      (setq pmbah--recovery-job (plist-put pmbah--recovery-job :process process)))))

(defun pmbah--cancel-recovery ()
  "Invalidate callbacks and stop the worker before releasing its file ownership."
  (let ((job pmbah--recovery-job) (inhibit-quit t))
    (setq pmbah--recovery-job nil)
    (when job
      (when (process-live-p (plist-get job :process))
        (delete-process (plist-get job :process)))
      (unwind-protect
          (let ((temporary (plist-get job :migration-path)))
            (when (and temporary (file-exists-p temporary))
              (condition-case error (delete-file temporary)
                (error (message "PMBAH could not remove interrupted migration staging: %s"
                                (error-message-string error))))))
        (unless pmbah--session-id (pmbah--release-ownership))))))

(defun pmbah--cancel-all-recoveries ()
  "Stop recovery workers before Emacs releases its file locks on exit."
  (dolist (buffer (buffer-list))
    (when (buffer-live-p buffer)
      (with-current-buffer buffer
        (when pmbah--recovery-job (pmbah--cancel-recovery))))))

(defun pmbah--recovery-failed (failure)
  "Keep this buffer protected and its saved history untouched after FAILURE."
  (pmbah--cancel-recovery)
  (setq pmbah-mode nil pmbah--recovery-error failure)
  (pmbah--lock-buffer)
  (display-warning
   'pmbah
   (format "Could not recover %s: %s. Buffer is read-only. Retry with M-x pmbah-mode; use C-u -1 M-x pmbah-mode to edit without recording. Saved history is retained."
           (buffer-name) failure)
   :warning))

(defun pmbah--recovery-result (buffer token stage result failure)
  "Install a verified RESULT only while BUFFER still owns recovery TOKEN."
  (when (buffer-live-p buffer)
    (with-current-buffer buffer
      (when (and (equal token (plist-get pmbah--recovery-job :token))
                 (eq stage (plist-get pmbah--recovery-job :stage)))
        (condition-case error
            (progn
              (when failure (error "%s" failure))
              (if (memq stage '(probe metadata))
                  (let ((state (json-parse-string (pmbah--json-encode result)
                                                :object-type 'plist :array-type 'list
                                                :null-object nil :false-object :json-false)))
                    (cond
                     ((and (plist-get pmbah--recovery-job :automatic)
                           (eq (plist-get state :capture_enabled) :json-false))
                      (pmbah--cancel-recovery)
                      (setq pmbah-mode nil)
                      (pmbah--unlock-buffer))
                     ((not (plist-get pmbah--recovery-job :claimed))
                      ;; The unowned probe only decides whether to opt in. Read
                      ;; again after locking so verification uses owned metadata.
                      (let ((path (plist-get pmbah--recovery-job :path)))
                        (pmbah--claim-state path)
                        (setq pmbah--recovery-job (plist-put pmbah--recovery-job :claimed t))
                        (pmbah--start-recovery-helper 'metadata
                                                      (list :operation "read-recovery" :state_path path :skip_paused t))))
                     (t
                      (let ((blocker (pmbah--state-resume-blocker state)))
                        (when blocker (user-error "Saved session %s" blocker)))
                      (pmbah--assert-session-owner (plist-get state :session_id))
                      (let ((payload (pmbah--recovery-payload state (plist-get pmbah--recovery-job :path))))
                        (pmbah--claim-state (plist-get payload :journal_path))
                        (setq pmbah--recovery-job (plist-put pmbah--recovery-job :state state))
                        (when (plist-get payload :legacy_state_path)
                          (setq pmbah--recovery-job
                                (plist-put pmbah--recovery-job :migration-path
                                           (concat (plist-get payload :journal_path) ".migrating"))))
                        ;; Only the final metadata transaction may repair a partial
                        ;; suffix; an interrupted background scan never changes it.
                        (setq payload (plist-put payload :repair_tail :json-false))
                        (pmbah--start-recovery-helper 'inspect payload)))))
                (pmbah--resume-session (plist-get pmbah--recovery-job :state)
                                       (plist-get pmbah--recovery-job :path) result)
                ;; There is no yielding work between installation and activation.
                (let ((inhibit-quit t))
                  (setq pmbah--recovery-job nil)
                  (pmbah--activate-capture)
                  (when buffer-file-name (pmbah--follow-visited-file)))
                (message "PMBAH recovered %d events for %s%s" pmbah--next-seq (buffer-name)
                         (if pmbah--frozen-record "; signing retry is available" ""))))
          ((error quit) (pmbah--recovery-failed (error-message-string error))))))))

(defun pmbah--start-session (&optional parent-record start-ms)
  "Start a fresh per-buffer PMBAH session."
  (when pmbah--recovery-job (user-error "Wait for PMBAH recovery before starting a session"))
  (pmbah--drain-writer)
  (pmbah--cancel-sign-job)
  (let ((previous-path pmbah--state-path)
        (previous-session pmbah--session-id))
    (pmbah--unlock-buffer)
    (setq pmbah--session-id (pmbah--uuid-v4)
          pmbah--session-start-time (if start-ms (pmbah--ms-to-time start-ms) (current-time))
          pmbah--state-path nil
          pmbah--parent-record parent-record
          pmbah--events nil
          pmbah--journal-bytes 0
          pmbah--journal-count 0
          pmbah--journal-pending nil
          pmbah--journal-repair nil
          pmbah--chain-tip-byte-offset 0
          pmbah--chain-tip-last-time 0
          pmbah--frozen-byte-length nil
          pmbah--upload-id nil
          pmbah--next-seq 0
          pmbah--session-format pmbah-format-version
          pmbah--frozen-record nil
          pmbah--frozen-upload nil
          pmbah--uploaded-response nil
          pmbah--uploaded-at-ms nil
          pmbah--signed-duration-ms nil
          pmbah--save-failure nil
          pmbah--pending-gap (save-restriction (widen) (> (buffer-size) 0))
          pmbah--observed-tick (buffer-chars-modified-tick)
          pmbah--chain-tip nil
          pmbah--chain-tip-event-count 0)
    (pmbah--observation-reset)
    (let* ((preferred (pmbah--preferred-state-file))
           (existing (and (file-exists-p preferred) (pmbah--read-state preferred))))
      (setq pmbah--state-path
            (if (and buffer-file-name (file-exists-p preferred)
                     (not (equal (plist-get existing :session_id) previous-session)))
                (or previous-path
                    (expand-file-name (concat "session-" pmbah--session-id ".json") pmbah-state-directory))
              preferred)))
    (pmbah--claim-state pmbah--state-path)
    (pmbah--claim-state (pmbah--journal-file))
    (pmbah--release-ownership (list pmbah--state-path (pmbah--journal-file)))))

(defun pmbah--resume-session (state &optional recovery-path scan)
  "Validate STATE in isolated bindings, then install its recovered session.
Errors and quits leave the original live state intact, so another enable
must repeat recovery rather than append with a partially installed cursor."
  (let ((blocker (pmbah--state-resume-blocker state)))
    (when blocker (user-error "Cannot recover saved session: %s" blocker)))
  (pmbah--assert-session-owner (plist-get state :session_id))
  (let ((original (mapcar #'symbol-value pmbah--session-variables))
        (owned pmbah--owned-paths)
        recovered committed)
    (unwind-protect
        (progn
          (cl-progv pmbah--session-variables original
            (let ((pmbah-mode nil))
              (unwind-protect
                  (progn
                    (pmbah--resume-session-verified state recovery-path scan)
                    (setq recovered (mapcar #'symbol-value pmbah--session-variables)))
                (unless recovered (pmbah--release-ownership owned)))))
          ;; The validated state and its lock ownership become visible together.
          (let ((inhibit-quit t))
            (cl-mapc #'set pmbah--session-variables recovered)
            (pmbah--release-ownership (list pmbah--state-path (pmbah--journal-file)))
            (setq committed t)))
      (when (and recovered (not committed))
        (let ((pmbah--owned-paths
               (nth (cl-position 'pmbah--owned-paths pmbah--session-variables) recovered)))
          (pmbah--release-ownership owned))))))

(defun pmbah--resume-session-verified (state recovery-path verified-scan)
  "Recover STATE into the caller's isolated session bindings."

  (let ((legacy (not (equal (plist-get state :storage_version) 2)))
        (observation (plist-get state :observation)))
    (setq pmbah--session-id (plist-get state :session_id)
          pmbah--capture-enabled (not (eq (plist-get state :capture_enabled) :json-false))
          pmbah--session-start-time (pmbah--ms-to-time (plist-get state :session_start_ms))
          pmbah--session-format (plist-get state :format_version)
          pmbah--parent-record (plist-get state :parent_record)
          pmbah--frozen-record (plist-get state :frozen_record)
          pmbah--frozen-upload (plist-get state :frozen_upload)
          pmbah--frozen-byte-length (plist-get state :frozen_byte_length)
          pmbah--upload-id (plist-get state :upload_id)
          pmbah--uploaded-response (plist-get state :uploaded_response)
          pmbah--uploaded-at-ms (plist-get state :uploaded_at_ms)
          pmbah--signed-duration-ms (plist-get state :signed_duration_ms)
          pmbah--save-failure (plist-get state :save_failure)
          pmbah--pending-gap t
          pmbah--observed-tick (buffer-chars-modified-tick)
          pmbah--journal-pending nil
          pmbah--journal-repair nil
          pmbah--state-path (or recovery-path (pmbah--preferred-state-file)))
    (pmbah--claim-state pmbah--state-path)
    (pmbah--claim-state (pmbah--journal-file))
    (let* ((scan (or verified-scan
                     (pmbah--journal-helper (pmbah--recovery-payload state pmbah--state-path))))
           (count (alist-get 'event_count scan)))
      (setq pmbah--next-seq count
            pmbah--journal-count count
            pmbah--journal-bytes (alist-get 'byte_length scan)
            pmbah--chain-tip (alist-get 'chain_tip scan)
            pmbah--chain-tip-event-count count
            pmbah--chain-tip-byte-offset pmbah--journal-bytes
            pmbah--chain-tip-last-time (alist-get 'last_t scan)
            pmbah--events (reverse (json-parse-string (pmbah--json-encode (alist-get 'tail scan))
                                                     :object-type 'plist :array-type 'list :null-object nil :false-object :json-false))))
    (when (and verified-scan
               (> (file-attribute-size (file-attributes (pmbah--journal-file))) pmbah--journal-bytes))
      (setq pmbah--journal-repair t))
    (when pmbah--frozen-record
      (let ((manifest (alist-get 'manifest (pmbah--parse-public-json pmbah--frozen-record))))
        (unless (= (alist-get 'event_count manifest) pmbah--next-seq)
          (user-error "Frozen record does not match its journal prefix"))
        (setq pmbah--frozen-record (pmbah--json-encode (list (cons 'manifest manifest)))
              pmbah--frozen-byte-length pmbah--journal-bytes
              pmbah--upload-id (or pmbah--upload-id (pmbah--uuid-v4))))
      (when (and legacy pmbah--frozen-upload)
        (setq pmbah--frozen-upload
              (pmbah--json-encode
               (list (cons 'observation
                           (alist-get 'observation (pmbah--parse-public-json pmbah--frozen-upload))))))))
    (pmbah--observation-reset)
    (setq pmbah--observation-session-id (or (plist-get observation :observed_session_id)
                                           pmbah--session-id)
          pmbah--observation-token (plist-get observation :token)
          pmbah--observation-committed-count (or (plist-get observation :committed_event_count) 0)
          pmbah--observation-commitments (plist-get observation :commitments)
          pmbah--observation-last-failure (plist-get observation :last_failure))
    (when (equal (plist-get observation :state) "diverged") (setq pmbah--observation-state 'diverged))
    (pmbah--observation-recompute-state)
    ;; Publish the new small metadata only after migration and verification succeed.
    (pmbah--write-state t)))

(defun pmbah--recovery-payload (state path)
  "Validate small STATE metadata and describe its full verification at PATH."
  (let ((blocker (pmbah--state-resume-blocker state)))
    (when blocker (user-error "Cannot recover saved session: %s" blocker)))
  (let* ((legacy (not (equal (plist-get state :storage_version) 2)))
         (frozen (plist-get state :frozen_record))
         (manifest (when frozen (alist-get 'manifest (pmbah--parse-public-json frozen)))))
    (unless legacy
      (unless (and (integerp (plist-get state :event_count)) (>= (plist-get state :event_count) 0)
                   (integerp (plist-get state :journal_bytes)) (>= (plist-get state :journal_bytes) 0))
        (user-error "Recovery metadata has an invalid acknowledged journal prefix")))
    (when (and (not (plist-get state :chain_tip))
               (not (zerop (or (plist-get state :chain_tip_event_count) 0))))
      (user-error "Recovery metadata has no hash for its cached prefix"))
    (when (and frozen (not manifest)) (user-error "Recovery metadata has no frozen manifest"))
    (append
     (list :operation "inspect"
           :journal_path (expand-file-name (concat "events-" (plist-get state :session_id) ".jsonl")
                                          pmbah-state-directory)
           :session_id (plist-get state :session_id) :format_version (plist-get state :format_version)
           :acknowledged_event_count (if legacy
                                        (or (plist-get state :legacy_event_count) (length (plist-get state :events)))
                                      (plist-get state :event_count))
           :chain_anchor (when (plist-get state :chain_tip)
                           (append (list :event_count (plist-get state :chain_tip_event_count)
                                         :chain_tip (plist-get state :chain_tip))
                                   (unless legacy
                                     (list :byte_length (plist-get state :chain_tip_byte_offset)
                                           :last_t (plist-get state :chain_tip_last_time)))))
           :observation_anchors (vconcat (plist-get (plist-get state :observation) :commitments))
           :frozen_manifest manifest :frozen_byte_length (plist-get state :frozen_byte_length)
           :repair_tail t)
     (if legacy (list :legacy_state_path path)
       (list :acknowledged_byte_length (plist-get state :journal_bytes))))))

(defun pmbah--state-resume-blocker (state)
  "Return why the STATE plist cannot be resumed, or nil when it can."
  (cond
   ((not (and state
              (stringp (plist-get state :session_id))
              (let ((case-fold-search nil))
                (string-match-p "\\`[0-9a-f]\\{8\\}-[0-9a-f]\\{4\\}-4[0-9a-f]\\{3\\}-[89ab][0-9a-f]\\{3\\}-[0-9a-f]\\{12\\}\\'"
                                (plist-get state :session_id)))
              (integerp (plist-get state :session_start_ms))
              (or (equal (plist-get state :storage_version) 2)
                  (listp (plist-get state :events)))))
    "could not be read")
   ((not (member (plist-get state :format_version) '("0.1" "0.2" "0.3")))
    (format "was recorded as format %s, not %s"
            (plist-get state :format_version) pmbah-format-version))
   ((and (plist-member state :capture_enabled)
         (not (memq (plist-get state :capture_enabled) '(t :json-false))))
    "has an invalid capture preference")
   ((let ((id (plist-get (plist-get state :observation) :observed_session_id)))
      (and id (not (and (stringp id)
                       (let ((case-fold-search nil))
                         (string-match-p "\\`[0-9a-f]\\{8\\}-[0-9a-f]\\{4\\}-4[0-9a-f]\\{3\\}-[89ab][0-9a-f]\\{3\\}-[0-9a-f]\\{12\\}\\'" id))))))
    "has an invalid observation session identity")
   ((and (not (plist-get state :frozen_record))
         (>= (- (pmbah--time-to-ms (current-time)) (plist-get state :session_start_ms))
             pmbah-max-session-ms))
    "exceeds the exact integer range for a record clock")
   (t nil)))

(defun pmbah--retire-state-file (path reason)
  "Archive PATH under a unique name, or signal if history cannot be retained."
  (let ((stale-path (make-temp-name (concat path ".stale-"))))
    (rename-file path stale-path)
    (message "PMBAH: the saved session for %s %s; old state kept at %s"
             (file-name-nondirectory (or buffer-file-name (buffer-name)))
             reason stale-path)))

(defun pmbah--retire-live-session ()
  "Set aside an expired clock only after its history is durably retained."
  (let ((path (pmbah--state-file)))
    (unless (and path pmbah--session-id) (user-error "No PMBAH session to retire"))
    (pmbah--write-state t)
    (pmbah--retire-state-file path "reached the most a record's clock can hold")
    (pmbah--start-session)))

;;; Session state on disk
;;
;; File-visiting buffers keep their session in `pmbah-state-directory' so a
;; writer who closes the file, or Emacs, and returns later continues the
;; same session. Interactive mutations enqueue a bounded numeric event; a worker
;; acknowledges journal and metadata durability without blocking keyboard input.
;; State also saves on buffer/Emacs close, mode disable, and checkpoint outcomes
;; (the observation token must not be lost).

(defun pmbah--state-file ()
  "Return the authoritative recovery path, including a retained rename source."
  (or pmbah--state-path (pmbah--preferred-state-file)))

(defun pmbah--preferred-state-file ()
  "Return the file-keyed or non-file session-keyed recovery path."
  (cond
   (buffer-file-name
    (expand-file-name (concat (secure-hash 'sha256 (file-truename buffer-file-name)) ".json")
                      pmbah-state-directory))
   (pmbah--session-id
    (expand-file-name (concat "session-" pmbah--session-id ".json") pmbah-state-directory))))

(defun pmbah--state-snapshot ()
  "Return the JSON-serializable session state for this buffer."
  (list :session_id pmbah--session-id
        :capture_enabled (if pmbah--capture-enabled t :json-false)
        :session_start_ms (pmbah--time-to-ms pmbah--session-start-time)
        :format_version pmbah--session-format
        :parent_record pmbah--parent-record
        :storage_version 2
        :event_count pmbah--journal-count
        :journal_bytes pmbah--journal-bytes
        :frozen_byte_length pmbah--frozen-byte-length
        :upload_id pmbah--upload-id
        :pending_gap (if pmbah--pending-gap t :json-false)
        :frozen_record pmbah--frozen-record
        :frozen_upload pmbah--frozen-upload
        :uploaded_response pmbah--uploaded-response
        :uploaded_at_ms pmbah--uploaded-at-ms
        :signed_duration_ms pmbah--signed-duration-ms
        :save_failure pmbah--save-failure
        :chain_tip pmbah--chain-tip
        :chain_tip_event_count pmbah--chain-tip-event-count
        :chain_tip_byte_offset pmbah--chain-tip-byte-offset
        :chain_tip_last_time pmbah--chain-tip-last-time
        :observation (list :state (symbol-name pmbah--observation-state)
                           :observed_session_id (or pmbah--observation-session-id pmbah--session-id)
                           :last_failure pmbah--observation-last-failure
                           :token pmbah--observation-token
                           :committed_event_count pmbah--observation-committed-count
                           :commitments (vconcat pmbah--observation-commitments))))

(defun pmbah--journal-file ()
  "Return this session's stable append-only numeric event journal path."
  (expand-file-name (concat "events-" pmbah--session-id ".jsonl") pmbah-state-directory))

(defun pmbah--journal-helper (payload)
  "Run a bounded-memory local operation over the numeric journal."
  (pmbah--run-helper payload))

(defun pmbah--flush-journal ()
  "Durably append only new numeric events, retaining an unacknowledged event on failure."
  (let ((path (pmbah--journal-file))
        (coding-system-for-write 'utf-8-unix)
        (write-region-inhibit-fsync nil))
    (pmbah--claim-state path)
    (unless (file-exists-p path)
      (with-file-modes #o600 (write-region "" nil path nil 'silent)))
    (when pmbah--journal-repair
      (pmbah--journal-helper (list :operation "truncate" :journal_path path :byte_length pmbah--journal-bytes))
      (setq pmbah--journal-repair nil))
    (while pmbah--journal-pending
      (let* ((event (car (last pmbah--journal-pending)))
             (line (concat (pmbah--json-encode event) "\n"))
             (next-bytes (+ pmbah--journal-bytes (string-bytes line)))
             (next-count (1+ pmbah--journal-count))
             (remaining (butlast pmbah--journal-pending)))
        (condition-case error
            ;; The append and its acknowledged cursor are one local operation.
            ;; Defer keyboard quits until all three cursor fields agree.  An
            ;; interrupted write itself still has uncertain effects and must
            ;; be repaired back to the last acknowledged byte before retry.
            (let ((inhibit-quit t))
              (write-region line nil path t 'silent)
              (setq pmbah--journal-bytes next-bytes
                    pmbah--journal-count next-count
                    pmbah--journal-pending remaining))
          ((error quit)
           (setq pmbah--journal-repair t)
           (signal (car error) (cdr error))))))))

(defun pmbah--assert-session-owner (session-id)
  "Reject a SESSION-ID already retained by another live buffer."
  (let ((current (current-buffer)))
    (dolist (buffer (buffer-list))
      (unless (eq buffer current)
        (with-current-buffer buffer
          (when (and session-id (equal session-id pmbah--session-id))
            (user-error "PMBAH session is already owned by buffer %s" (buffer-name))))))))

(defun pmbah--claim-state (path)
  "Exclusively claim PATH for this buffer without offering to steal a lock."
  (unless (member path pmbah--owned-paths)
    (let ((current (current-buffer))
          (directory (file-name-directory path)))
      (dolist (buffer (buffer-list))
        (unless (eq current buffer)
          (with-current-buffer buffer
            (when (member path pmbah--owned-paths)
              (user-error "PMBAH recovery is already owned by buffer %s" (buffer-name))))))
      (unless (file-directory-p directory)
        (make-directory directory t)
        (set-file-modes directory #o700))
      (let ((create-lockfiles t))
        (cl-letf (((symbol-function 'ask-user-about-lock)
                   (lambda (&rest _)
                     (user-error "PMBAH recovery is already owned by another Emacs process: %s" path))))
          (lock-file path)))
      (unless (eq (file-locked-p path) t)
        (user-error "Could not acquire PMBAH recovery lock: %s" path))
      (push path pmbah--owned-paths))))

(defun pmbah--release-ownership (&optional keep)
  "Release recovery locks except KEEP, a path or list of paths."
  (let ((paths (if (listp keep) keep (list keep))))
    (dolist (path pmbah--owned-paths)
      (unless (member path paths) (unlock-file path)))
    (setq pmbah--owned-paths (cl-intersection pmbah--owned-paths paths :test #'equal))))

(defun pmbah--write-json-file (path json)
  "Atomically write JSON to private PATH, signalling storage failures."
  (let ((directory (file-name-directory path))
        (temp-path (concat path ".tmp"))
        (coding-system-for-write 'utf-8)
        (write-region-inhibit-fsync nil))
    (unless (file-directory-p directory)
      (make-directory directory t)
      (set-file-modes directory #o700))
    (unwind-protect
        (progn
          (with-file-modes #o600 (with-temp-file temp-path (insert json)))
          (rename-file temp-path path t))
      (when (file-exists-p temp-path) (delete-file temp-path)))))

(defun pmbah--schedule-storage ()
  "Mark metadata dirty and schedule bounded background work for this buffer."
  (when pmbah--session-id
    (setq pmbah--writer-dirty t)
    (pmbah--schedule-storage-pump)))

(defun pmbah--schedule-storage-pump ()
  "Schedule one bounded transport step without dirtying the metadata."
  (unless (or pmbah--writer-timer pmbah--save-failure pmbah--writer-draining)
    (let ((buffer (current-buffer)))
      (setq pmbah--writer-timer
            (run-with-timer
             0 nil (lambda ()
                     (when (buffer-live-p buffer)
                       (with-current-buffer buffer
                         (setq pmbah--writer-timer nil)
                         (pmbah--pump-storage)))))))))

(defun pmbah--arm-writer-watchdog ()
  "Bound startup and one storage request, including transport time."
  (when (timerp pmbah--writer-watchdog) (cancel-timer pmbah--writer-watchdog))
  (let ((buffer (current-buffer)) (process pmbah--writer))
    (setq pmbah--writer-watchdog
          (run-with-timer
           pmbah--writer-timeout nil
           (lambda ()
             (when (buffer-live-p buffer)
               (with-current-buffer buffer
                 (when (eq process pmbah--writer)
                   (pmbah--storage-failed "Timed out saving the event journal")))))))))

(defun pmbah--stop-writer ()
  "Stop this buffer's worker after draining, or after retaining a failed request."
  (when (timerp pmbah--writer-timer) (cancel-timer pmbah--writer-timer))
  (when (timerp pmbah--writer-watchdog) (cancel-timer pmbah--writer-watchdog))
  (setq pmbah--writer-timer nil pmbah--writer-watchdog nil)
  (let ((process pmbah--writer))
    ;; Invalidate callbacks before deleting the process.
    (setq pmbah--writer nil pmbah--writer-output ""
          pmbah--writer-ready nil pmbah--writer-credit nil)
    (when (processp process) (delete-process process))))

(defun pmbah--storage-failed (reason)
  "Retain the exact uncertain request for idempotent retry, then stop capture."
  (when pmbah--writer-request
    (setq pmbah--writer-retry pmbah--writer-request))
  (setq pmbah--writer-request nil pmbah--writer-dirty t)
  (pmbah--stop-writer)
  (pmbah--mark-save-failure (list 'error reason)))

(defun pmbah--start-writer ()
  "Lazily start one persistent worker for this buffer, outside modification hooks."
  (unless (process-live-p pmbah--writer)
    (let ((buffer (current-buffer)))
      (setq pmbah--writer-ready nil pmbah--writer-credit nil
            pmbah--writer-output ""
            pmbah--writer
            (make-process
             :name "pmbah-storage" :buffer nil :noquery t
             :command (list pmbah-node-command pmbah-writer-script)
             :coding 'utf-8-unix :connection-type 'pipe
             :filter (lambda (process output)
                       (when (buffer-live-p buffer)
                         (with-current-buffer buffer
                           (when (eq process pmbah--writer)
                             (pmbah--storage-output output)))))
             :sentinel (lambda (process _event)
                         (when (and (buffer-live-p buffer)
                                    (memq (process-status process) '(exit signal failed)))
                           (with-current-buffer buffer
                             (when (eq process pmbah--writer)
                               (pmbah--storage-failed "Background storage worker exited"))))))))
    (pmbah--arm-writer-watchdog)))

(defun pmbah--pump-storage ()
  "Start storage or send one credited frame; never fill a worker's input pipe."
  (unless (or pmbah--save-failure (not pmbah--session-id))
    (when (or pmbah--writer-request pmbah--writer-retry pmbah--journal-pending pmbah--writer-dirty)
      (condition-case error
          (progn
            (pmbah--start-writer)
            (when pmbah--writer-ready
              (unless pmbah--writer-request
                (let* ((events (reverse pmbah--journal-pending))
                       (path (pmbah--state-file)) (journal (pmbah--journal-file)))
                  (pmbah--claim-state path)
                  (pmbah--claim-state journal)
                  (setq pmbah--writer-request
                        (or (and pmbah--writer-retry
                                 (plist-put (copy-sequence pmbah--writer-retry) :offset 0))
                            (let* ((id (cl-incf pmbah--writer-sequence))
                                   (bytes (+ pmbah--journal-bytes
                                             (cl-loop for event in events
                                                      sum (1+ (string-bytes (pmbah--json-encode event)))))))
                              (list :id id :count (length events) :offset 0
                                    :event-count (+ pmbah--journal-count (length events))
                                    :byte-length bytes
                                    :payload (pmbah--json-encode
                                              (list :id id :state_path path :journal_path journal
                                                    :expected_bytes pmbah--journal-bytes
                                                    :expected_count pmbah--journal-count
                                                    :events (vconcat events) :state (pmbah--state-snapshot)))))))
                  ;; An exact retry uses old metadata. Always follow it with
                  ;; the current snapshot, even if no additional edit arrived.
                  (setq pmbah--writer-dirty (and pmbah--writer-retry t)
                        pmbah--writer-retry nil)
                  (pmbah--arm-writer-watchdog)))
              (when pmbah--writer-credit
                (let* ((request pmbah--writer-request)
                       (payload (plist-get request :payload))
                       (start (plist-get request :offset))
                       (end (min (length payload) (+ start 1024))) frame)
                  (while (progn
                           (setq frame (concat
                                        (pmbah--json-encode
                                         (list :id (plist-get request :id)
                                               :chunk (substring payload start end)
                                               :final (if (= end (length payload)) t :json-false)))
                                        "\n"))
                           (> (string-bytes frame) 4096))
                    (setq end (+ start (/ (- end start) 2))))
                  (setq pmbah--writer-credit nil
                        pmbah--writer-request (plist-put request :offset end))
                  (process-send-string pmbah--writer frame)))))
        ((error quit) (pmbah--storage-failed (error-message-string error)))))))

(defun pmbah--storage-output (output)
  "Consume bounded worker replies, including fragmented transport messages."
  (condition-case error
      (progn
        (setq pmbah--writer-output (concat pmbah--writer-output output))
        (when (> (length pmbah--writer-output) 8192)
          (error "Storage worker returned an oversized reply"))
        (let (newline)
          (while (setq newline (string-match "\n" pmbah--writer-output))
            (let ((reply (pmbah--parse-public-json (substring pmbah--writer-output 0 newline))))
              (setq pmbah--writer-output (substring pmbah--writer-output (1+ newline)))
              (pmbah--storage-reply reply)))))
    ((error quit) (pmbah--storage-failed (error-message-string error)))))

(defun pmbah--storage-reply (reply)
  "Handle readiness, transport credit, or an atomic durable acknowledgement."
  (cond
   ((eq (alist-get 'ready reply) t)
    (when (or pmbah--writer-ready pmbah--writer-request)
      (error "Storage worker returned unexpected readiness"))
    (when (timerp pmbah--writer-watchdog) (cancel-timer pmbah--writer-watchdog))
    (setq pmbah--writer-watchdog nil pmbah--writer-ready t pmbah--writer-credit t)
    (pmbah--schedule-storage-pump))
   (t
    (let ((request pmbah--writer-request))
      (unless (and request (equal (alist-get 'id reply) (plist-get request :id)))
        (error "Storage worker replied to an unexpected request"))
      (if (eq (alist-get 'credit reply) t)
          (progn
            (when (or pmbah--writer-credit
                      (>= (plist-get request :offset) (length (plist-get request :payload))))
              (error "Storage worker returned unexpected transport credit"))
            (setq pmbah--writer-credit t)
            (pmbah--schedule-storage-pump))
        (unless (and (eq (alist-get 'ok reply) t)
                     (= (plist-get request :offset) (length (plist-get request :payload))))
          (error "%s" (or (alist-get 'error reply) "Background save failed")))
        (unless (and (eql (alist-get 'event_count reply) (plist-get request :event-count))
                     (eql (alist-get 'byte_length reply) (plist-get request :byte-length)))
          (error "Storage worker acknowledged an unexpected journal prefix"))
        (when (timerp pmbah--writer-watchdog) (cancel-timer pmbah--writer-watchdog))
        (let ((inhibit-quit t))
          ;; Queue ownership and durable cursors commit together. Keyboard
          ;; quits must never make an exact retry remove the same events twice.
          (setq pmbah--writer-watchdog nil
                pmbah--journal-pending (butlast pmbah--journal-pending (plist-get request :count))
                pmbah--journal-count (alist-get 'event_count reply)
                pmbah--journal-bytes (alist-get 'byte_length reply)
                pmbah--journal-repair nil pmbah--writer-request nil
                pmbah--writer-credit t))
        (when (and pmbah--storage-backpressure
                   (< (- pmbah--next-seq pmbah--journal-count) pmbah--pending-event-limit))
          (setq pmbah--storage-backpressure nil)
          (unless (or pmbah--save-failure pmbah--signing pmbah--frozen-record pmbah--recovery-job)
            (pmbah--unlock-buffer)))
        (unless pmbah--writer-draining
          (when (and pmbah-mode (not pmbah--signing)) (pmbah--observation-after-event))
          (when (or pmbah--journal-pending pmbah--writer-dirty)
            (pmbah--schedule-storage-pump))))))))

(defun pmbah--drain-writer ()
  "Wait for queued writes before a lifecycle transition, then stop the writer.
Only explicit lifecycle operations wait; modification hooks and checkpoint
callbacks never call this barrier.  Retain ownership and events on failure."
  (when (or pmbah--writer pmbah--writer-request pmbah--writer-retry pmbah--writer-timer)
    (let ((pmbah--writer-draining t))
      (when (timerp pmbah--writer-timer) (cancel-timer pmbah--writer-timer))
      (setq pmbah--writer-timer nil)
      (while (and (not pmbah--save-failure)
                  (or pmbah--writer-request pmbah--writer-retry pmbah--journal-pending pmbah--writer-dirty))
        (pmbah--pump-storage)
        (when (process-live-p pmbah--writer) (accept-process-output pmbah--writer 0.02)))
      (when pmbah--save-failure (error "%s" pmbah--save-failure))
      (pmbah--stop-writer))))

(defun pmbah--close-storage ()
  "Durably save and stop storage before releasing this buffer's ownership."
  (pmbah--write-state t))

(defun pmbah--save-lifecycle ()
  "Save capture intent immediately, preserving enabled session ownership on error."
  (condition-case error (pmbah--write-state t)
    ((error quit) (pmbah--mark-save-failure error))))

(defun pmbah--write-state (&optional strict)
  "Write this buffer's content-blind recovery state.
With STRICT, signal failures so signing cannot outrun durable storage.
Otherwise report failures with `message' for hooks and timers."
  (if (and pmbah--background-persistence (not strict))
      (pmbah--schedule-storage)
    (pmbah--drain-writer)
    (let ((path (pmbah--state-file)))
    (when (and path pmbah--session-id)
      (condition-case error
          (progn
            (pmbah--claim-state path)
            (pmbah--flush-journal)
            (pmbah--write-json-file path (pmbah--json-encode (pmbah--state-snapshot)))
            (setq pmbah--state-path path pmbah--writer-dirty nil))
        ((error quit)
         (if strict
             (signal (car error) (cdr error))
           (pmbah--mark-save-failure error))))))))

(defun pmbah--mark-save-failure (error)
  "Retain in-memory events and stop editable capture after a storage ERROR."
  (setq pmbah--save-failure (error-message-string error))
  (when pmbah-mode (pmbah--lock-buffer))
  (message "PMBAH could not save recovery state: %s. Recording is paused; use M-x pmbah-retry-save"
           pmbah--save-failure))

;;;###autoload
(defun pmbah-retry-save ()
  "Save recovery state and resume unsigned capture after a storage failure.
A frozen upload stays frozen and read-only; paused capture stays paused.
No document text is persisted."
  (interactive)
  (when pmbah--recovery-job
    (user-error "This session is still recovering; wait before retrying its save"))
  (unless pmbah--session-id
    (user-error "No PMBAH session in this buffer; use M-x pmbah-mode to recover one"))
  (when (or pmbah--sign-job pmbah--signing)
    (user-error "This record is being prepared or uploaded; wait before retrying its save"))
  (setq pmbah--save-failure nil)
  (condition-case error
      (progn
        (pmbah--write-state t)
        (unless (and pmbah-mode pmbah--frozen-record)
          (pmbah--unlock-buffer)
          (when (and pmbah-mode (> pmbah--next-seq 0)) (pmbah--observation-after-event)))
        (message "PMBAH recovery state saved%s"
                 (cond ((not pmbah-mode) "; recording remains paused")
                       (pmbah--frozen-record "; the record remains frozen")
                       (t "; recording resumed"))))
    ((error quit) (pmbah--mark-save-failure error))))

(defun pmbah--write-all-state ()
  "Write the session state of every recording buffer."
  (dolist (buffer (buffer-list))
    (when (buffer-live-p buffer)
      (with-current-buffer buffer
        (when (and (local-variable-p 'pmbah--session-id) pmbah--session-id)
          (pmbah--write-state t))))))

(defun pmbah--can-close-buffer ()
  "Keep the buffer open if its capture history cannot be saved."
  (if (not (and (local-variable-p 'pmbah--session-id) pmbah--session-id)) t
    (condition-case error
        (progn (pmbah--write-state t) t)
      ((error quit)
       (pmbah--mark-save-failure error)
       (message "PMBAH: close cancelled because session history could not be saved. Fix storage and use M-x pmbah-retry-save.")
       nil))))

(defun pmbah--can-exit ()
  "Save every retained session before allowing an ordinary Emacs exit."
  (cl-every (lambda (buffer)
              (or (not (buffer-live-p buffer))
                  (with-current-buffer buffer (pmbah--can-close-buffer))))
            (buffer-list)))

(defun pmbah--delete-state ()
  "Remove finished/discarded recovery metadata before its now-unreferenced journal."
  (pmbah--drain-writer)
  (let ((path (pmbah--state-file)) (journal (pmbah--journal-file)))
    (condition-case error
        (progn
          (when (and path (file-exists-p path)) (delete-file path))
          (when (file-exists-p journal) (delete-file journal)))
      (error (message "PMBAH could not remove session recovery: %s" (error-message-string error))))))

(defun pmbah--follow-visited-file ()
  "Move recovery state after a visited-file rename without replacing another session."
  (pmbah--drain-writer)
  (let* ((old-path (pmbah--state-file))
         (new-path (pmbah--preferred-state-file))
         (target (and new-path (file-exists-p new-path) (pmbah--read-state new-path))))
    (if (and new-path (not (equal old-path new-path)) (file-exists-p new-path)
             (not (equal (plist-get target :session_id) pmbah--session-id)))
        (progn
          (setq pmbah--state-path old-path)
          (message "PMBAH recovery at %s belongs to another session; this session remains at %s"
                   new-path old-path))
      (when (and old-path new-path (not (equal old-path new-path)))
        (condition-case error
            (progn
              (pmbah--claim-state new-path)
              (when (file-exists-p old-path) (rename-file old-path new-path t))
              (setq pmbah--state-path new-path)
              (pmbah--release-ownership (list new-path (pmbah--journal-file))))
          (error
           (message "PMBAH could not move session recovery; retaining %s: %s"
                    old-path (error-message-string error)))))
      (when new-path (pmbah--write-state)))))

(defun pmbah--read-state (path)
  "Parse the session state file at PATH, or return nil when it is unreadable."
  (condition-case nil
      (with-temp-buffer
        (let ((coding-system-for-read 'utf-8))
          (insert-file-contents path))
        (json-parse-string (buffer-string)
                           :object-type 'plist
                           :array-type 'list
                           :null-object nil
                           :false-object :json-false))
    (error nil)))

(defun pmbah--time-to-ms (time)
  "Return TIME as integer milliseconds since the epoch."
  (floor (* 1000 (float-time time))))

(defun pmbah--ms-to-time (ms)
  "Return the Lisp time value for MS milliseconds since the epoch."
  (seconds-to-time (/ ms 1000.0)))

(defun pmbah--observation-reset ()
  "Forget everything the server has committed to for this session."
  (pmbah--observation-abandon-attempt)
  (setq pmbah--observation-state (if pmbah-observe-process 'unknown 'disabled)
        pmbah--observation-session-id pmbah--session-id
        pmbah--observation-token nil
        pmbah--observation-committed-count 0
        pmbah--observation-last-attempt nil
        pmbah--observation-in-flight nil
        pmbah--observation-queued nil
        pmbah--observation-backoff-ms 0
        pmbah--observation-commitments nil
        pmbah--observation-last-failure nil))

(defun pmbah--after-change (beg end len)
  "Record a public mutation shape after a buffer change.
BEG, END, and LEN are supplied by `after-change-functions` and are Emacs
character positions/lengths, which match the PMBAH format's Unicode codepoint
unit for these captured text buffers."
  (when (and pmbah-mode pmbah--storage-backpressure)
    ;; Deliberate read-only bypasses do not grow the bounded queue or imply
    ;; continuous observation when capture resumes.
    (setq pmbah--pending-gap t))
  (unless (or (not pmbah-mode) (not pmbah--session-id) pmbah--save-failure
              pmbah--storage-backpressure pmbah--signing pmbah--frozen-record)
    (let* ((inserted-len (- end beg))
           (op (cond
                ((and (= len 0) (> inserted-len 0)) "insert")
                ((and (> len 0) (= inserted-len 0)) "delete")
                ((and (> len 0) (> inserted-len 0)) "replace")
                (t nil)))
           (pos (1- beg)))
      (setq pmbah--observed-tick (buffer-chars-modified-tick))
      (when op
        (condition-case error
            (pmbah--append-event op pos len inserted-len (pmbah--source-for-current-command))
          ((error quit)
           ;; The mutation has already happened. Keep the hook installed and
           ;; explicitly mark continuity unknown if capture itself was interrupted.
           (setq pmbah--pending-gap t)
           (pmbah--mark-save-failure error)))))))

(defun pmbah--append-event (op pos del-len ins-len source &optional timestamp-ms)
  "Append a content-blind PMBAH public event."
  (when (or pmbah--signing pmbah--frozen-record)
    (user-error "Cannot append to a frozen PMBAH record"))
  (when (>= (pmbah--elapsed-ms) pmbah-max-session-ms)
    (pmbah--retire-live-session))
  (let* ((seq pmbah--next-seq)
         (event (list :seq seq
                      :t (or timestamp-ms (pmbah--elapsed-ms))
                      :op op
                      :pos (unless pmbah--pending-gap pos)
                      :del_len del-len
                      :ins_len ins-len
                      :source source)))
    (push event pmbah--events)
    (when (> (length pmbah--events) 256) (setcdr (nthcdr 255 pmbah--events) nil))
    (push event pmbah--journal-pending)
    (setq pmbah--pending-gap nil)
    (setq pmbah--next-seq (1+ pmbah--next-seq))
    ;; Interactive capture performs no filesystem or process work in this hook.
    ;; The worker queue remains bounded even if a disk stalls indefinitely.
    (pmbah--write-state)
    (if pmbah--background-persistence
        (when (>= (- pmbah--next-seq pmbah--journal-count) pmbah--pending-event-limit)
          (setq pmbah--storage-backpressure t)
          (pmbah--lock-buffer))
      (unless pmbah--save-failure (pmbah--observation-after-event)))))

(defun pmbah--source-for-current-command ()
  "Return a conservative PMBAH source for `this-command`.
Emacs does not provide complete source attribution from
`after-change-functions`, so this function returns `unknown` unless the
current command is a common, well-known edit command.  The producer does not
declare source_attribution."
  (cond
   ((memq this-command '(self-insert-command org-self-insert-command newline
                         electric-newline-and-maybe-indent delete-char
                         delete-backward-char backward-delete-char-untabify))
    "typing")
   ((memq this-command '(yank yank-pop clipboard-yank x-clipboard-yank))
    "paste")
   ((memq this-command '(kill-region kill-line kill-word backward-kill-word
                         kill-sentence backward-kill-sentence))
    "cut")
   (t "unknown")))

;;;###autoload
(defun pmbah-show-session-status ()
  "Show the current PMBAH capture session status for this buffer."
  (interactive)
  (let ((status (if (and pmbah-mode pmbah--session-id)
                    (format "PMBAH session %s: %d event%s, duration %d ms, %s, API %s"
                            pmbah--session-id
                            pmbah--next-seq
                            (if (= pmbah--next-seq 1) "" "s")
                            (pmbah--elapsed-ms)
                            (pmbah--observation-description)
                            pmbah-api-base-url)
                  "PMBAH mode is not active in this buffer.")))
    (when pmbah--recovery-job
      (setq status "PMBAH is recovering this session in the background. This buffer is read-only until verification finishes; other buffers remain usable. Close the buffer to cancel."))
    (when pmbah--save-failure
      (setq status (concat status " Recovery save failed; recording paused: " pmbah--save-failure)))
    (when (and pmbah--session-id pmbah--background-persistence)
      (setq status (concat status
                           (format "; %d events saved, %d awaiting storage"
                                   pmbah--journal-count (- pmbah--next-seq pmbah--journal-count)))))
    (when pmbah--recovery-error
      (setq status (concat status " Recovery failed; buffer is read-only: " pmbah--recovery-error
                           ". Retry with M-x pmbah-mode, or use C-u -1 M-x pmbah-mode to edit without recording.")))
    (when (called-interactively-p 'interactive)
      (message "%s" status))
    status))

;;;###autoload
(defun pmbah-discard-session ()
  "Discard the current local PMBAH event log without uploading.
Capture remains enabled and a fresh session starts from the next edit."
  (interactive)
  (when pmbah--recovery-job (user-error "Wait for PMBAH recovery before discarding a session"))
  (unless pmbah-mode
    (user-error "pmbah-mode is not active"))
  (when (or (not (called-interactively-p 'interactive))
            (yes-or-no-p "Discard this local PMBAH session without uploading? "))
    (pmbah--cancel-sign-job)
    (pmbah--delete-state)
    (pmbah--start-session)
    (pmbah--write-state)
    (message "PMBAH session discarded; new session %s started" pmbah--session-id)))

(defun pmbah--y-or-n-p-default-yes (prompt)
  "Ask PROMPT as a y/n question whose empty answer means yes."
  (let ((query (concat (string-trim-right prompt) " [Y/n] "))
        answer)
    (catch 'done
      (while t
        (setq answer (downcase (string-trim (read-from-minibuffer query))))
        (cond
         ((or (string-empty-p answer) (member answer '("y" "yes")))
          (throw 'done t))
         ((member answer '("n" "no"))
          (throw 'done nil))
         (t
          (message "Please answer y or n.")))))))

;;;###autoload
(defun pmbah-sign-buffer (&optional capture-context no-prompts)
  "Freeze and publish this session; interactive work runs asynchronously.
With a prefix argument, accept the usual context and binding defaults.
Noninteractive callers retain the synchronous result-returning interface."
  (interactive (list nil current-prefix-arg))
  (if (and (called-interactively-p 'interactive) (not noninteractive))
      (pmbah--sign-buffer-async capture-context no-prompts)
    (pmbah--sign-buffer-sync capture-context no-prompts)))

(defun pmbah--prepare-signing-input (capture-context no-prompts)
  "Confirm and freeze capture, returning only the transient local helper input."
  (when pmbah--recovery-job (user-error "Wait for PMBAH recovery before signing"))
  (unless pmbah-mode (user-error "Enable pmbah-mode before signing a buffer"))
  (when pmbah--sign-job (user-error "This record is already being prepared or uploaded"))
  (when (= pmbah--next-seq 0) (user-error "No PMBAH events captured for this buffer"))
  (unless pmbah--frozen-record
    (pmbah--check-capture-gap)
    (when (>= (pmbah--elapsed-ms) pmbah-max-session-ms)
      (pmbah--retire-live-session)
      (user-error "PMBAH session clock exceeded its exact integer range; a fresh session started"))
    (let* ((context (or capture-context (if no-prompts (pmbah--capture-context t t) (pmbah-review-capture-context))))
           (region (use-region-p))
           (bind (and (not (equal pmbah--session-format "0.1"))
                      (if no-prompts t
                        (and (not noninteractive)
                             (pmbah--y-or-n-p-default-yes
                              (if region
                                  "Anyone can test guesses against this public commitment. Bind the selected region? "
                                "Anyone can test guesses against this public commitment. Bind the whole buffer? "))))))
           (final-text (when bind
                         (pmbah--check-capture-gap)
                         (when pmbah--pending-gap
                           (user-error "Capture has a gap; make a recorded edit before binding text, or sign without a text binding"))
                         (if region (buffer-substring-no-properties (region-beginning) (region-end))
                           (save-restriction (widen) (buffer-substring-no-properties (point-min) (point-max)))))))
      (when (equal pmbah--session-format "0.2") (setq pmbah--session-format "0.3"))
      (setq pmbah--signed-duration-ms
            (if (equal pmbah--session-format "0.1") (or (plist-get (car pmbah--events) :t) 0) (pmbah--elapsed-ms))
            pmbah--signing t)
      (pmbah--lock-buffer)
      (pmbah--write-state t)
      (pmbah--record-helper-payload context final-text t))))

(defun pmbah--accept-frozen-manifest (built)
  "Keep only BUILT's manifest and immutable journal boundary."
  (setq pmbah--frozen-record (pmbah--json-encode (list (cons 'manifest (alist-get 'manifest built))))
        pmbah--frozen-byte-length (alist-get 'byte_length built)
        pmbah--upload-id (pmbah--uuid-v4)
        pmbah--signing nil)
  (pmbah--write-state t))

(defun pmbah--save-upload-envelope ()
  "Persist the small frozen observation envelope before starting publication."
  (unless pmbah--frozen-upload
    (setq pmbah--frozen-upload (pmbah--json-encode (list (cons 'observation (pmbah--observation-envelope))))))
  (pmbah--write-state t))

(defun pmbah--reject-upload-observation (code)
  "Keep the same record after a specific server rejection of its observation CODE."
  (pmbah--observation-reset)
  (setq pmbah--observation-last-failure code
        pmbah--frozen-upload (pmbah--json-encode (list (cons 'observation (list (cons 'state "unobserved"))))))
  (pmbah--write-state t)
  (user-error "Server rejected the observation binding (%s); retry signing the same record without that binding" code))

(defun pmbah--sign-buffer-sync (capture-context no-prompts)
  "Synchronous noninteractive signing interface for automation and tests."
  (when pmbah--recovery-job (user-error "Wait for PMBAH recovery before signing"))
  (when pmbah--sign-job (user-error "This record is already being prepared or uploaded"))
  (unwind-protect
      (let ((payload (pmbah--prepare-signing-input capture-context no-prompts)))
        (when payload (pmbah--accept-frozen-manifest (pmbah--journal-helper payload))))
    (setq pmbah--signing nil)
    (unless (or pmbah--frozen-record pmbah--save-failure) (pmbah--unlock-buffer)))
  (pmbah--lock-buffer)
  (pmbah--write-state t)
  (unless (or pmbah--frozen-upload pmbah--uploaded-response)
    (pmbah--observation-flush)
    (pmbah--save-upload-envelope))
  (unless pmbah--uploaded-response
    (condition-case error
        (setq pmbah--uploaded-response (pmbah--json-encode (pmbah--post-record (pmbah--upload-descriptor)))
              pmbah--uploaded-at-ms (pmbah--time-to-ms (current-time)))
      (pmbah-observation-rejected (pmbah--reject-upload-observation (cadr error)))))
  (pmbah--finish-publication))

(defun pmbah--finish-publication ()
  "Durably retain an accepted link and start its linked successor segment."
  (let* ((response (pmbah--parse-public-json pmbah--uploaded-response))
         (url (or (alist-get 'url response) (alist-get 'record_hash response)))
         (observation-note (pmbah--observation-upload-note))
         (manifest (alist-get 'manifest (pmbah--parse-public-json pmbah--frozen-record)))
         (parent (alist-get 'record_hash manifest))
         (next-start (if (equal (alist-get 'format_version manifest) "0.3")
                         (+ (pmbah--time-to-ms pmbah--session-start-time)
                            (alist-get 'duration_ms manifest))
                       (or pmbah--uploaded-at-ms (pmbah--time-to-ms (current-time))))))
    (when url (kill-new url))
    (condition-case error
        (progn
          (pmbah--write-state t)
          ;; Keep the accepted link durable before removing a draft, even if
          ;; deletion fails or the buffer is immediately reused for new writing.
          (pmbah--write-json-file
           (expand-file-name (concat "published-" pmbah--session-id ".json") pmbah-state-directory)
           pmbah--uploaded-response))
      (error
       (user-error "Record uploaded: %s; could not save its link: %s. Retry signing to save it"
                   url (error-message-string error))))
    (pmbah--delete-state)
    (pmbah--start-session parent next-start)
    (condition-case error
        (pmbah--write-state t)
      (error (user-error "Record uploaded: %s; could not save continuation state: %s"
                         url (error-message-string error))))
    (message "PMBAH record uploaded; copied %s%s; new session %s started" url observation-note pmbah--session-id)
    response))


(defun pmbah--cancel-sign-job ()
  "Cancel local async work before releasing a buffer's recovery ownership."
  (let ((job pmbah--sign-job))
    (setq pmbah--sign-job nil pmbah--signing nil)
    (when (timerp (plist-get job :timer)) (cancel-timer (plist-get job :timer)))
    (when (process-live-p (plist-get job :process)) (delete-process (plist-get job :process)))))

(defun pmbah--async-sign-current-p (token)
  "Whether TOKEN still identifies this buffer's current signing operation."
  (and pmbah--sign-job (equal token (plist-get pmbah--sign-job :token))
       (equal pmbah--session-id (plist-get pmbah--sign-job :session))))

(defun pmbah--async-sign-failed (failure)
  "Retain the recoverable prefix and report an asynchronous FAILURE."
  (pmbah--cancel-sign-job)
  (unless (or pmbah--frozen-record pmbah--save-failure) (pmbah--unlock-buffer))
  (message "PMBAH signing stopped: %s" failure))

(defun pmbah--sign-buffer-async (capture-context no-prompts)
  "Start interactive signing without blocking Emacs during scans or uploads."
  (when pmbah--recovery-job (user-error "Wait for PMBAH recovery before signing"))
  (when pmbah--sign-job (user-error "This record is already being prepared or uploaded"))
  (condition-case error
      (let ((payload (pmbah--prepare-signing-input capture-context no-prompts)))
        (setq pmbah--sign-job (list :token (pmbah--uuid-v4) :session pmbah--session-id))
        (if payload
            (pmbah--start-sign-helper 'manifest payload)
          (pmbah--lock-buffer)
          (pmbah--write-state t)
          (pmbah--async-flush-start))
        (message "PMBAH is preparing or publishing the frozen record"))
    ((error quit)
     (pmbah--async-sign-failed (error-message-string error))
     (signal (car error) (cdr error)))))

(defun pmbah--start-sign-helper (stage payload)
  "Run STAGE with PAYLOAD, retaining only the buffer and job token in its callback."
  (setq pmbah--sign-job (plist-put pmbah--sign-job :stage stage))
  (let* ((token (plist-get pmbah--sign-job :token))
         (process (pmbah--run-node-script-async
                  pmbah-helper-script payload
                  (apply-partially #'pmbah--sign-helper-result (current-buffer)
                                   token stage))))
    (when (and (pmbah--async-sign-current-p token) (eq stage (plist-get pmbah--sign-job :stage)))
      (setq pmbah--sign-job (plist-put pmbah--sign-job :process process)))))

(defun pmbah--sign-helper-result (buffer token stage result failure)
  "Apply one helper result only while BUFFER still owns TOKEN."
  (when (buffer-live-p buffer)
    (with-current-buffer buffer
      (when (pmbah--async-sign-current-p token)
        (condition-case error
            (progn
              (when failure (error "%s" failure))
              (if (eq stage 'manifest)
                  (progn (pmbah--accept-frozen-manifest result) (pmbah--async-flush-start))
                (setq pmbah--uploaded-response (pmbah--json-encode (pmbah--check-upload-result result))
                      pmbah--uploaded-at-ms (pmbah--time-to-ms (current-time)))
                (pmbah--finish-publication)))
          (pmbah-observation-rejected
           (condition-case rejected
               (pmbah--reject-upload-observation (cadr error))
             (error (pmbah--async-sign-failed (error-message-string rejected)))))
          ((error quit) (pmbah--async-sign-failed (error-message-string error))))))))

(defun pmbah--async-flush-start ()
  "Set the same bounded checkpoint-flush deadline as synchronous signing."
  (setq pmbah--sign-job (plist-put pmbah--sign-job :deadline (+ (float-time) pmbah-observation-flush-timeout-seconds))
        pmbah--sign-job (plist-put pmbah--sign-job :rounds (if pmbah--observation-in-flight 1 0)))
  (pmbah--async-flush-step (current-buffer) (plist-get pmbah--sign-job :token)))

(defun pmbah--async-flush-step (buffer token)
  "Poll checkpoint completion on a timer while leaving other buffers usable."
  (when (buffer-live-p buffer)
    (with-current-buffer buffer
      (when (pmbah--async-sign-current-p token)
        (condition-case error
            (if (and (not pmbah--frozen-upload) (not pmbah--uploaded-response)
                     pmbah-observe-process pmbah--observation-token
                     (not (eq pmbah--observation-state 'diverged))
                     (< (float-time) (plist-get pmbah--sign-job :deadline))
                     (or pmbah--observation-in-flight
                         (and (< (plist-get pmbah--sign-job :rounds) pmbah-observation-flush-rounds)
                              (> pmbah--next-seq pmbah--observation-committed-count))))
                (progn
                  (unless pmbah--observation-in-flight
                    (setq pmbah--sign-job (plist-put pmbah--sign-job :rounds (1+ (plist-get pmbah--sign-job :rounds)))
                          pmbah--observation-backoff-ms 0)
                    (pmbah--observation-kick))
                  (setq pmbah--sign-job (plist-put pmbah--sign-job :timer
                                                 (run-with-timer 0.05 nil #'pmbah--async-flush-step buffer token))))
              (if pmbah--uploaded-response
                  (pmbah--finish-publication)
                (pmbah--save-upload-envelope)
                (pmbah--start-sign-helper 'publish (pmbah--upload-descriptor))))
          ((error quit) (pmbah--async-sign-failed (error-message-string error))))))))

(defun pmbah--parse-public-json (json)
  "Read content-blind persisted JSON using public record alist keys."
  (json-parse-string json :object-type 'alist :array-type 'array
                     :null-object nil :false-object :json-false))

;;;###autoload
(defun pmbah-recover-session (path)
  "Recover a non-file session from PATH into the current buffer.
No document text is restored. Frozen uploads can be retried unchanged."
  (interactive
   (list (completing-read "Recover PMBAH session: "
                          (when (file-directory-p pmbah-state-directory)
                            (directory-files pmbah-state-directory t "\\`session-.*\\.json\\'"))
                          nil t)))
  (when (or pmbah--session-id pmbah--recovery-job)
    (user-error "Recover into a buffer without a retained PMBAH session"))
  (if (called-interactively-p 'interactive)
      (pmbah--start-recovery path)
    (let ((owned pmbah--owned-paths) recovered)
      (unwind-protect
          (progn
            (pmbah--claim-state path)
            (let* ((state (pmbah--read-state path))
                   (blocker (pmbah--state-resume-blocker state)))
              (when blocker (user-error "Cannot recover session: %s" blocker))
              (pmbah--resume-session state path)
              (setq recovered t)
              (pmbah-mode 1)
              (when buffer-file-name (pmbah--follow-visited-file))))
        (unless recovered (pmbah--release-ownership owned))))))

(defun pmbah-review-capture-context ()
  "Collect capture context for upload.
Absolute file paths are omitted by default and are never included."
  (let* ((buffer-label (buffer-name))
         (mode-label (symbol-name major-mode))
         (file-label (or (buffer-file-name) "not visiting a file"))
         include-buffer-name
         include-major-mode)
    (message "PMBAH upload is content-blind; absolute file path omitted (%s)" file-label)
    (setq include-buffer-name (pmbah--y-or-n-p-default-yes (format "Include buffer name `%s` in capture context? " buffer-label)))
    (setq include-major-mode (pmbah--y-or-n-p-default-yes (format "Include major mode `%s` in capture context? " mode-label)))
    (pmbah--capture-context include-buffer-name include-major-mode)))

(defun pmbah-build-record-for-current-buffer (&optional capture-context final-text)
  "Explicitly export a public PMBAH record for diagnostics.
This materializes the event array; normal capture, checkpointing, and signing
use bounded journal operations instead. The returned alist has manifest/events.
FINAL-TEXT, when non-nil, is handed to the local helper transiently so it can
compute the content-blind text binding; it is never stored or uploaded."
  (alist-get 'record (pmbah--build-record-result capture-context final-text)))

(defun pmbah--build-record-result (&optional capture-context final-text manifest-only)
  "Run an explicit synchronous export or manifest computation."
  (pmbah--journal-helper (pmbah--record-helper-payload capture-context final-text manifest-only)))

(defun pmbah--record-helper-payload (&optional capture-context final-text manifest-only)
  "Return the private journal descriptor for the current buffer's helper call.
FINAL-TEXT, when a non-empty string, is passed to the local helper SOLELY to
compute the content-blind text binding and is never persisted or uploaded."
  (unless pmbah--session-id
    (user-error "No active PMBAH session"))
  (when (= pmbah--next-seq 0)
    (user-error "No PMBAH events captured for this buffer"))
  (let* ((payload (append
                   (list :format_version pmbah--session-format
                         :session_id pmbah--session-id
                         :producer (list :id "emacs"
                                         :version pmbah-producer-version
                                         :capabilities ["timing" "pause_fidelity"])
                         :capture_context (or capture-context (pmbah--capture-context nil nil))
                         :operation (if manifest-only "manifest" "export")
                         :journal_path (pmbah--journal-file)
                         :event_count pmbah--journal-count
                         :end_byte pmbah--journal-bytes
                         :duration_ms (or pmbah--signed-duration-ms (pmbah--elapsed-ms))
                         :parent_record pmbah--parent-record
                         :created_client_t (format-time-string "%FT%T.%3NZ" pmbah--session-start-time t))
                   (when (and final-text (stringp final-text) (> (length final-text) 0))
                     (list :final_text final-text)))))
    payload))

(defun pmbah--run-helper (payload)
  "Run the local Node helper with PAYLOAD and return its parsed JSON result."
  (unless (file-readable-p pmbah-helper-script)
    (user-error "PMBAH helper script is not readable: %s" pmbah-helper-script))
  (let* ((input (pmbah--json-encode payload))
         (stdout-buffer (generate-new-buffer " *pmbah-helper-stdout*"))
         (stderr-file (make-temp-file "pmbah-helper-stderr"))
         (status nil))
    (unwind-protect
        (progn
          (with-temp-buffer
            (insert input)
            (let ((coding-system-for-write 'utf-8))
              (setq status (call-process-region (point-min) (point-max)
                                                pmbah-node-command nil
                                                (list stdout-buffer stderr-file)
                                                nil pmbah-helper-script))))
          (unless (and (integerp status) (= status 0))
            (user-error "PMBAH helper failed (%s): %s" status (pmbah--read-file stderr-file)))
          (with-current-buffer stdout-buffer
            (json-parse-string (buffer-string)
                               :object-type 'alist
                               :array-type 'array
                               :null-object nil
                               :false-object :json-false)))
      (when (buffer-live-p stdout-buffer) (kill-buffer stdout-buffer))
      (when (file-exists-p stderr-file) (delete-file stderr-file)))))

(define-error 'pmbah-observation-rejected "PMBAH observation binding was rejected" 'user-error)

(defun pmbah--upload-descriptor ()
  "Return a small private descriptor for chunked publication of the frozen prefix."
  (append (pmbah--parse-public-json pmbah--frozen-record)
          (pmbah--parse-public-json pmbah--frozen-upload)
          (list (cons 'operation "publish") (cons 'upload_id pmbah--upload-id)
                (cons 'api_base_url pmbah-api-base-url)
                (cons 'journal_path (pmbah--journal-file))
                (cons 'end_byte pmbah--frozen-byte-length))))

(defun pmbah--post-record (descriptor)
  "Publish DESCRIPTOR's immutable journal prefix in bounded resumable chunks."
  (pmbah--check-upload-result (pmbah--journal-helper descriptor)))

(defun pmbah--check-upload-result (response)
  "Interpret the bounded helper response and preserve specific observation rejection."
  (let ((failure (alist-get 'error response)))
    (when failure
      (let ((code (alist-get 'code failure)))
        (if (member code '("observation_mismatch" "observation_unavailable"))
            (signal 'pmbah-observation-rejected (list code))
          (user-error "PMBAH upload failed: %s" (alist-get 'message failure)))))
    response))

(defun pmbah--capture-context (include-buffer-name include-major-mode)
  "Build capture context, including only accepted Emacs metadata fields."
  (let ((emacs-fields nil))
    (when include-buffer-name
      (setq emacs-fields (plist-put emacs-fields :buffer_name (buffer-name))))
    (when include-major-mode
      (setq emacs-fields (plist-put emacs-fields :major_mode (symbol-name major-mode))))
    (if emacs-fields
        (list :surface "emacs" :emacs emacs-fields)
      (list :surface "emacs"))))

;;; Server-observed checkpoints
;;
;; Cadence mirrors packages/producer-core: the first event is committed
;; immediately; afterwards a checkpoint is due when 50 events accumulated
;; since the last commitment, or when 60 seconds passed since the last
;; attempt and at least one new event exists.  Nothing is sent while idle.
;; One request is in flight at a time; a second trigger while busy is
;; coalesced into a single queued slot.  Transient failures back off
;; exponentially from 1 s to 60 s; a conflict pins the session `diverged';
;; an unavailable observed session resets local observation state.

(defun pmbah--observation-after-event ()
  "Start a checkpoint when the cadence says one is due."
  (when (and pmbah-observe-process (not (eq pmbah--observation-state 'diverged)))
    (pmbah--observation-recompute-state)
    (when (pmbah--observation-due-p)
      (if pmbah--observation-in-flight
          (setq pmbah--observation-queued t)
        (pmbah--observation-kick)))))

(defun pmbah--observation-due-p ()
  "Return non-nil when uncommitted events warrant a checkpoint now."
  (let* ((delta (- pmbah--journal-count pmbah--observation-committed-count))
         (since-last-attempt (and pmbah--observation-last-attempt
                                  (- (float-time) pmbah--observation-last-attempt))))
    (cond
     ((<= delta 0) nil)
     ((and (> pmbah--observation-backoff-ms 0)
           since-last-attempt
           (< (* 1000 since-last-attempt) pmbah--observation-backoff-ms))
      nil)
     ((= pmbah--observation-committed-count 0) t)
     ((>= delta pmbah-observation-every-n-events) t)
     ((or (null since-last-attempt)
          (>= since-last-attempt pmbah-observation-every-seconds))
      t)
     (t nil))))

(defun pmbah--observation-kick ()
  "Compute the current chain tip and post it as a checkpoint.
Errors and quits become transient failures, preserving the capture hook."
  (condition-case error
      (progn
        (setq pmbah--observation-in-flight t
              pmbah--observation-queued nil
              pmbah--observation-request nil
              pmbah--observation-last-attempt (float-time)
              pmbah--observation-attempt (1+ pmbah--observation-attempt))
        (pmbah--observation-arm-watchdog)
        (let* ((source (current-buffer))
               (session-id pmbah--session-id)
               (attempt pmbah--observation-attempt)
               (event-count pmbah--journal-count)
               (payload (pmbah--chain-tip-payload))
               (process
                (pmbah--run-node-script-async
                 pmbah-chain-tip-script payload
                 (lambda (result failure)
                   (pmbah--observation-continue source session-id attempt
                     (lambda ()
                       (let ((chain-tip (and (not failure) (alist-get 'chain_tip result))))
                         (cond
                          (failure (pmbah--observation-fail 'transient 0 failure))
                          ((not (and (stringp chain-tip)
                                     (eql (alist-get 'event_count result) event-count)))
                           (pmbah--observation-fail 'transient 0 "helper returned an unexpected chain tip"))
                          (t
                           (pmbah--set-chain-tip chain-tip event-count)
                           (setq pmbah--chain-tip-byte-offset (alist-get 'byte_length result)
                                 pmbah--chain-tip-last-time (alist-get 'last_t result))
                           (pmbah--observation-post event-count chain-tip))))))))))
          ;; A fast callback can already have started HTTP or finished.  Keep
          ;; that newer request handle instead of replacing it with this helper.
          (when (and pmbah--observation-in-flight
                     (= attempt pmbah--observation-attempt)
                     (not pmbah--observation-request))
            (setq pmbah--observation-request process))))
    ((error quit)
     (let ((inhibit-quit t))
       (pmbah--observation-abandon-attempt)
       (pmbah--observation-fail 'transient 0 (error-message-string error))))))

(defun pmbah--chain-tip-payload ()
  "Return a bounded helper descriptor for only the un-hashed journal suffix."
  (append (list :session_id pmbah--session-id :format_version pmbah--session-format
                :journal_path (pmbah--journal-file) :event_count pmbah--journal-count
                :end_byte pmbah--journal-bytes)
          (when pmbah--chain-tip
            (list :previous_chain_tip pmbah--chain-tip
                  :previous_event_count pmbah--chain-tip-event-count
                  :previous_byte_offset pmbah--chain-tip-byte-offset
                  :previous_t pmbah--chain-tip-last-time))))

(defun pmbah--set-chain-tip (chain-tip event-count)
  "Remember CHAIN-TIP as the tip over the first EVENT-COUNT events.
A tip that does not describe a non-empty prefix of this session's events
forgets the known tip instead, so the next checkpoint recomputes in full."
  (if (and (stringp chain-tip) (integerp event-count)
           (> event-count 0) (<= event-count pmbah--next-seq))
      (when (> event-count pmbah--chain-tip-event-count)
        (setq pmbah--chain-tip chain-tip
              pmbah--chain-tip-event-count event-count))
    (setq pmbah--chain-tip nil
          pmbah--chain-tip-event-count 0)))

(defun pmbah--observation-continue (buffer session-id attempt thunk)
  "Call THUNK in BUFFER if ATTEMPT is still its in-flight attempt for SESSION-ID.
Results for a session that was uploaded or discarded meanwhile, for an
attempt the watchdog already failed, or delivered twice are dropped."
  (when (buffer-live-p buffer)
    (with-current-buffer buffer
      (when (and (equal pmbah--session-id session-id)
                 (= attempt pmbah--observation-attempt)
                 pmbah--observation-in-flight)
        (condition-case error
            (funcall thunk)
          ((error quit)
           (let ((inhibit-quit t))
             (pmbah--observation-abandon-attempt)
             (pmbah--observation-fail 'transient 0 (error-message-string error)))))))))

(defun pmbah--observation-arm-watchdog ()
  "Fail the attempt started now if it has not finished within the timeout."
  (pmbah--observation-disarm-watchdog)
  (setq pmbah--observation-watchdog
        (run-with-timer pmbah-observation-request-timeout-seconds nil
                        #'pmbah--observation-timeout
                        (current-buffer) pmbah--session-id pmbah--observation-attempt)))

(defun pmbah--observation-disarm-watchdog ()
  "Cancel the watchdog of the current attempt."
  (when pmbah--observation-watchdog
    (cancel-timer pmbah--observation-watchdog)
    (setq pmbah--observation-watchdog nil)))

(defun pmbah--observation-timeout (buffer session-id attempt)
  "Fail ATTEMPT for SESSION-ID in BUFFER as transient if it is still in flight."
  (pmbah--observation-continue buffer session-id attempt
    (lambda ()
      (pmbah--observation-abandon-attempt)
      (pmbah--observation-fail 'transient 0
                               (format "no response within %s s"
                                       pmbah-observation-request-timeout-seconds)))))

(defun pmbah--observation-abandon-attempt ()
  "Invalidate the in-flight attempt and stop its helper or HTTP request."
  (setq pmbah--observation-attempt (1+ pmbah--observation-attempt))
  (pmbah--observation-disarm-watchdog)
  (let ((request pmbah--observation-request))
    (setq pmbah--observation-request nil)
    (cond
     ;; The helper's own sentinel cleans up its buffers and reports a failure
     ;; that `pmbah--observation-continue' drops as belonging to a dead attempt.
     ((processp request)
      (when (process-live-p request)
        (delete-process request)))
     ((buffer-live-p request)
      (let ((process (get-buffer-process request)))
        (when process
          (set-process-sentinel process #'ignore)
          (set-process-filter process #'ignore)
          (delete-process process)))
      (kill-buffer request)))))

(defun pmbah--observation-finish-attempt ()
  "Mark the in-flight attempt complete."
  (pmbah--observation-disarm-watchdog)
  (setq pmbah--observation-request nil
        pmbah--observation-in-flight nil
        pmbah--observation-queued nil))

(defun pmbah--observation-endpoint ()
  "Return the checkpoint URL for the current session."
  (format "%s/api/observed-sessions/%s/checkpoints"
          (string-remove-suffix "/" (or pmbah-observation-base-url pmbah-api-base-url))
          (or pmbah--observation-session-id pmbah--session-id)))

(defun pmbah--observation-post (event-count chain-tip)
  "POST a checkpoint for EVENT-COUNT events with CHAIN-TIP asynchronously."
  (let* ((source (current-buffer))
         (session-id pmbah--session-id)
         (attempt pmbah--observation-attempt)
         (body (append (list :event_count event-count :chain_tip chain-tip)
                       (when pmbah--observation-token
                         (list :token pmbah--observation-token))))
         (url-request-method "POST")
         (url-request-extra-headers '(("Content-Type" . "application/json; charset=utf-8")))
         (url-request-data (encode-coding-string (pmbah--json-encode body) 'utf-8)))
    (condition-case error
        (let ((response-buffer
               (url-retrieve (pmbah--observation-endpoint)
                             (lambda (status)
                               (let ((response-buffer (current-buffer)))
                                 (unwind-protect
                                     (let ((outcome (pmbah--observation-read-response status)))
                                       (pmbah--observation-continue source session-id attempt
                                         (lambda () (pmbah--observation-apply outcome))))
                                   (when (buffer-live-p response-buffer)
                                     (kill-buffer response-buffer)))))
                             nil t t)))
          (when (and pmbah--observation-in-flight (= attempt pmbah--observation-attempt))
            (setq pmbah--observation-request response-buffer))
          (let ((process (and response-buffer (get-buffer-process response-buffer))))
            (when process
              (set-process-query-on-exit-flag process nil))))
      ((error quit)
       (let ((inhibit-quit t))
         (pmbah--observation-abandon-attempt)
         (pmbah--observation-fail 'transient 0 (error-message-string error)))))))

(defun pmbah--observation-read-response (status)
  "Classify the HTTP response in the current buffer given url STATUS.
Return (KIND HTTP-STATUS BODY-OR-REASON) where KIND is `ok', `unavailable',
`conflict', `client_bug', `rate_limited', or `transient'."
  (let ((connection-error (plist-get status :error)))
    (if (and connection-error (not (integerp url-http-response-status)))
        (list 'transient 0 (error-message-string connection-error))
      (let ((http-status url-http-response-status))
        (goto-char (or url-http-end-of-headers (point-min)))
        (let ((body (decode-coding-string
                     (buffer-substring-no-properties (point) (point-max)) 'utf-8)))
          (cond
           ((and (integerp http-status) (>= http-status 200) (< http-status 300))
            (condition-case nil
                (list 'ok http-status
                      (json-parse-string body :object-type 'alist :array-type 'array
                                         :null-object nil :false-object :json-false))
              (error (list 'transient http-status "checkpoint response was not JSON"))))
           ((eql http-status 404) (list 'unavailable http-status (string-trim body)))
           ((eql http-status 409) (list 'conflict http-status (string-trim body)))
           ((eql http-status 400) (list 'client_bug http-status (string-trim body)))
           ((eql http-status 429) (list 'rate_limited http-status (string-trim body)))
           (t (list 'transient (or http-status 0) (string-trim body)))))))))

(defun pmbah--observation-apply (outcome)
  "Update observation state from OUTCOME and continue queued work."
  (pcase-let ((`(,kind ,http-status ,payload) outcome))
    (cond
     ((and (eq kind 'ok) (not (pmbah--observation-valid-response-p payload)))
      (pmbah--observation-fail 'transient http-status "checkpoint response was malformed"))
     ((eq kind 'ok)
      (pmbah--observation-succeed payload)
      (if (and pmbah--observation-queued
               (> pmbah--next-seq pmbah--observation-committed-count))
          (pmbah--observation-kick)
        (pmbah--observation-finish-attempt)))
     (t
      (pmbah--observation-fail kind http-status payload)))))

(defun pmbah--observation-valid-response-p (response)
  "Return non-nil when RESPONSE, a checkpoint success alist, is well formed."
  (and (listp response)
       (let ((event-count (alist-get 'event_count response))
             (token (alist-get 'token response))
             (checkpoint-id (alist-get 'checkpoint_id response))
             (chain-tip (alist-get 'chain_tip response))
             (server-t (alist-get 'server_t response)))
         (and (integerp event-count) (>= event-count 1)
              (stringp token) (>= (length token) 32)
              (stringp checkpoint-id) (> (length checkpoint-id) 0)
              (stringp chain-tip) (string-prefix-p "b3:" chain-tip)
              (stringp server-t)))))

(defun pmbah--observation-succeed (response)
  "Record a successful checkpoint RESPONSE from the server."
  (let ((event-count (alist-get 'event_count response)))
    (setq pmbah--observation-token (alist-get 'token response)
          pmbah--observation-committed-count (max pmbah--observation-committed-count event-count)
          pmbah--observation-backoff-ms 0
          pmbah--observation-last-failure nil)
    (pmbah--observation-merge-commitment
     (list :checkpoint_id (alist-get 'checkpoint_id response)
           :event_count event-count
           :chain_tip (alist-get 'chain_tip response)
           :observed_at (alist-get 'server_t response)))
    (pmbah--observation-recompute-state)
    (pmbah--write-state)))

(defun pmbah--observation-fail (kind http-status reason)
  "Record a failed checkpoint of KIND with HTTP-STATUS and REASON; stop the loop."
  (pmbah--observation-finish-attempt)
  (setq pmbah--observation-last-failure (format "%s (HTTP %s): %s" kind http-status reason))
  (pcase kind
    ('unavailable
     (let ((failure pmbah--observation-last-failure))
       (pmbah--observation-reset)
       ;; The server may have committed the first checkpoint but lost its
       ;; token-bearing response. Retrying that identity without its token can
       ;; never succeed. Rotate only observation; the writing chain stays intact.
       (setq pmbah--observation-session-id (pmbah--uuid-v4)
             pmbah--observation-last-failure failure)))
    ((or 'conflict 'client_bug)
     (setq pmbah--observation-state 'diverged
           pmbah--observation-backoff-ms 0))
    (_
     (setq pmbah--observation-backoff-ms
           (if (= pmbah--observation-backoff-ms 0)
               pmbah-observation-backoff-initial-ms
             (min pmbah-observation-backoff-max-ms (* 2 pmbah--observation-backoff-ms))))
     (pmbah--observation-recompute-state)))
  (pmbah--write-state))

(defun pmbah--observation-recompute-state ()
  "Derive `pmbah--observation-state' from committed and captured counts."
  (unless (eq pmbah--observation-state 'diverged)
    (setq pmbah--observation-state
          (cond
           ((not pmbah-observe-process) 'disabled)
           ((= pmbah--observation-committed-count 0) 'unknown)
           ((>= pmbah--observation-committed-count pmbah--next-seq) 'known)
           (t 'partial)))))

(defun pmbah--observation-merge-commitment (commitment)
  "Add COMMITMENT to the retained list, replacing one with the same event count."
  (let ((count (plist-get commitment :event_count)))
    (setq pmbah--observation-commitments
          (sort (cons commitment
                      (seq-remove (lambda (entry) (= (plist-get entry :event_count) count))
                                  pmbah--observation-commitments))
                (lambda (left right)
                  (< (plist-get left :event_count) (plist-get right :event_count)))))
    (let ((excess (- (length pmbah--observation-commitments)
                     pmbah-observation-commitment-retention)))
      (when (> excess 0)
        (setq pmbah--observation-commitments
              (cons (car pmbah--observation-commitments)
                    (nthcdr (1+ excess) pmbah--observation-commitments)))))))

(defun pmbah--observation-wait (seconds)
  "Block until no checkpoint is in flight or SECONDS elapsed.
Return non-nil when nothing is in flight."
  (let ((deadline (+ (float-time) seconds)))
    (while (and pmbah--observation-in-flight (< (float-time) deadline))
      (accept-process-output nil 0.05))
    (not pmbah--observation-in-flight)))

(defun pmbah--observation-flush ()
  "Commit the uncommitted tail of an observed session before signing.
A session the server never saw is uploaded as unobserved rather than
observed for the first time at sign time.  Events that arrived while a
checkpoint was already in flight need a second round; the flush runs at
most `pmbah-observation-flush-rounds' rounds within
`pmbah-observation-flush-timeout-seconds'."
  (when (and pmbah-observe-process
             pmbah--observation-token
             (not (eq pmbah--observation-state 'diverged)))
    (let ((deadline (+ (float-time) pmbah-observation-flush-timeout-seconds))
          (rounds 0))
      (while (and (< rounds pmbah-observation-flush-rounds)
                  (< (float-time) deadline)
                  (not (eq pmbah--observation-state 'diverged))
                  (or pmbah--observation-in-flight
                      (> pmbah--next-seq pmbah--observation-committed-count)))
        (unless pmbah--observation-in-flight
          (setq pmbah--observation-backoff-ms 0)
          (pmbah--observation-kick))
        (setq rounds (1+ rounds))
        (pmbah--observation-wait (max 0 (- deadline (float-time))))))))

(defun pmbah--observation-envelope ()
  "Return the `observation' upload field, or nil when observation is off.
A diverged session is uploaded as unobserved: binding its token would make
the server reject the record, and the writing record matters more than the
commitments."
  (cond
   ((not pmbah-observe-process) nil)
   ((and pmbah--observation-token (not (eq pmbah--observation-state 'diverged)))
    (list :observed_session_id (or pmbah--observation-session-id pmbah--session-id)
          :token pmbah--observation-token))
   (t (list :state "unobserved"))))

(defun pmbah--observation-upload-note ()
  "Return text for the upload message about observation, or an empty string."
  (if (and pmbah-observe-process (eq pmbah--observation-state 'diverged))
      (format "; server observation diverged and was not bound (%s)"
              pmbah--observation-last-failure)
    ""))

(defun pmbah--observation-status ()
  "Return a JSON-serializable plist describing observation for this buffer."
  (list :state (symbol-name (if pmbah-observe-process pmbah--observation-state 'disabled))
        :event_count pmbah--next-seq
        :committed_event_count pmbah--observation-committed-count
        :chain_tip_event_count pmbah--chain-tip-event-count
        :commitment_count (length pmbah--observation-commitments)
        :token_present (if pmbah--observation-token t :json-false)
        :in_flight (if pmbah--observation-in-flight t :json-false)
        :last_failure pmbah--observation-last-failure))

(defun pmbah--observation-description ()
  "Return a short human-readable observation summary."
  (let ((status (pmbah--observation-status)))
    (format "server-observed %s (%d of %d events committed)%s"
            (plist-get status :state)
            (plist-get status :committed_event_count)
            (plist-get status :event_count)
            (if pmbah--observation-last-failure
                (format ", last failure %s" pmbah--observation-last-failure)
              ""))))

(defun pmbah--run-node-script-async (script payload callback)
  "Run SCRIPT with JSON PAYLOAD on stdin and call CALLBACK once when it exits.
CALLBACK receives (RESULT FAILURE): the parsed JSON output and nil on
success, or nil and a failure description otherwise.  Return the process."
  (unless (file-readable-p script)
    (error "PMBAH helper script is not readable: %s" script))
  (let (stdout stderr stderr-pipe process started delivered)
    (cl-labels ((cleanup ()
                  (when (process-live-p stderr-pipe) (delete-process stderr-pipe))
                  (when (buffer-live-p stdout) (kill-buffer stdout))
                  (when (buffer-live-p stderr) (kill-buffer stderr))))
      (unwind-protect
          (progn
            (setq stdout (generate-new-buffer " *pmbah-node-stdout*")
                  stderr (generate-new-buffer " *pmbah-node-stderr*")
                  stderr-pipe (make-pipe-process :name "pmbah-node-stderr" :buffer stderr
                                                 :noquery t :sentinel #'ignore)
                  process
                  (make-process
                   :name "pmbah-node" :buffer stdout :stderr stderr-pipe
                   :command (list pmbah-node-command script)
                   :coding 'utf-8 :connection-type 'pipe :noquery t
                   :sentinel
                   (lambda (proc _event)
                     (when (and (not delivered) (memq (process-status proc) '(exit signal)))
                       (setq delivered t)
                       (let ((exit-status (process-exit-status proc))
                             (output (with-current-buffer stdout (buffer-string)))
                             (errors (with-current-buffer stderr (buffer-string))))
                         (cleanup)
                         (pmbah--deliver-node-result callback proc exit-status output errors))))))
            ;; A failed send is reported by the sentinel once. Setup quits
            ;; invalidate the callback before cleanup and propagate to the owner.
            (condition-case nil
                (progn
                  (process-send-string process (pmbah--json-encode payload))
                  (process-send-eof process))
              (error (when (process-live-p process) (delete-process process))))
            (setq started t)
            process)
        ;; A binding selection must never remain captured by the sentinel.
        (setq payload nil)
        (unless started
          (setq delivered t)
          (when (process-live-p process) (delete-process process))
          (cleanup))))))

(defun pmbah--deliver-node-result (callback process exit-status output errors)
  "Call CALLBACK once with the outcome of the helper PROCESS.
The JSON parse happens before the call so an error inside CALLBACK is not
mistaken for a parse failure and reported a second time."
  (if (and (eq (process-status process) 'exit) (= exit-status 0))
      (let ((parsed nil) (parse-failed nil))
        (condition-case nil
            (setq parsed (json-parse-string output :object-type 'alist
                                            :array-type 'array
                                            :null-object nil
                                            :false-object :json-false))
          (error (setq parse-failed t)))
        (if parse-failed
            (funcall callback nil "helper output was not JSON")
          (funcall callback parsed nil)))
    (funcall callback nil (format "helper exited %s: %s" exit-status (string-trim errors)))))

(defun pmbah--session-events ()
  "Explicit diagnostic export of all numeric events; never used by capture or signing."
  (let ((path (pmbah--journal-file)) events)
    (when (file-exists-p path)
      (with-temp-buffer
        (insert-file-contents path)
        (goto-char (point-min))
        (while (not (eobp))
          (push (json-parse-string (buffer-substring-no-properties (line-beginning-position) (line-end-position))
                                   :object-type 'plist :array-type 'list :null-object nil :false-object :json-false) events)
          (forward-line 1))))
    (append (nreverse events) (reverse pmbah--journal-pending))))

(defun pmbah--elapsed-ms ()
  "Return integer milliseconds since the current session started."
  (if pmbah--session-start-time
      (max 0 (or (plist-get (car pmbah--events) :t) 0)
           (floor (* 1000 (float-time (time-subtract (current-time) pmbah--session-start-time)))))
    0))

(defun pmbah--json-encode (object)
  "Encode OBJECT as UTF-8 JSON text with plist keys and nil as JSON null."
  (decode-coding-string
   (json-serialize object :null-object nil :false-object :json-false)
   'utf-8))

(defun pmbah--read-file (path)
  "Read PATH into a string, returning an empty string if unreadable."
  (if (file-readable-p path)
      (with-temp-buffer
        (insert-file-contents path)
        (buffer-string))
    ""))

(defun pmbah--uuid-v4 ()
  "Generate a UUIDv4 session id."
  (let ((bytes (vconcat (pmbah--random-bytes 16))))
    (aset bytes 6 (logior #x40 (logand #x0f (aref bytes 6))))
    (aset bytes 8 (logior #x80 (logand #x3f (aref bytes 8))))
    (let ((s (mapconcat (lambda (byte) (format "%02x" byte)) bytes "")))
      (format "%s-%s-%s-%s-%s"
              (substring s 0 8)
              (substring s 8 12)
              (substring s 12 16)
              (substring s 16 20)
              (substring s 20 32)))))

(defun pmbah--random-bytes (count)
  "Return COUNT random byte values for non-secret session ids."
  (let* ((hex (secure-hash 'sha256
                           (format "%s:%s:%s:%s:%s"
                                   (current-time-string)
                                   (float-time)
                                   (emacs-pid)
                                   (random t)
                                   (buffer-name))))
         (bytes nil))
    (dotimes (index count)
      (push (string-to-number (substring hex (* index 2) (+ (* index 2) 2)) 16)
            bytes))
    (nreverse bytes)))

;; Loading the package restores only previously opted-in files, never all files.
(add-hook 'find-file-hook #'pmbah--auto-resume t)
(add-hook 'after-change-major-mode-hook #'pmbah--reinstall-capture)
(add-hook 'kill-emacs-query-functions #'pmbah--can-exit)
(add-hook 'kill-emacs-hook #'pmbah--cancel-all-recoveries)
(add-to-list 'minor-mode-alist '(pmbah--recovery-error " PMBAH:recover!"))

;; Updating an already loaded package must not leave the old global close
;; hooks running in helper buffers, or forget an existing buffer's opt-in.
(dolist (hook '(pmbah--write-state pmbah--cancel-sign-job pmbah--release-ownership))
  (remove-hook 'kill-buffer-hook hook))
(dolist (buffer (buffer-list))
  (with-current-buffer buffer
    (when (and (local-variable-p 'pmbah--session-id) pmbah--session-id)
      (unless (local-variable-p 'pmbah--capture-enabled)
        (setq pmbah--capture-enabled (and pmbah-mode t)))
      (pmbah--reinstall-capture))))

(provide 'pmbah-mode)
;;; pmbah-mode.el ends here
