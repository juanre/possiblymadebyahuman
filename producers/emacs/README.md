# Emacs producer

Native Emacs producer for PossiblyMadeByAHuman (PMBAH) content-blind writing records.

`pmbah-mode` is a buffer-local minor mode. It records Emacs buffer mutations from
`after-change-functions`, asks the ingest API to stamp checkpoints of the public
hash chain while you write, builds a PMBAH format `0.2` record locally, uploads
only the public content-blind record to the API, and copies the returned short URL
to the kill ring. Sessions belong to buffers; for file-visiting buffers they are
saved locally so you can close the file, or Emacs, and pick the same session up
days later.

## Privacy and scope

- Captures **buffer mutations after `pmbah-mode` starts**, not physical
  keystrokes, OS-level input, or pre-existing buffer contents.
- If the buffer is already non-empty, the mode still records only later
  mutation positions/lengths/timing. It does not store a starting buffer length,
  snapshot, hash, or replay fixture. Some public length-derived stats may be
  `unknown` because the verifier cannot infer total document length from the
  captured suffix alone.
- Public uploads contain mutation shape, timing, source labels, manifest metadata,
  and public process hashes. They do **not** include plaintext insertion text.
- The local helper payload contains process metadata only, with one exception: when
  you choose to bind the document at sign time, the mode passes the active region
  when one is active, otherwise the whole buffer, to the **local** helper transiently,
  solely so the helper can compute the content-blind text binding (the
  `canon-letters/0.1` commitment) via the shared format
  implementation. The helper discards that text immediately — it is never stored,
  logged, hashed for anything else, uploaded, or reconstructed; only the sealed binding
  object (`scheme`, `canonical_length`, `commitment`) survives. The text never
  leaves your machine. This is a local-compute exception, not a storage exception.
- Server-observed checkpoints send only the event count and the public
  hash-chain tip of the events captured so far (`event_count`, `chain_tip`) to
  `/api/observed-sessions/<session_id>/checkpoints`. The server stamps when it
  saw that prefix. Checkpoints carry no text and no text-derived hashes, and
  they are computed by a second local helper, `scripts/chain-tip.mjs`, which
  refuses any input field other than the session id, format version, public
  events, and the previously computed tip with its event count. After the
  first checkpoint only the events since the last tip are hashed, so a
  checkpoint costs the new events rather than the whole session.
- Session state saved under `pmbah-state-directory` holds the session id, start
  time, format version, public events, and the checkpoint token. It never
  holds document text, the file name, or the file path: the file is named by
  the SHA-256 of the visited file's true name, and the file is written with
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
- `scripts/build-record.mjs` — local helper that uses the shared TypeScript
  format package to compute BLAKE3 record hash chains and verification over the
  public process record.
- `scripts/chain-tip.mjs` — local helper that computes the public hash-chain
  tip of the events captured so far for a checkpoint.

## Requirements

- GNU Emacs 29.1 or newer.
- Node.js available to Emacs. GUI Emacs on macOS/Linux often does not inherit
  your shell `PATH`; configure `pmbah-node-command` or `PMBAH_NODE` if `node`
  is not found.
- A checkout or release directory containing both `pmbah-mode.el` and
  `scripts/build-record.mjs`.
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
      (expand-file-name "producers/emacs/scripts/build-record.mjs"
                        pmbah-checkout-root))
;; Public service; this is also the package default.
(setq pmbah-api-base-url "https://possiblymadebyahuman.com")
```

Change only `pmbah-checkout-root` for your checkout location.

`use-package` users can use the same root variable:

```elisp
(defvar pmbah-checkout-root
  (expand-file-name "~/src/possiblymadebyahuman/"))

(add-to-list 'load-path
             (expand-file-name "producers/emacs" pmbah-checkout-root))

