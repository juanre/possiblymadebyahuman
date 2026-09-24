# Emacs producer

Native Emacs producer for PossiblyMadeByAHuman (PMBAH) content-blind writing records.

`pmbah-mode` is a buffer-local minor mode. It records Emacs buffer mutations from
`after-change-functions`, asks the ingest API to stamp checkpoints of the public
hash chain while you write, builds a PMBAH format `0.3` record locally, uploads
only the public content-blind record to the API, and copies the returned short URL
to the kill ring. Sessions belong to buffers and are saved locally so you can
close the file, or Emacs, and pick the same session up
days later.

## Privacy and scope

- Captures **buffer mutations after `pmbah-mode` starts**, not physical
  keystrokes, OS-level input, or pre-existing buffer contents.
- If the buffer is already non-empty, the mode still records only later
  mutation positions/lengths/timing. It does not store a starting buffer length,
  snapshot, hash, or replay fixture. Some public length-derived stats may be
  `unknown` because the verifier cannot infer total document length from the
  captured suffix alone.
- The first mutation after a nonempty start or capture gap has an unknown
  position. Resuming, toggling capture, reverting, or edits made while hooks
  were suppressed can introduce a gap. Binding text requires another recorded
  edit after that boundary; signing without a binding remains available.
- Public uploads contain mutation shape, timing, source labels, manifest metadata,
  and public process hashes. They do **not** include plaintext insertion text.
- The local helper receives process metadata and a private numeric-journal path,
  with one exception: when
  you choose to bind the document at sign time, the mode passes the active region
  when one is active, otherwise the whole buffer, to the **local** helper transiently,
  solely so the helper can compute the content-blind text binding (the
  `canon-letters/0.1` commitment) via the shared format
  implementation. That text exists only in the local helper input — it is never stored,
  logged, hashed for anything else, uploaded, or reconstructed; only the sealed binding
  object (`scheme`, `canonical_length`, `commitment`) survives. The text never
  leaves your machine. This is a local-compute exception, not a storage exception.
- Server-observed checkpoints send only the event count and the public
  hash-chain tip of the events captured so far (`event_count`, `chain_tip`) to
  `/api/observed-sessions/<session_id>/checkpoints`. The server stamps when it
  saw that prefix. Checkpoints carry no text and no text-derived hashes, and
  they are computed by a second local helper, `scripts/chain-tip.mjs`, which
  reads the numeric journal from its last verified byte cursor. After the first
  checkpoint only new events are hashed. Its path and cursor stay local; the
  service receives only the event count and chain tip.
- Session state saved under `pmbah-state-directory` holds the session id, start
  time, format version, checkpoint token, and frozen manifest when present.
  Numeric events live in `events-<session-id>.jsonl`; metadata stores only its
  durable count and byte boundary. Neither file holds document text or a document
  path. Reviewed public
  context can include a buffer name. File sessions use the SHA-256 of the visited
  file's true name; non-file sessions use a session UUID. State files have
  owner-only permissions because the token is a bearer secret.
- Absolute local file paths are noted as omitted at sign time and are not
  uploaded by default.
- Emacs buffer names and major modes can identify a document or workflow; the
  mode asks before including them in `capture_context`.
- This producer does not make or imply a human/AI verdict. It records facts about
  an editing session.

## Files

- `pmbah-mode.el` — Emacs minor mode, checkpointing, session persistence, and
  upload flow.
- `scripts/event-journal.mjs` — local helper that uses the shared TypeScript
  format package to recover/verify journals, seal manifests, and publish event
  chunks without loading the complete history into memory.
- `scripts/chain-tip.mjs` — local helper that computes the public hash-chain
  tip of the events captured so far for a checkpoint.
- `scripts/build-record.mjs` — compatibility entry point for existing local
  configurations; new journal descriptors delegate to `event-journal.mjs`.
  Its old array-input interface remains for explicit legacy CLI exports only.

## Requirements

