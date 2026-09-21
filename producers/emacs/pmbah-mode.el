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
The producer posts records to `/api/records` below this URL.  The default is
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
  (expand-file-name "scripts/build-record.mjs" pmbah--source-directory)
  "Local helper script that computes PMBAH BLAKE3 hashes and hash chains."
  :type 'file
  :group 'pmbah)

(defcustom pmbah-chain-tip-script
  (expand-file-name "scripts/chain-tip.mjs" pmbah--source-directory)
  "Local helper script that computes the public chain tip for a checkpoint.
It receives only the session id, format version, and public events."
  :type 'file
  :group 'pmbah)

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
  "Directory holding per-file session state so recording resumes across restarts.
A file-visiting buffer's session is stored under the SHA-256 of the file's
true name, readable only by the owner.  State files hold the session id,
start time, public events, and the observation token; never document text."
  :type 'directory
  :group 'pmbah)

(defconst pmbah-producer-version "0.1.0")
(defconst pmbah-format-version "0.2")

(defconst pmbah-max-session-ms 2147483647
  "Largest event time or duration a record can carry: signed 32-bit milliseconds.")
(defconst pmbah-state-write-idle-seconds 2
  "Idle time after an edit before the session state is written to disk.")

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
(defvar-local pmbah--session-start-time nil)
(defvar-local pmbah--events nil)
(defvar-local pmbah--next-seq 0)
(defvar-local pmbah--state-timer nil
  "Pending idle timer that writes this buffer's session state.")
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
  (if (and pmbah-mode pmbah--session-id)
      (format " PMBAH:%d%s" pmbah--next-seq (pmbah--observation-mode-line-mark))
    " PMBAH"))

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
  (if pmbah-mode
      (condition-case error
          (progn
            (pmbah--begin-capture)
            (add-hook 'after-change-functions #'pmbah--after-change nil t)
            (add-hook 'after-change-major-mode-hook #'pmbah--reinstall-capture)
            (add-hook 'kill-buffer-hook #'pmbah--write-state)
            (add-hook 'kill-emacs-hook #'pmbah--write-all-state)
            (add-hook 'after-set-visited-file-name-hook #'pmbah--follow-visited-file nil t))
        (error
         (setq pmbah-mode nil)
         (remove-hook 'after-change-functions #'pmbah--after-change t)
         (signal (car error) (cdr error))))
    (remove-hook 'after-change-functions #'pmbah--after-change t)
    (pmbah--write-state)))

