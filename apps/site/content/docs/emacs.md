---
title: "Write in Emacs"
summary: "Native pmbah-mode for content-blind writing records from GNU Emacs."
eyebrow: "Producer"
group: "Write a record"
weight: 2
---

`pmbah-mode` is a buffer-local minor mode for GNU Emacs 29.1+ that records the shape of your editing as a content-blind process record. While you write, it asks the ingest service to stamp checkpoints of the public hash chain, so the record can show that the service saw the writing unfold. When you choose to sign, it uploads only the public, content-blind manifest and event log (format `0.2`) to the configured ingest service and copies the returned record URL to your kill ring. Nothing about what you typed leaves your machine; only the shape of the editing does.

## What it captures

- Buffer mutations recorded after `pmbah-mode` starts, not raw keystrokes, OS-level input, or pre-existing buffer contents.
- If the buffer is already non-empty, the mode still records only later mutation positions/lengths/timing. It does not store a starting buffer length, snapshot, hash, or replay fixture. Some length-derived stats may be `unknown` because the verifier cannot infer total document length from the captured suffix alone.
- Codepoint-anchored process metadata: insert, delete, and replace operations with zero-based Unicode codepoint offsets and lengths. Wall-clock timing relative to the session start.
- Source attribution where reliable. Common Emacs commands (`self-insert-command`, `yank`, `kill-region`, and so on) map to typing / paste / cut / etc.; ambiguous cases fall back to `unknown` rather than guess.
- Server-observed checkpoints: the event count and the public hash-chain tip of the events captured so far, sent to the ingest service on the first edit, then after every 50 events or once a minute while you keep editing. Nothing is sent while you are idle. The service stamps when it saw each prefix; the record page shows the span between the first and last stamps as a server-observed span.

## What it does not capture

- Your document text. No plaintext leaves the producer. The local Node helper that builds the public record is passed numeric process metadata only, with one sanctioned exception: if you choose to bind the document at sign time, the helper receives the active region when one is active, otherwise the whole buffer, transiently so it can compute the content-blind binding commitment, then discards it. Only the commitment is uploaded; the text never leaves your machine. See [Bind and check a document](/docs/checking-a-document/). Checkpoints are computed by a second helper that accepts only the session id, format version, public events, and the previously computed chain tip with its event count; after the first checkpoint only the events since that tip are hashed.
- Absolute local file paths. The sign-time prompts note that the path is omitted by default. Saved session state is filed under a hash of the path, not the path itself.
- Anything outside the buffer `pmbah-mode` is attached to. The mode is per-buffer.

## Sessions, buffers, and files

- Each buffer records its own session. You can keep several buffers recording at once; each checkpoints, resumes, and signs on its own.
- The session survives `M-x <major-mode>` and `revert-buffer`; recording continues into the same session.
- For a file-visiting buffer, the session is saved to `pmbah-state-directory` (default `~/.emacs.d/pmbah/`) after a moment of idle time, when the buffer or Emacs is killed, when the mode is turned off, and whenever the service accepts a checkpoint. Enabling `pmbah-mode` on that file later resumes the session: earlier events are kept and new event times continue from the original start, so leaving for hours or days shows up as a pause inside one record. The state file holds the session id, start time, format version, public events, and the checkpoint token — never document text — and is readable only by you.
- A successful upload, or `M-x pmbah-discard-session`, removes the saved state and starts a fresh session.
- Renaming the visited file (`write-file`, `set-visited-file-name`) moves the saved state with it, so the renamed file resumes the same session.
- Non-file buffers keep their session in memory only.
- A record's clock is a 32-bit millisecond counter, so one session can span at most about 24.8 days. If resuming would exceed that, the mode keeps the old state with a `.stale` suffix, tells you, and starts fresh. A live session that reaches the bound, at the next edit or when you sign, is set aside the same way rather than uploaded.

## Requirements

- GNU Emacs 29.1 or newer.
- Node.js available to Emacs. GUI Emacs on macOS / Linux often does not inherit your shell `PATH`; you may need to point Emacs at an absolute Node path (see Configuration below).
- A checkout or release directory containing both `pmbah-mode.el` and `scripts/build-record.mjs`.
- Repository dependencies installed from the repo root with `npm ci` (or `make install`).
- A running ingest service, e.g. `make local-container` for local development.