- GNU Emacs 29.1 or newer.
- Node.js available to Emacs. GUI Emacs on macOS/Linux often does not inherit
  your shell `PATH`; configure `pmbah-node-command` or `PMBAH_NODE` if `node`
  is not found.
- A checkout or release directory containing both `pmbah-mode.el` and
  `scripts/event-journal.mjs`.
- Repository dependencies installed from the repository root with `npm ci` (or
  `make install`, which runs the normal npm install path for this repo).
- A running PMBAH ingest API.

The Emacs package is not on MELPA/ELPA for v0. Install from a checkout or release
archive.

## Installation from a checkout

From the repository root:

```sh
git clone https://github.com/juanre/possiblymadebyahuman.git
cd possiblymadebyahuman
npm ci
# or: make install
```

Then add one checkout root variable to your Emacs configuration and derive the
producer paths from it:

```elisp
(defvar pmbah-checkout-root
  (expand-file-name "~/src/possiblymadebyahuman/"))

(add-to-list 'load-path
             (expand-file-name "producers/emacs" pmbah-checkout-root))
(require 'pmbah-mode)

(setq pmbah-helper-script
      (expand-file-name "producers/emacs/scripts/event-journal.mjs"
                        pmbah-checkout-root))
;; Public service; this is also the package default.
(setq pmbah-api-base-url "https://possiblymadebyahuman.com")
```

Change only `pmbah-checkout-root` for your checkout location. Load the package
in your init file before opening writing files; automatic recovery needs its
file-visit hook installed. The `use-package` example below uses `:demand t` for this.

`use-package` users can use the same root variable:

```elisp
(defvar pmbah-checkout-root
  (expand-file-name "~/src/possiblymadebyahuman/"))

(add-to-list 'load-path
             (expand-file-name "producers/emacs" pmbah-checkout-root))

(use-package pmbah-mode
  :demand t
  :commands (pmbah-mode pmbah-sign-buffer pmbah-show-session-status)
  :custom
  (pmbah-api-base-url "https://possiblymadebyahuman.com")
  (pmbah-helper-script
   (expand-file-name "producers/emacs/scripts/event-journal.mjs"
                     pmbah-checkout-root)))
```

Emacs 29 `package-vc-install` can fetch Lisp code, but it does not install npm
dependencies for the Node helper. For v0, prefer a manual checkout/release
directory and run `npm ci` there.

## Configuration

### API base URL

`pmbah-api-base-url` defaults to the public service:

```elisp
(setq pmbah-api-base-url "https://possiblymadebyahuman.com")
```

You normally do not need to set it. If you previously copied local-development
configuration such as `(setq pmbah-api-base-url "http://localhost:8000")`, remove
that line or replace it with the HTTPS production URL above.

For local development, override the URL to match your local container:

```sh
PMBAH_PORT=18800 make local-container
export PMBAH_API_BASE_URL=http://localhost:18800
```

For the default local port:

```elisp
(setq pmbah-api-base-url "http://localhost:8000")
```

Do not publish docs or configs with fake production hosts as if they were live.

### Node path for GUI Emacs

If GUI Emacs cannot find Node, set either:

```sh
export PMBAH_NODE=/opt/homebrew/bin/node
```

or:

```elisp
(setq pmbah-node-command "/opt/homebrew/bin/node")
```

Use the path printed by `command -v node` in the shell where the repo tests pass.

### Server-observed checkpoints

`pmbah-observe-process` (default `t`) asks the ingest API to stamp checkpoints
while you write. Set it to `nil` to upload records without any observation
request:

```elisp
(setq pmbah-observe-process nil)
```

Checkpoints go to `pmbah-api-base-url`. `pmbah-observation-base-url` (default
`nil`) sends them somewhere else; it exists for testing and should stay `nil`
in normal use, because a checkpoint token is only valid on the service that
issued it.

### Session state directory

`pmbah-state-directory` (default `~/.emacs.d/pmbah/`, via
`locate-user-emacs-file`) holds small metadata files, append-only numeric event
journals, and accepted-link archives. The
directory is created owner-only. Point it elsewhere if your Emacs directory is
synced between machines:

```elisp
(setq pmbah-state-directory "~/.local/state/pmbah/")
```

## Sessions, buffers, and files

- Each buffer records its own session. Several buffers can record at once;
  each one checkpoints, resumes, and signs independently, and switching
  between them does nothing to their sessions.
- Enable `M-x pmbah-mode` once for each file you want recorded. Reopening an
  opted-in file automatically verifies and resumes its saved session, including
  after restarting Emacs. Verification runs in a background helper: the mode
  line shows `PMBAH:recovering`, that buffer stays read-only, and other buffers
  remain usable. Even an empty session is saved immediately. Other files stay
  unrecorded; opening them does not start sessions.
- Wait for verification before signing, discarding, or toggling capture. Closing
  a recovering buffer cancels its worker; saved history and the previous capture
  preference remain available for the next visit. Major-mode changes and reverts
  keep the recovery protection in place.
- Toggle `M-x pmbah-mode` off to pause a file. That choice is saved and survives
  reopening; explicitly enable the mode to resume the same history. Set
  `pmbah-auto-resume` to `nil` to require manual activation for all files. Older
  recovery files without a saved preference are treated as enabled.
- The session survives `M-x <major-mode>` and `revert-buffer`, which otherwise
  wipe buffer-local state: recording continues into the same session.
- Every captured mutation appends one numeric journal line and saves small
  metadata before capture returns. Both writes request a file flush; directory
  rename durability still depends on the filesystem, so this is not a guarantee
  against every power-loss scenario. State also saves when Emacs is killed, when the mode is
  turned off, and whenever the server accepts a checkpoint. Reopening
  an opted-in file resumes the session: earlier events are
  kept and new event times continue from the original start, so a break of
  hours, days or months shows up as a pause, not as a new record.
- If saving fails, the event remains in memory and capture makes the buffer
  read-only. `M-x pmbah-retry-save` saves the pending state and resumes unsigned
  capture; a frozen upload remains frozen, and explicitly paused capture stays
  paused. Each edit writes only its new event
  and bounded metadata; it never rewrites the preceding history. Emacs retains
  at most 256 events in its capture tail. Ordinary buffer close and Emacs exit
  are cancelled if recovery state still cannot be saved. This does not prevent
  a forced process termination or replace saving your document with `C-x C-s`.
- If automatic recovery fails, the buffer stays read-only with
  `PMBAH:recover!` in the mode line and a warning explaining why. Saved history
  is retained. Resolve the problem and run `M-x pmbah-mode` to retry. To edit
  privately in that buffer instead, use `C-u -1 M-x pmbah-mode`.
- Recovery streams the journal and validates the acknowledged count and exact
  byte boundary, cached hash prefix, retained observation commitments, and any
  frozen record hash. Only then may it adopt complete appends beyond stale
  metadata or remove an unacknowledged incomplete final line. A missing or
  changed acknowledged prefix stops recovery without truncating the evidence.
  Live session state is installed only after verification and the metadata save
  succeed; errors or cancellation leave recovery safe to retry. Old array
  snapshots remain authoritative until migration succeeds; frozen legacy records
  retain their original hashes.
- A successful upload starts a new segment linked to the accepted record,
  beginning at its signed finish time. The new segment and its parent link are
  saved even before the next edit. Frozen legacy uploads use their local upload
  time as the approximate boundary. Accepted links are retained in
  `published-<session-id>.json` before the old draft state is removed.
  `pmbah-discard-session` removes draft state and starts an unlinked session.
- Renaming the visited file (`write-file`, `set-visited-file-name`) moves the
  state file with it, so the renamed file resumes the same session. If the target
  already has unrelated recovery state, that state is preserved and the current
  session continues saving at its original recovery path, reported in a message.
