---
title: "Write in Emacs"
summary: "Native pmbah-mode for content-blind writing records from GNU Emacs."
eyebrow: "Producer"
---

`pmbah-mode` is a buffer-local minor mode for GNU Emacs 29.1+ that records the shape of your editing as a content-blind process record. When you choose to sign, it uploads only the public, content-blind manifest and event log to the configured ingest service and copies the returned record URL to your kill ring. Nothing about what you typed leaves your machine; only the shape of the editing does.

## What it captures

- Buffer mutations recorded after `pmbah-mode` starts — not raw keystrokes, not OS-level input, and not pre-existing buffer contents.
- If the buffer is already non-empty, the mode still records only later mutation positions/lengths/timing. It does not store a starting buffer length, snapshot, hash, or replay fixture. Some length-derived stats may be `unknown` because the verifier cannot infer total document length from the captured suffix alone.
- Codepoint-anchored process metadata: insert, delete, and replace operations with zero-based Unicode codepoint offsets and lengths. Wall-clock timing relative to the session start.
- Source attribution where reliable. Common Emacs commands (`self-insert-command`, `yank`, `kill-region`, and so on) map to typing / paste / cut / etc.; ambiguous cases fall back to `unknown` rather than guess.

## What it does not capture

- Your document text. No plaintext leaves the producer; the local Node helper that builds the public record is passed numeric process metadata only, never the buffer text.
- Absolute local file paths. The capture-context review preview shows the path as omitted by default.
- Anything outside the buffer `pmbah-mode` is attached to. The mode is per-buffer.

## Requirements

- GNU Emacs 29.1 or newer.
- Node.js available to Emacs. GUI Emacs on macOS / Linux often does not inherit your shell `PATH`; you may need to point Emacs at an absolute Node path (see Configuration below).
- A checkout or release directory containing both `pmbah-mode.el` and `scripts/build-record.mjs`.
- Repository dependencies installed from the repo root with `npm ci` (or `make install`).
- A running ingest service, e.g. `make local-container` for local development.

The Emacs package is not on MELPA / ELPA for v0. Install from a checkout or release archive.

## Install from a checkout

From the repository root:

```sh
git clone https://github.com/juanre/possiblymadebyahuman.git
cd possiblymadebyahuman
npm ci
# or: make install
```

Add the producer directory to your Emacs configuration:

```elisp
(add-to-list 'load-path "/path/to/possiblymadebyahuman/producers/emacs")
(require 'pmbah-mode)
```

If you copy `pmbah-mode.el` somewhere else, keep the helper script in the dependency-installed checkout and point Emacs at it:

```elisp
(setq pmbah-helper-script
      "/path/to/possiblymadebyahuman/producers/emacs/scripts/build-record.mjs")
```

`use-package`:

```elisp
(use-package pmbah-mode
  :load-path "/path/to/possiblymadebyahuman/producers/emacs"
  :commands (pmbah-mode pmbah-sign-buffer pmbah-show-session-status)
  :custom
  (pmbah-helper-script
   "/path/to/possiblymadebyahuman/producers/emacs/scripts/build-record.mjs"))
```

Emacs 29's `package-vc-install` can fetch the Lisp code but does not install npm dependencies for the Node helper. For v0, use a manual checkout / release directory and run `npm ci` there.

## Configuration

### API base URL

`pmbah-api-base-url` defaults to `http://localhost:8000`, matching `make local-container`. To set it explicitly:

```sh
export PMBAH_API_BASE_URL=http://localhost:8000
```

or in Emacs Lisp:

```elisp
(setq pmbah-api-base-url "http://localhost:8000")
```

If you run the local container on a custom port:

```sh
PMBAH_PORT=18800 make local-container
export PMBAH_API_BASE_URL=http://localhost:18800
```

For production, set the value to the deployed HTTPS origin:

```elisp
(setq pmbah-api-base-url "https://<your-pmbah-host>")
```

The real production URL is recorded in the repository release docs once the public service is approved. Do not configure a fake production host as if it were live.

### Node path for GUI Emacs

If GUI Emacs cannot find Node, set either:

```sh
export PMBAH_NODE=/opt/homebrew/bin/node
```

or:

```elisp
(setq pmbah-node-command "/opt/homebrew/bin/node")
```

Use the path printed by `command -v node` in the shell where the repository tests pass.

## Usage

1. Open a writing buffer. It may already contain text; PMBAH records only later mutation metadata.
2. Enable capture: `M-x pmbah-mode`. The mode line shows `PMBAH:N`, where `N` is the local event count.
3. Write normally.
4. Check status when desired: `M-x pmbah-show-session-status`.
5. Freeze, review the capture context, upload, and copy the record URL: `M-x pmbah-sign-buffer`.
6. If you want to throw away the local session without uploading: `M-x pmbah-discard-session`.

After a successful upload, the local event log is cleared and a fresh session starts for the current buffer. If upload fails, the local event log is retained so you can retry.

## Verify the installation

A quick local check:

1. Start the API: `make local-container`.
2. In Emacs, open a buffer and run `M-x pmbah-mode`.
3. Type a short draft.
4. Run `M-x pmbah-show-session-status`; confirm the event count is non-zero and the API URL is the one you expect.
5. Run `M-x pmbah-sign-buffer`; review the capture context preview, upload, and confirm a short URL is copied to the kill ring.

For a custom local port, start with `PMBAH_PORT=18800 make local-container` and set `PMBAH_API_BASE_URL` / `pmbah-api-base-url` to `http://localhost:18800`.

## Capture context review

`pmbah-sign-buffer` opens a `*PMBAH capture context*` preview before upload. It shows:

- the buffer name candidate;
- the major mode candidate;
- absolute file path status (omitted by default);
- the content-blind upload guarantee.

It then asks separately whether to include `emacs.buffer_name` and `emacs.major_mode`. If both are declined, the context is only:

```json
{ "surface": "emacs" }
```

## Event semantics

- Emacs supplies `after-change-functions` arguments `(beg end len)` in character positions. `pmbah-mode` records zero-based Unicode codepoint offsets and lengths.
- `insert`, `delete`, and `replace` are derived from the Emacs mutation.
- Source attribution: the mode identifies a few common commands (`self-insert-command`, `yank`, `kill-region`, and so on) and falls back to `unknown` when attribution is uncertain. It declares the `timing` and `pause_fidelity` capabilities; it does not claim `source_attribution` or `keystroke_level`.
- The mode can start in a non-empty buffer. It records absolute positions and lengths for later mutations only. It does not upload a starting length, text, a text hash, or a replay fixture; length-derived stats may be unknown when capture starts after existing content.

## Troubleshooting

- **`PMBAH helper script is not readable`** — set `pmbah-helper-script` to the helper path in the checkout where you ran `npm ci` / `make install`.
- **`Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@noble/hashes'`** — install repository dependencies from the repo root (`npm ci` or `make install`) and confirm `pmbah-helper-script` points to `producers/emacs/scripts/build-record.mjs` inside that same checkout.
- **`Searching for program: No such file or directory, node`** — GUI Emacs cannot find Node. Set `PMBAH_NODE` or `pmbah-node-command` to an absolute Node path.
- **`generated record failed verification`** — keep the local session and report the sequence; the helper rejected an internally inconsistent public process record before upload.
- **Upload HTTP errors** — confirm `pmbah-api-base-url` points to an ingest service with `POST /api/records`, and that `/ready` is healthy (usually `http://localhost:8000` for `make local-container`).
- **No URL copied** — upload did not complete; the local session is retained for retry.

## Sibling producers

The [browser writing page](/write) is the no-install producer: an empty drafting canvas in your browser that records edits made inside it, signs, and returns a short URL. A capture-all browser extension producer of the same record format is also in the repository (`apps/browser-extension/`); its public install path will be linked here once the Chrome Web Store listing is approved.

All three producers — Emacs, the browser writing page, and the extension — sign content-blind manifests that `packages/format` verifies the same way. See [the verification page](/docs/verification/) for the chain of trust and [the records page](/docs/records/) for the public record format.