The Emacs package is not on MELPA / ELPA. Install from a checkout or release archive.

## Install from a checkout

From the repository root:

```sh
git clone https://github.com/juanre/possiblymadebyahuman.git
cd possiblymadebyahuman
npm ci
# or: make install
```

Add one checkout root variable to your Emacs configuration and derive the producer paths from it:

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

Emacs 29's `package-vc-install` can fetch the Lisp code but does not install npm dependencies for the Node helper. Use a manual checkout or release directory and run `npm ci` there.

## Configuration

### API base URL

`pmbah-api-base-url` defaults to the public service:

```elisp
(setq pmbah-api-base-url "https://possiblymadebyahuman.com")
```

You normally do not need to set it. If you previously copied local-development configuration such as `(setq pmbah-api-base-url "http://localhost:8000")`, remove that line or replace it with the HTTPS production URL above.

For local development, override the URL to match your local container:

```sh
PMBAH_PORT=18800 make local-container
export PMBAH_API_BASE_URL=http://localhost:18800
```

For the default local port:

```elisp
(setq pmbah-api-base-url "http://localhost:8000")
```

### Node path for GUI Emacs

If GUI Emacs cannot find Node, set either:

```sh
export PMBAH_NODE=/opt/homebrew/bin/node
```

or:

```elisp
(setq pmbah-node-command "/opt/homebrew/bin/node")
```

Use the path printed by `command -v node` in a shell where Node is available.

### Server-observed checkpoints

`pmbah-observe-process` (default `t`) asks the ingest service to stamp checkpoints while you write. Set it to `nil` to upload records without any observation request. Checkpoints go to `pmbah-api-base-url`; `pmbah-observation-base-url` redirects them elsewhere for testing and should stay `nil` in normal use.

### Session state directory

`pmbah-state-directory` (default `~/.emacs.d/pmbah/`) holds one owner-only state file per visited file. Point it elsewhere if your Emacs directory is synced between machines.

## Usage

1. Open a writing buffer. It may already contain text; PMBAH records only later mutation metadata.
2. Enable capture: `M-x pmbah-mode`. The mode line shows `PMBAH:N`, where `N` is the local event count, followed by `✓` when the service has stamped every event so far, `·` while some are not yet stamped, or `✗` if the service's view diverged from the local session.
3. Write normally. Leave and come back whenever you like; a file buffer resumes its session when you re-enable the mode.
4. Check status when desired: `M-x pmbah-show-session-status` reports the session id, event count, duration, observation state, and API URL.
5. Freeze, optionally bind the active region or whole buffer, answer y/n capture-context prompts, upload, and copy the record URL: `M-x pmbah-sign-buffer`. Before uploading, one last checkpoint covers any events the service has not stamped yet. A session whose checkpoints never reached the service is uploaded with an explicit `unobserved` state rather than being stamped for the first time at sign time.
6. If you want to throw away the local session without uploading: `M-x pmbah-discard-session`.

After a successful upload, the local event log and any saved state are cleared and a fresh session starts for the current buffer. If upload fails, the local event log is retained so you can retry.

## Verify the installation

A quick public-service check:

1. In Emacs, open a buffer and run `M-x pmbah-mode`.
2. Type a short draft.
3. Run `M-x pmbah-show-session-status`; confirm the API URL is `https://possiblymadebyahuman.com`.
4. Run `M-x pmbah-sign-buffer`; answer the y/n binding and capture-context prompts (RET accepts the default `y`), upload, and confirm a short URL is copied to the kill ring.

For a local development check instead, start with `make local-container` (or `PMBAH_PORT=18800 make local-container`) and set `PMBAH_API_BASE_URL` / `pmbah-api-base-url` to the matching local origin.

## Sign-time binding and capture context

`pmbah-sign-buffer` asks whether to bind the selected region or the whole buffer to the record, depending on what is active when you sign. All sign-time questions are y/n prompts where RET accepts the default `y`. If you bind, the text used is:

- the active, non-empty region when `use-region-p` is true; or
- the whole buffer when there is no active region.