- Non-file buffers (`*scratch*`, temporary buffers) save their sessions under
  `session-<session-id>.json`. Run `M-x pmbah-recover-session` in an unused buffer
  to select a saved session. Interactive recovery also runs in the background.
  The destination must have no retained PMBAH session, including an empty one.
  If it visits an untracked file, the recovered session is associated with that
  file. Recovery restores capture events or a frozen upload, never document text.
- Event times and durations are exact JSON integer milliseconds, supported
  through 9,007,199,254,740,991 ms, with 64-bit server storage. Months-long
  sessions retain the original clock; backwards system-clock corrections cannot
  make later events run backwards. Unreadable or incompatible state, or a clock
  outside the exact integer range, stops recovery without replacing saved
  history. Only an already-running session that reaches the clock limit is
  retired to a unique `.stale-*` path before starting a new one.
  This does not change existing format versions or record hashes.
- Each recovery file has one writer. A second buffer or Emacs process cannot
  attach to a session while its current owner remains open, including while
  capture is off. Close the owning buffer before recovering it elsewhere.

## Usage

1. Open a writing buffer. It may already contain text; PMBAH records only later
   mutation metadata.
2. Enable capture:

   ```elisp
   M-x pmbah-mode
   ```

3. Write normally. Save your document as usual. Close and reopen the file to
   resume recording automatically; each file keeps its own session. The mode
   line shows `PMBAH:N`, where `N` is the local event
   count, followed by an observation mark when checkpoints are enabled: `✓`
   when the server has stamped every event so far, `·` while some events are
   not yet stamped (or no checkpoint has succeeded yet), and `✗` when the
   server's view of the session diverged from the local one.
4. Check status when desired; it reports the session id, event count,
   duration, observation state, and API URL:

   ```elisp
   M-x pmbah-show-session-status
   ```

5. Freeze, optionally bind the active region or whole buffer, answer y/n
   capture-context prompts, upload, and copy the short URL:

   ```elisp
   M-x pmbah-sign-buffer
   ```

6. If you want to throw away the local session without uploading:

   ```elisp
   M-x pmbah-discard-session
   ```

Before network work, the mode freezes and saves the record, including its signed
finish time. It then sends one last checkpoint covering any events the
server has not stamped yet, so an observed record is observed to its final
event. If no checkpoint ever succeeded during the session (for example, you
wrote offline), the record is uploaded with an explicit `unobserved` state
rather than being stamped for the first time at sign time.

After a successful upload, the old local event log and draft state are cleared,
the accepted link is saved, and a linked segment starts. If upload fails, run
`pmbah-sign-buffer` again to retry exactly the same frozen record, including
after reopening Emacs. The buffer becomes read-only while its record is frozen;
finish or discard it before recording more edits. Turning capture off restores
the buffer's earlier read-only setting for private edits. Frozen legacy uploads keep their
original format and hash. Unsigned `0.2` drafts finish as `0.3` while retaining
their checkpoint prefixes; `0.1` drafts retain their legacy finalization.
When the server specifically rejects an observation binding, a retry drops that
binding while keeping the frozen record and hash unchanged.

Signing streams the immutable journal prefix to seal its manifest. Publication
uses `/api/record-uploads` with chunks of at most the advertised size, capped at
4,096 events locally, and a 30-second deadline per request. Retrying asks the
service for its durable event cursor and sends only the missing suffix. The
private upload capability, journal path, and byte cursor never become public
record fields. Frozen state contains a manifest and prefix reference, not copies
of the entire event history.

Interactive signing runs the scan and publication in background helper processes,
so other buffers remain usable during a long upload. Closing the signing buffer
cancels its local helper and keeps the saved frozen prefix available for recovery.
Noninteractive Lisp callers retain the synchronous, result-returning interface.

Noninteractive Lisp recovery retains a synchronous interface. Automation that
calls `pmbah-mode` immediately after `find-file-noselect` should bind
`pmbah-auto-resume` to `nil` around the visit and explicit activation, or wait
for automatic recovery to finish before issuing session commands.