;; Session state outlives `kill-all-local-variables', so changing the major
;; mode or reverting the buffer keeps recording into the same session.
(dolist (variable '(pmbah-mode
                    pmbah--session-id
                    pmbah--session-start-time
                    pmbah--events
                    pmbah--next-seq
                    pmbah--state-timer
                    pmbah--state-path
                    pmbah--chain-tip
                    pmbah--chain-tip-event-count
                    pmbah--observation-state
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
                    pmbah--observation-last-failure))
  (put variable 'permanent-local t))

(defun pmbah--reinstall-capture ()
  "Re-add the buffer-local change hook after a major-mode change wiped it."
  (when (and pmbah-mode pmbah--session-id)
    (add-hook 'after-change-functions #'pmbah--after-change nil t)))

(defun pmbah--begin-capture ()
  "Continue this buffer's session, resume it from disk, or start fresh."
  (unless pmbah--session-id
    (let* ((path (pmbah--state-file))
           (state (and path (file-exists-p path) (pmbah--read-state path)))
           (blocker (and path (file-exists-p path) (pmbah--state-resume-blocker state))))
      (cond
       (blocker
        (pmbah--retire-state-file path blocker)
        (pmbah--start-session))
       (state (pmbah--resume-session state))
       (t (pmbah--start-session))))))

(defun pmbah--start-session ()
  "Start a fresh per-buffer PMBAH session."
  (setq pmbah--session-id (pmbah--uuid-v4)
        pmbah--session-start-time (current-time)
        pmbah--events nil
        pmbah--next-seq 0
        pmbah--chain-tip nil
        pmbah--chain-tip-event-count 0)
  (pmbah--observation-reset))

(defun pmbah--resume-session (state)
  "Continue the session described by the STATE plist read from disk."
  (let ((events (plist-get state :events))
        (observation (plist-get state :observation)))
    (setq pmbah--session-id (plist-get state :session_id)
          pmbah--session-start-time (pmbah--ms-to-time (plist-get state :session_start_ms))
          pmbah--events (reverse events)
          pmbah--next-seq (length events))
    (pmbah--set-chain-tip (plist-get state :chain_tip)
                          (or (plist-get state :chain_tip_event_count) 0))
    (pmbah--observation-reset)
    (setq pmbah--observation-token (plist-get observation :token)
          pmbah--observation-committed-count (or (plist-get observation :committed_event_count) 0)
          pmbah--observation-commitments (plist-get observation :commitments)
          pmbah--observation-last-failure (plist-get observation :last_failure))
    (when (equal (plist-get observation :state) "diverged")
      (setq pmbah--observation-state 'diverged))
    (pmbah--observation-recompute-state)))

(defun pmbah--state-resume-blocker (state)
  "Return why the STATE plist cannot be resumed, or nil when it can."
  (cond
   ((not (and state
              (stringp (plist-get state :session_id))
              (integerp (plist-get state :session_start_ms))
              (listp (plist-get state :events))))
    "could not be read")
   ((not (equal (plist-get state :format_version) pmbah-format-version))
    (format "was recorded as format %s, not %s"
            (plist-get state :format_version) pmbah-format-version))
   ((>= (- (pmbah--time-to-ms (current-time)) (plist-get state :session_start_ms))
        pmbah-max-session-ms)
    "started more than 24 days ago, the most a record's clock can hold")
   (t nil)))

(defun pmbah--retire-state-file (path reason)
  "Rename the state file at PATH with a .stale suffix and tell the user why."
  (let ((stale-path (concat path ".stale")))
    (condition-case error
        (rename-file path stale-path t)
      (error
       (message "PMBAH could not set aside stale session state: %s"
                (error-message-string error))))
    (message "PMBAH: the saved session for %s %s; starting a fresh session (old state kept at %s)"
             (file-name-nondirectory (or buffer-file-name (buffer-name)))
             reason
             stale-path)))

(defun pmbah--retire-live-session ()
  "Set aside a session whose clock has reached the record time bound."
  (let ((path (pmbah--state-file)))
    (pmbah--write-state)
    (if (and path (file-exists-p path))
        (pmbah--retire-state-file path "reached the most a record's clock can hold")
      (message "PMBAH: the session for %s reached the most a record's clock can hold; starting a fresh session"
               (buffer-name)))
    (pmbah--start-session)))

;;; Session state on disk
;;
;; File-visiting buffers keep their session in `pmbah-state-directory' so a
;; writer who closes the file, or Emacs, and returns later continues the
;; same session.  Writes are debounced on an idle timer and forced when the
;; buffer or Emacs is killed, when the mode is turned off, and when the server
;; accepts a checkpoint (the token must not be lost).