In a default modern Emacs configuration, `use-region-p` is true when the region is active and highlighted (for example, set the mark with `C-SPC`, move point so the region is non-empty, or use a mouse/selection command). If there is no active highlighted region, PMBAH deliberately falls back to binding the whole buffer.

The selected text is passed only transiently to the local helper to compute the content-blind `text_binding` commitment, then discarded. Only the binding object is uploaded.

For capture context, `pmbah-sign-buffer` does not open a preview buffer. It prompts separately for whether to include `emacs.buffer_name` and `emacs.major_mode`; absolute file paths are omitted. If both metadata fields are declined, the uploaded `capture_context` is:

```json
{ "surface": "emacs" }
```

That `capture_context` is separate from the optional `manifest.text_binding`; a record can have minimal capture context and still include a document binding.

Use `C-u M-x pmbah-sign-buffer` to skip the prompts and accept the default yes answers: include buffer name and major mode, and bind the selected region if active or the whole buffer otherwise.

## Event semantics

- Emacs supplies `after-change-functions` arguments `(beg end len)` in character positions. `pmbah-mode` records zero-based Unicode codepoint offsets and lengths.
- `insert`, `delete`, and `replace` are derived from the Emacs mutation.
- Source attribution: the mode identifies a few common commands (`self-insert-command`, `yank`, `kill-region`, and so on) and falls back to `unknown` when attribution is uncertain. It declares the `timing` and `pause_fidelity` capabilities; it does not claim `source_attribution` or `keystroke_level`.
- The mode can start in a non-empty buffer. It records absolute positions and lengths for later mutations only. It does not upload a starting length, text, a text hash, or a replay fixture; length-derived stats may be unknown when capture starts after existing content.

## Troubleshooting

- **`PMBAH helper script is not readable`**: set `pmbah-helper-script` to the helper path in the checkout where you ran `npm ci` / `make install`.
- **`Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@noble/hashes'`**: install repository dependencies from the repo root (`npm ci` or `make install`) and confirm `pmbah-helper-script` points to `producers/emacs/scripts/build-record.mjs` inside that same checkout.
- **`Searching for program: No such file or directory, node`**: GUI Emacs cannot find Node. Set `PMBAH_NODE` or `pmbah-node-command` to an absolute Node path.
- **`generated record failed verification`**: keep the local session and report the sequence; the helper rejected an internally inconsistent public process record before upload.
- **Upload HTTP errors**: run `M-x pmbah-show-session-status` and confirm `pmbah-api-base-url` is `https://possiblymadebyahuman.com` for normal public use. `http://localhost:8000` only works when you are running `make local-container` locally. The API origin must serve `POST /api/records`, and `/ready` should be healthy.
- **No URL copied**: upload did not complete; the local session is retained for retry.
- **Mode line stays at `PMBAH:N·`**: no checkpoint has succeeded yet, or the last ones failed. `M-x pmbah-show-session-status` shows the last failure. Failed checkpoints retry with a growing delay (1 s to 60 s) on the next edit; the record can still be signed and is then uploaded as `unobserved` or `partial`.
- **Mode line shows `PMBAH:N✗`**: the service's commitments diverged from the local session, typically because the same file was recorded from two Emacs instances. No further checkpoints are sent. Signing still works: the record is uploaded with an explicit `unobserved` state instead of binding the diverged commitments, and the upload message says so, quoting the last checkpoint failure.
- **`PMBAH: the saved session for <file> ... starting a fresh session`**: the saved state could not be resumed (too old for a record's 32-bit clock, a different format version, or unreadable). It was kept next to the state file with a `.stale` suffix.

## Sibling producers

The [browser writing page](/write) is the no-install producer: an empty drafting canvas in your browser that records edits made inside it, signs, and returns a short URL. An explicit-start browser extension producer of the same record format is also in the repository (`apps/browser-extension/`); its public install path will be linked here once the Chrome Web Store listing is approved.

All three producers (Emacs, the browser writing page, and the extension) sign content-blind manifests that `packages/format` verifies the same way. See [the verification page](/docs/verification/) for the chain of trust and [the records page](/docs/records/) for the public record format.