`pmbah-build-record-for-current-buffer` and `pmbah--session-events` are explicit
diagnostic exports that materialize arrays. Capture, checkpointing, normal
signing, and publication do not call these exports.

For reproducible scale evidence, run `node scripts/benchmark-emacs-journal.mjs`
from the repository root. It seeds four million numeric events over two years
and a four-million-character live buffer, recovers with a 96 MB Node heap limit,
then measures 400 real native edits
and a suffix checkpoint. In the recorded development run, per-edit writes were
792 bytes after four million events versus 767 bytes near the beginning, with a
256-event memory tail and 689-byte metadata. After the recovery corrections, recovery took about 22 seconds;
the subsequent 400 edits took about 308 ms and their checkpoint about 91 ms
while the PostgreSQL integration suite ran concurrently. That benchmark measures
the verification work itself. Automatic reopening now runs it in a worker;
Emacs stays responsive while the recovering buffer remains protected.

## Verify the installation

A quick public-service check:

1. In Emacs, open a buffer and run `M-x pmbah-mode`.
2. Type a short draft.
3. Run `M-x pmbah-show-session-status`; confirm the API URL is
   `https://possiblymadebyahuman.com`.
4. Run `M-x pmbah-sign-buffer`; answer the y/n binding and capture-context
   prompts (RET accepts the default `y`), upload, and confirm a short URL is
   copied to the kill ring.

For a local development check instead, start with `make local-container` (or
`PMBAH_PORT=18800 make local-container`) and set `PMBAH_API_BASE_URL` /
`pmbah-api-base-url` to the matching local origin.

## Sign-time binding and capture context

`pmbah-sign-buffer` asks whether to bind the selected region or the whole buffer
to the record, depending on what is active when you sign. All sign-time questions
are y/n prompts where RET accepts the default `y`. If you bind, the text used is:

- the active, non-empty region when `use-region-p` is true; or
- the whole buffer when there is no active region.

In a default modern Emacs configuration, `use-region-p` is true when the region
is active and highlighted (for example, set the mark with `C-SPC`, move point so
the region is non-empty, or use a mouse/selection command). If there is no active
highlighted region, PMBAH deliberately falls back to binding the whole buffer.

The selected text is passed only transiently to the local helper to compute the
content-blind `text_binding` commitment, then discarded. Only the binding object
is uploaded.

For capture context, `pmbah-sign-buffer` does not open a preview buffer. It
prompts separately for whether to include `emacs.buffer_name` and
`emacs.major_mode`; absolute file paths are omitted. If both metadata fields are
declined, the uploaded `capture_context` is:

```json
{ "surface": "emacs" }
```

That `capture_context` is separate from the optional `manifest.text_binding`; a
record can have minimal capture context and still include a document binding.

Use `C-u M-x pmbah-sign-buffer` to skip the prompts and accept the default yes
answers: include buffer name and major mode, and bind the selected region if
active or the whole buffer otherwise.

## Event semantics and limitations

- Emacs supplies `after-change-functions` arguments `(beg end len)` in character
  positions. The producer records zero-based Unicode codepoint offsets/lengths
  for PMBAH events.
- `insert`, `delete`, and `replace` are represented from the Emacs mutation.
- The mode can identify a few common commands (`self-insert-command`, `yank`,
  `kill-region`, etc.) but falls back to `unknown` when attribution is uncertain.
  It therefore declares `timing` and `pause_fidelity`, not `source_attribution`
  or `keystroke_level`.
- `pmbah-mode` may start in a non-empty buffer. It records absolute positions
  and lengths for later mutations only. It does not upload a starting length,
  text, a text hash, or a replay fixture; length-derived stats may be unknown
  when capture starts after existing content.
- Emacs hooks describe buffer changes, not every author intention, macro step,
  editor decision, or external cause.

## Local conformance/testing

The [recovery and lifecycle review](../../docs/emacs-recovery-review-2026-09-24.md)
records the latest findings, fixes, validation, and remaining boundaries.

The repository test suite includes Emacs batch tests that:

- enable `pmbah-mode` in a real empty Emacs buffer;
- perform Unicode, delete, insert, and replace mutations;
- verify codepoint offsets/lengths;
- verify the generated record with `packages/format` structure/hash-chain logic;
- confirm public events do not contain plaintext fields;
- confirm the helper output and uploaded record contain no buffer text, inserted
  text, unapproved text hashes, or replay fixtures, and that text passed transiently to
  compute the content-blind binding does not leak into the output;
- confirm non-empty buffers start, later absolute positions are retained, and no
  plaintext canaries are uploaded;
- confirm default capture context avoids absolute file paths;
- run the real ingest API in-process and confirm checkpoints are committed while
  writing and bound at sign time, that a session whose checkpoints never reached
  the server uploads as `unobserved`, and that transient failures back off,
  conflicts pin the session, and unavailable sessions reset;
- confirm the session survives a major-mode change and `revert-buffer`;
- confirm a file buffer's session is saved without text, owner-only, resumed on
  reopen with monotonic event times, replaced by an empty successor after upload
  or discard, and that two file buffers keep independent sessions;
- confirm a saved session resumes after 60 days, preserves its history and
  original clock, and can be signed after a backwards clock correction;
- verify reopening empty, active, paused and frozen file sessions, including
  an actual Emacs process restart, independent files, renames, and package reload;
- retain damaged recovery evidence, block silent editing after recovery errors,
  and prevent ordinary close or exit when capture cannot be saved.

Run them with:

```sh
node --test tests/emacs-producer.test.mjs tests/emacs-journal.test.mjs tests/emacs-lifecycle.test.mjs tests/emacs-async-recovery.test.mjs
```

or as part of the full project check:

```sh
make check
```

## Troubleshooting

- `PMBAH helper script is not readable`: set `pmbah-helper-script` to the helper
  path in the checkout where you ran `npm ci` / `make install`.
- `Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@noble/hashes'`: install
  repository dependencies from the repo root (`npm ci` or `make install`) and
  ensure `pmbah-helper-script` points to `producers/emacs/scripts/event-journal.mjs`
  inside that same checkout.
- `Searching for program: No such file or directory, node`: GUI Emacs cannot find
  Node. Set `PMBAH_NODE` or `pmbah-node-command` to an absolute Node path.
- `generated record failed verification`: keep the local session and report the
  sequence; the helper rejected an internally inconsistent public process record
  before upload.
- Upload HTTP errors: run `M-x pmbah-show-session-status` and confirm
  `pmbah-api-base-url` is `https://possiblymadebyahuman.com` for normal public
  use. `http://localhost:8000` only works when you are running `make
  local-container` locally. The API origin must serve `/api/record-uploads`, and
  `/ready` should be healthy.
- No URL copied: upload did not complete; the local session is retained for
  retry.
- Mode line stays at `PMBAH:N·`: no checkpoint has succeeded yet, or the last
  ones failed. `M-x pmbah-show-session-status` shows the last failure. Failed
  checkpoints retry with a growing delay (1 s to 60 s) on the next edit; the
  record can still be signed and is then uploaded as `unobserved` or `partial`.
- Mode line shows `PMBAH:N✗`: the server's commitments diverged from the
  local session, typically because the same file was recorded from two Emacs
  instances. No further checkpoints are sent. Signing still works: the record
  is uploaded with an explicit `unobserved` state instead of binding the
  diverged commitments, and the upload message says so, quoting the last
  checkpoint failure.
- `PMBAH:recovering`: verification is running in the background. Other buffers
  remain usable. Close this buffer to cancel; reopening will retry.
- `PMBAH:recover!`: recovery failed. Inspect `M-x pmbah-show-session-status`
  or `*Warnings*`, fix the reported issue, then retry with `M-x pmbah-mode`.
- `PMBAH: the saved session for <file> ... starting a fresh session`: the saved
  live session reached the exact integer clock limit. Its state was retained
  at the unique `.stale-*` path printed in the message.