(use-package pmbah-mode
  :commands (pmbah-mode pmbah-sign-buffer pmbah-show-session-status)
  :custom
  (pmbah-api-base-url "https://possiblymadebyahuman.com")
  (pmbah-helper-script
   (expand-file-name "producers/emacs/scripts/build-record.mjs"
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
`locate-user-emacs-file`) holds one state file per visited file. The
directory is created owner-only. Point it elsewhere if your Emacs directory is
synced between machines:

```elisp
(setq pmbah-state-directory "~/.local/state/pmbah/")
```

## Sessions, buffers, and files

- Each buffer records its own session. Several buffers can record at once;
  each one checkpoints, resumes, and signs independently, and switching
  between them does nothing to their sessions.
- The session survives `M-x <major-mode>` and `revert-buffer`, which otherwise
  wipe buffer-local state: recording continues into the same session.
- A file-visiting buffer saves its session to `pmbah-state-directory` after a
  moment of idle time, when the buffer or Emacs is killed, when the mode is
  turned off, and whenever the server accepts a checkpoint. Enabling
  `pmbah-mode` on that file later resumes the session: earlier events are
  kept and new event times continue from the original start, so a break of
  hours or days shows up as a pause, not as a new record.
- A successful upload, or `pmbah-discard-session`, removes the state file and
  starts a fresh session in the buffer.
- Non-file buffers (`*scratch*`, temporary buffers) keep their session in
  memory only; killing the buffer discards it.
- Event times and durations are 32-bit millisecond integers, so one record can
  span at most about 24.8 days. If resuming a saved session would exceed that,
  or the saved state was recorded under a different format version or cannot
  be read, the mode keeps the old state file with a `.stale` suffix, tells you
  with a message, and starts a fresh session.
- Opening the same file in two Emacs instances at once is not supported: both
  would resume the same session and their checkpoints would conflict.

## Usage

1. Open a writing buffer. It may already contain text; PMBAH records only later
   mutation metadata.
2. Enable capture:

   ```elisp
   M-x pmbah-mode
   ```

3. Write normally. The mode line shows `PMBAH:N`, where `N` is the local event
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

Before uploading, the mode sends one last checkpoint covering any events the
server has not stamped yet, so an observed record is observed to its final
event. If no checkpoint ever succeeded during the session (for example, you
wrote offline), the record is uploaded with an explicit `unobserved` state
rather than being stamped for the first time at sign time.

After a successful upload, the local event log and any saved state are cleared
and a fresh session is started for the current buffer. If upload fails, the
local event log remains so you can retry.

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

The repository test suite includes Emacs batch tests that:

- enable `pmbah-mode` in a real empty Emacs buffer;
- perform Unicode, delete, insert, and replace mutations;
- verify codepoint offsets/lengths;
- verify the generated record with `packages/format` structure/hash-chain logic;
- confirm public events do not contain plaintext fields;
- confirm the helper output and uploaded record contain no buffer text, inserted
  text, text hashes, or replay fixtures, and that text passed transiently to
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
  reopen with monotonic event times, removed after upload or discard, and that
  two file buffers keep independent sessions;
- confirm a saved session past the 32-bit time bound is set aside as `.stale`
  and a fresh session starts.

Run them with:

```sh
node --test tests/emacs-producer.test.mjs
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
  ensure `pmbah-helper-script` points to `producers/emacs/scripts/build-record.mjs`
  inside that same checkout.
- `Searching for program: No such file or directory, node`: GUI Emacs cannot find
  Node. Set `PMBAH_NODE` or `pmbah-node-command` to an absolute Node path.
- `generated record failed verification`: keep the local session and report the
  sequence; the helper rejected an internally inconsistent public process record
  before upload.
- Upload HTTP errors: run `M-x pmbah-show-session-status` and confirm
  `pmbah-api-base-url` is `https://possiblymadebyahuman.com` for normal public
  use. `http://localhost:8000` only works when you are running `make
  local-container` locally. The API origin must serve `POST /api/records`, and
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
- `PMBAH: the saved session for <file> ... starting a fresh session`: the saved
  state could not be resumed (too old for a record's 32-bit clock, a different
  format version, or unreadable). It was kept next to the state file with a
  `.stale` suffix.