(defun pmbah--state-file ()
  "Return the state file for the visited file, or nil for non-file buffers."
  (when buffer-file-name
    (expand-file-name (concat (secure-hash 'sha256 (file-truename buffer-file-name)) ".json")
                      pmbah-state-directory)))

(defun pmbah--state-snapshot ()
  "Return the JSON-serializable session state for this buffer."
  (list :session_id pmbah--session-id
        :session_start_ms (pmbah--time-to-ms pmbah--session-start-time)
        :format_version pmbah-format-version
        :events (vconcat (pmbah--session-events))
        :chain_tip pmbah--chain-tip
        :chain_tip_event_count pmbah--chain-tip-event-count
        :observation (list :state (symbol-name pmbah--observation-state)
                           :last_failure pmbah--observation-last-failure
                           :token pmbah--observation-token
                           :committed_event_count pmbah--observation-committed-count
                           :commitments (vconcat pmbah--observation-commitments))))

(defun pmbah--write-state ()
  "Write this buffer's session state to its state file, if it visits a file.
Failures are reported with `message' and never signalled, because this runs
from hooks and timers."
  (pmbah--cancel-state-write)
  (let ((path (pmbah--state-file)))
    (when (and path pmbah--session-id (> pmbah--next-seq 0))
      (condition-case error
          (let ((directory (file-name-directory path))
                (temp-path (concat path ".tmp"))
                (json (pmbah--json-encode (pmbah--state-snapshot)))
                (coding-system-for-write 'utf-8))
            (unless (file-directory-p directory)
              (make-directory directory t)
              (set-file-modes directory #o700))
            (with-file-modes #o600
              (with-temp-file temp-path
                (insert json)))
            (rename-file temp-path path t)
            (setq pmbah--state-path path))
        (error
         (message "PMBAH could not save session state: %s" (error-message-string error)))))))

(defun pmbah--write-all-state ()
  "Write the session state of every recording buffer."
  (dolist (buffer (buffer-list))
    (with-current-buffer buffer
      (when pmbah--session-id
        (pmbah--write-state)))))

(defun pmbah--schedule-state-write ()
  "Write the session state once Emacs has been idle for a moment."
  (when (and buffer-file-name (not pmbah--state-timer))
    (setq pmbah--state-timer
          (run-with-idle-timer pmbah-state-write-idle-seconds nil
                               #'pmbah--write-state-in-buffer (current-buffer)))))

(defun pmbah--write-state-in-buffer (buffer)
  "Write BUFFER's session state if the buffer is still live."
  (when (buffer-live-p buffer)
    (with-current-buffer buffer
      (pmbah--write-state))))

(defun pmbah--cancel-state-write ()
  "Cancel a pending idle write for this buffer."
  (when pmbah--state-timer
    (cancel-timer pmbah--state-timer)
    (setq pmbah--state-timer nil)))

(defun pmbah--delete-state ()
  "Remove this buffer's state file after the session was uploaded or discarded."
  (pmbah--cancel-state-write)
  (let ((path (pmbah--state-file)))
    (when (and path (file-exists-p path))
      (condition-case error
          (delete-file path)
        (error
         (message "PMBAH could not remove session state: %s" (error-message-string error)))))))

(defun pmbah--follow-visited-file ()
  "Move the state file to the visited file's new name after a rename.
Runs from `after-set-visited-file-name-hook', which `write-file' and
`set-visited-file-name' call."
  (let ((old-path pmbah--state-path)
        (new-path (pmbah--state-file)))
    (when (and old-path (not (equal old-path new-path)) (file-exists-p old-path))
      (condition-case error
          (if new-path
              (progn
                (rename-file old-path new-path t)
                (setq pmbah--state-path new-path))
            (delete-file old-path)
            (setq pmbah--state-path nil))
        (error
         (message "PMBAH could not move session state to the renamed file: %s"
                  (error-message-string error)))))
    (when new-path
      (pmbah--write-state))))

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
  (unless (or (not pmbah-mode) (not pmbah--session-id))
    (let* ((inserted-len (- end beg))
           (op (cond
                ((and (= len 0) (> inserted-len 0)) "insert")
                ((and (> len 0) (= inserted-len 0)) "delete")
                ((and (> len 0) (> inserted-len 0)) "replace")
                (t nil)))
           (pos (1- beg)))
      (when op
        (pmbah--append-event op pos len inserted-len (pmbah--source-for-current-command))))))

(defun pmbah--append-event (op pos del-len ins-len source &optional timestamp-ms)
  "Append a content-blind PMBAH public event."
  (when (>= (pmbah--elapsed-ms) pmbah-max-session-ms)
    (pmbah--retire-live-session))
  (let* ((seq pmbah--next-seq)
         (event (list :seq seq
                      :t (or timestamp-ms (pmbah--elapsed-ms))
                      :op op
                      :pos pos
                      :del_len del-len
                      :ins_len ins-len
                      :source source)))
    (push event pmbah--events)
    (setq pmbah--next-seq (1+ pmbah--next-seq))
    (pmbah--observation-after-event)
    (pmbah--schedule-state-write)))

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
    (when (called-interactively-p 'interactive)
      (message "%s" status))
    status))

;;;###autoload
(defun pmbah-discard-session ()
  "Discard the current local PMBAH event log without uploading.
Capture remains enabled and a fresh session starts from the next edit."
  (interactive)
  (unless pmbah-mode
    (user-error "pmbah-mode is not active"))
  (when (or (not (called-interactively-p 'interactive))
            (yes-or-no-p "Discard this local PMBAH session without uploading? "))
    (pmbah--delete-state)
    (pmbah--start-session)
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
  "Freeze, build, upload, and copy a short URL for the current PMBAH session.

Interactively, ask y/n questions with yes as the default.  With a prefix
argument, do not ask those questions; use the default yes answers.  If binding
is enabled, bind the active region when one is active; otherwise bind the whole
buffer.  CAPTURE-CONTEXT is intended for tests or advanced callers and must be a
JSON-serializable plist.  NO-PROMPTS is intended for interactive prefix use and
tests."
  (interactive (list nil current-prefix-arg))
  (unless pmbah-mode
    (user-error "Enable pmbah-mode before signing a buffer"))
  (when (= pmbah--next-seq 0)
    (user-error "No PMBAH events captured for this buffer"))
  (when (>= (pmbah--elapsed-ms) pmbah-max-session-ms)
    (pmbah--retire-live-session)
    (user-error "PMBAH session ran past the 24.8 days a record's clock can hold; it was set aside as .stale and a fresh session %s started"
                pmbah--session-id))
  (let* ((context (or capture-context
                      (if no-prompts
                          (pmbah--capture-context t t)
                        (pmbah-review-capture-context))))
         (binding-has-region (use-region-p))
         (bind-prompt (if binding-has-region
                          "Anyone can test guesses against this public commitment. Bind the selected region? "
                        "Anyone can test guesses against this public commitment. Bind the whole buffer? "))
         (bind (if no-prompts
                   t
                 (and (not noninteractive) (pmbah--y-or-n-p-default-yes bind-prompt))))
         (final-text (when bind
                       (if binding-has-region
                           (buffer-substring-no-properties (region-beginning) (region-end))
                         (buffer-substring-no-properties (point-min) (point-max)))))
         (record (progn
                   (pmbah--observation-flush)
                   (pmbah-build-record-for-current-buffer context final-text)))
         (observation (pmbah--observation-envelope))
         (observation-note (pmbah--observation-upload-note))
         (response (pmbah--post-record
                    (if observation
                        (append record (list (cons 'observation observation)))
                      record)))
         (url (or (alist-get 'url response) (alist-get 'record_hash response))))
    (when url
      (kill-new url))
    (pmbah--delete-state)
    (pmbah--start-session)
    (message "PMBAH record uploaded; copied %s%s; new session %s started"
             url
             observation-note
             pmbah--session-id)
    response))

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
  "Build and locally verify a public PMBAH record for the current buffer.
The returned alist contains only the public `manifest` and `events` shape.
FINAL-TEXT, when non-nil, is handed to the local helper transiently so it can
compute the content-blind text binding; it is never stored or uploaded."
  (alist-get 'record (pmbah--build-record-result capture-context final-text)))

(defun pmbah--build-record-result (&optional capture-context final-text)
  "Return the helper result for the current buffer, including verification facts.
FINAL-TEXT, when a non-empty string, is passed to the local helper SOLELY to
compute the content-blind text binding and is never persisted or uploaded."
  (unless pmbah--session-id
    (user-error "No active PMBAH session"))
  (when (= pmbah--next-seq 0)
    (user-error "No PMBAH events captured for this buffer"))
  (let* ((payload (append
                   (list :format_version pmbah-format-version
                         :session_id pmbah--session-id
                         :producer (list :id "emacs"
                                         :version pmbah-producer-version
                                         :capabilities ["timing" "pause_fidelity"])
                         :capture_context (or capture-context (pmbah--capture-context nil nil))
                         :events (vconcat (pmbah--session-events))
                         :duration_ms (pmbah--elapsed-ms)
                         :created_client_t (format-time-string "%FT%T%z" (current-time) t))
                   (when (and final-text (stringp final-text) (> (length final-text) 0))
                     (list :final_text final-text)))))
    (pmbah--run-helper payload)))

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

(defun pmbah--post-record (body)
  "POST BODY to the ingest API and return the parsed response.
BODY is the public record plus any observation binding."
  (let* ((url-request-method "POST")
         (url-request-extra-headers '(("Content-Type" . "application/json; charset=utf-8")))
         (url-request-data (encode-coding-string (pmbah--json-encode body) 'utf-8))
         (endpoint (concat (string-remove-suffix "/" pmbah-api-base-url) "/api/records"))
         (buffer (url-retrieve-synchronously endpoint t t 30)))
    (unless buffer
      (user-error "PMBAH upload failed: no response from %s" endpoint))
    (unwind-protect
        (with-current-buffer buffer
          (let ((status url-http-response-status))
            (goto-char (or url-http-end-of-headers (point-min)))
            (let ((body (buffer-substring-no-properties (point) (point-max))))
              (unless (and (integerp status) (>= status 200) (< status 300))
                (user-error "PMBAH upload failed with HTTP %s: %s" status (string-trim body)))
              (json-parse-string body
                                 :object-type 'alist
                                 :array-type 'array
                                 :null-object nil
                                 :false-object :json-false))))
      (kill-buffer buffer))))

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
  (let* ((delta (- pmbah--next-seq pmbah--observation-committed-count))
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
Errors are recorded as transient failures; nothing propagates to the
change hook that triggered the checkpoint."
  (setq pmbah--observation-in-flight t
        pmbah--observation-queued nil
        pmbah--observation-last-attempt (float-time)
        pmbah--observation-attempt (1+ pmbah--observation-attempt))
  (pmbah--observation-arm-watchdog)
  (let* ((source (current-buffer))
         (session-id pmbah--session-id)
         (attempt pmbah--observation-attempt)
         (event-count pmbah--next-seq)
         (payload (pmbah--chain-tip-payload)))
    (condition-case error
        (setq pmbah--observation-request
              (pmbah--run-node-script-async
               pmbah-chain-tip-script payload
               (lambda (result failure)
                 (pmbah--observation-continue source session-id attempt
                   (lambda ()
                     (let ((chain-tip (and (not failure) (alist-get 'chain_tip result))))
                       (cond
                        (failure
                         (pmbah--observation-fail 'transient 0 failure))
                        ((not (and (stringp chain-tip)
                                   (eql (alist-get 'event_count result) event-count)))
                         (pmbah--observation-fail 'transient 0 "helper returned an unexpected chain tip"))
                        (t
                         (pmbah--set-chain-tip chain-tip event-count)
                         (pmbah--observation-post event-count chain-tip)))))))))
      (error
       (pmbah--observation-fail 'transient 0 (error-message-string error))))))

(defun pmbah--chain-tip-payload ()
  "Return the chain-tip helper input for the events captured so far.
When an earlier tip is known, only the events after it are sent, together
with that tip and its event count, so a checkpoint costs the new events
rather than the whole session."
  (let ((events (pmbah--session-events)))
    (if (and pmbah--chain-tip (> pmbah--chain-tip-event-count 0)
             (< pmbah--chain-tip-event-count (length events)))
        (list :session_id pmbah--session-id
              :format_version pmbah-format-version
              :previous_chain_tip pmbah--chain-tip
              :previous_event_count pmbah--chain-tip-event-count
              :events (vconcat (nthcdr pmbah--chain-tip-event-count events)))
      (list :session_id pmbah--session-id
            :format_version pmbah-format-version
            :events (vconcat events)))))

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
        (funcall thunk)))))

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
          pmbah--session-id))

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
          (setq pmbah--observation-request response-buffer)
          (let ((process (and response-buffer (get-buffer-process response-buffer))))
            (when process
              (set-process-query-on-exit-flag process nil))))
      (error
       (pmbah--observation-fail 'transient 0 (error-message-string error))))))

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
       (setq pmbah--observation-last-failure failure)))
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
    (list :observed_session_id pmbah--session-id :token pmbah--observation-token))
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
  (let* ((stdout (generate-new-buffer " *pmbah-node-stdout*"))
         (stderr (generate-new-buffer " *pmbah-node-stderr*"))
         (stderr-pipe (make-pipe-process :name "pmbah-node-stderr" :buffer stderr
                                         :noquery t :sentinel #'ignore))
         (process (make-process
                   :name "pmbah-node"
                   :buffer stdout
                   :stderr stderr-pipe
                   :command (list pmbah-node-command script)
                   :coding 'utf-8
                   :connection-type 'pipe
                   :noquery t
                   :sentinel
                   (lambda (proc _event)
                     (when (memq (process-status proc) '(exit signal))
                       (let ((exit-status (process-exit-status proc))
                             (output (with-current-buffer stdout (buffer-string)))
                             (errors (with-current-buffer stderr (buffer-string))))
                         (when (process-live-p stderr-pipe)
                           (delete-process stderr-pipe))
                         (kill-buffer stdout)
                         (kill-buffer stderr)
                         (pmbah--deliver-node-result callback proc exit-status output errors)))))))
    ;; A process that died before reading its input makes sending fail; its
    ;; sentinel is the single place that reports, so the error is not reported here.
    (condition-case nil
        (progn
          (process-send-string process (pmbah--json-encode payload))
          (process-send-eof process))
      (error
       (when (process-live-p process)
         (delete-process process))))
    process))

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
  "Return chronological public events for the active session."
  (nreverse (copy-sequence pmbah--events)))

(defun pmbah--elapsed-ms ()
  "Return integer milliseconds since the current session started."
  (if pmbah--session-start-time
      (max 0 (floor (* 1000 (float-time (time-subtract (current-time) pmbah--session-start-time)))))
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

(provide 'pmbah-mode)
;;; pmbah-mode.el ends here
