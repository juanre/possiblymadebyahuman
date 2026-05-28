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
(require 'subr-x)
(require 'url)
(require 'url-http)

(defgroup pmbah nil
  "Content-blind PMBAH writing-record producer."
  :group 'convenience
  :prefix "pmbah-")

(defcustom pmbah-api-base-url
  (or (getenv "PMBAH_API_BASE_URL") "http://localhost:8000")
  "Base URL for the PMBAH ingest API.
The producer posts records to `/api/records` below this URL.  The default
matches `make local-container`."
  :type 'string
  :group 'pmbah)

(defcustom pmbah-node-command
  (or (getenv "PMBAH_NODE") "node")
  "Node.js executable used by the local record-building helper.
The helper receives only process metadata and computes public process hashes."
  :type 'string
  :group 'pmbah)

(defcustom pmbah-helper-script
  (expand-file-name "scripts/build-record.mjs"
                    (file-name-directory (or load-file-name buffer-file-name default-directory)))
  "Local helper script that computes PMBAH BLAKE3 hashes and hash chains."
  :type 'file
  :group 'pmbah)

(defconst pmbah-producer-version "0.1.0")
(defconst pmbah-format-version "0.1")

(defvar pmbah-mode)
(defvar url-http-response-status)
(defvar url-http-end-of-headers)

(defvar-local pmbah--session-id nil)
(defvar-local pmbah--session-start-time nil)
(defvar-local pmbah--events nil)
(defvar-local pmbah--next-seq 0)
(defvar-local pmbah--inhibit-capture nil)

(defun pmbah--mode-line ()
  "Return a compact mode-line session status."
  (if (and pmbah-mode pmbah--session-id)
      (format " PMBAH:%d" pmbah--next-seq)
    " PMBAH"))

;;;###autoload
(define-minor-mode pmbah-mode
  "Record this buffer's mutation history as a content-blind PMBAH session.

The mode records buffer mutations, not physical keystrokes.  Uploaded records
contain event shape and public process hashes only; plaintext is not stored,
hashed, passed to the helper, or uploaded."
  :lighter (:eval (pmbah--mode-line))
  (if pmbah-mode
      (condition-case error
          (progn
            (pmbah--assert-empty-buffer-for-start)
            (pmbah--start-session)
            (add-hook 'after-change-functions #'pmbah--after-change nil t))
        (error
         (setq pmbah-mode nil)
         (remove-hook 'after-change-functions #'pmbah--after-change t)
         (signal (car error) (cdr error))))
    (remove-hook 'after-change-functions #'pmbah--after-change t)))

(defun pmbah--assert-empty-buffer-for-start ()
  "Refuse to start capture when the buffer already contains text."
  (unless (= (point-min) (point-max))
    (user-error
     "PMBAH refuses to start in a non-empty buffer; start in an empty draft before writing so existing text is not silently included")))

(defun pmbah--start-session ()
  "Start a fresh per-buffer PMBAH session."
  (setq pmbah--session-id (pmbah--uuid-v4)
        pmbah--session-start-time (current-time)
        pmbah--events nil
        pmbah--next-seq 0))

(defun pmbah--after-change (beg end len)
  "Record a public mutation shape after a buffer change.
BEG, END, and LEN are supplied by `after-change-functions` and are Emacs
character positions/lengths, which match the PMBAH format's Unicode codepoint
unit for these captured text buffers."
  (unless (or pmbah--inhibit-capture (not pmbah-mode) (not pmbah--session-id))
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
  (let* ((seq pmbah--next-seq)
         (event (list :seq seq
                      :t (or timestamp-ms (pmbah--elapsed-ms))
                      :op op
                      :pos pos
                      :del_len del-len
                      :ins_len ins-len
                      :source source)))
    (push event pmbah--events)
    (setq pmbah--next-seq (1+ pmbah--next-seq))))

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
                    (format "PMBAH session %s: %d event%s, duration %d ms, API %s"
                            pmbah--session-id
                            pmbah--next-seq
                            (if (= pmbah--next-seq 1) "" "s")
                            (pmbah--elapsed-ms)
                            pmbah-api-base-url)
                  "PMBAH mode is not active in this buffer.")))
    (when (called-interactively-p 'interactive)
      (message "%s" status))
    status))

;;;###autoload
(defun pmbah-discard-session ()
  "Discard the current local PMBAH event log.
No data is uploaded.  If the buffer is empty, start a fresh session.  If the
buffer is non-empty, disable capture so existing text is not silently included in
a new record scope."
  (interactive)
  (unless pmbah-mode
    (user-error "pmbah-mode is not active"))
  (when (or (not (called-interactively-p 'interactive))
            (yes-or-no-p "Discard this local PMBAH session without uploading? "))
    (if (= (point-min) (point-max))
        (progn
          (pmbah--start-session)
          (message "PMBAH session discarded; new session %s started" pmbah--session-id))
      (remove-hook 'after-change-functions #'pmbah--after-change t)
      (setq pmbah-mode nil
            pmbah--session-id nil
            pmbah--session-start-time nil
            pmbah--events nil
            pmbah--next-seq 0)
      (message "PMBAH session discarded; capture disabled because buffer is non-empty"))))

;;;###autoload
(defun pmbah-sign-buffer (&optional capture-context)
  "Freeze, build, upload, and copy a short URL for the current PMBAH session.

Interactively, show a capture-context preview and ask before including
identifying Emacs metadata.  CAPTURE-CONTEXT is intended for tests or advanced
callers and must be a JSON-serializable plist."
  (interactive)
  (unless pmbah-mode
    (user-error "Enable pmbah-mode before signing a buffer"))
  (when (= pmbah--next-seq 0)
    (user-error "No PMBAH events captured for this buffer"))
  (let* ((context (or capture-context (pmbah-review-capture-context)))
         (record (pmbah-build-record-for-current-buffer context))
         (response (pmbah--post-record record))
         (url (or (alist-get 'url response) (alist-get 'record_hash response))))
    (when url
      (kill-new url))
    (pmbah--start-session)
    (message "PMBAH record uploaded; copied %s" url)
    response))

(defun pmbah-review-capture-context ()
  "Preview and collect capture context for upload.
Absolute file paths are shown as omitted and are not included by default."
  (let* ((buffer-label (buffer-name))
         (mode-label (symbol-name major-mode))
         (file-label (or (buffer-file-name) "not visiting a file"))
         include-buffer-name
         include-major-mode)
    (with-current-buffer (get-buffer-create "*PMBAH capture context*")
      (let ((inhibit-read-only t))
        (erase-buffer)
        (insert "PMBAH capture context preview\n")
        (insert "================================\n\n")
        (insert "The public record is content-blind: it uploads mutation shape, timing, metadata, and hashes, not plaintext.\n\n")
        (insert (format "Buffer name candidate: %s\n" buffer-label))
        (insert (format "Major mode candidate: %s\n" mode-label))
        (insert (format "Absolute file path: omitted by default (%s)\n" file-label))
        (insert "\nYou will be asked before including each identifying metadata field.\n")
        (goto-char (point-min))
        (view-mode 1)))
    (display-buffer "*PMBAH capture context*")
    (setq include-buffer-name (yes-or-no-p (format "Include buffer name `%s` in capture context? " buffer-label)))
    (setq include-major-mode (yes-or-no-p (format "Include major mode `%s` in capture context? " mode-label)))
    (pmbah--capture-context include-buffer-name include-major-mode)))

(defun pmbah-build-record-for-current-buffer (&optional capture-context)
  "Build and locally verify a public PMBAH record for the current buffer.
The returned alist contains only the public `manifest` and `events` shape."
  (alist-get 'record (pmbah--build-record-result capture-context)))

(defun pmbah--build-record-result (&optional capture-context)
  "Return the helper result for the current buffer, including verification facts."
  (unless pmbah--session-id
    (user-error "No active PMBAH session"))
  (when (= pmbah--next-seq 0)
    (user-error "No PMBAH events captured for this buffer"))
  (let* ((payload (list :format_version pmbah-format-version
                        :session_id pmbah--session-id
                        :producer (list :id "emacs"
                                        :version pmbah-producer-version
                                        :capabilities ["timing" "pause_fidelity"])
                        :capture_context (or capture-context (pmbah--capture-context nil nil))
                        :events (vconcat (pmbah--session-events))
                        :duration_ms (pmbah--elapsed-ms)
                        :created_client_t (format-time-string "%FT%T%z" (current-time) t))))
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

(defun pmbah--post-record (record)
  "POST public RECORD to the configured ingest API and return the parsed response."
  (let* ((url-request-method "POST")
         (url-request-extra-headers '(("Content-Type" . "application/json; charset=utf-8")))
         (url-request-data (encode-coding-string (pmbah--json-encode record) 'utf-8))
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
