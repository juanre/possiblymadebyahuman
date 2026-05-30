---
title: "Write in Emacs"
summary: "Native pmbah-mode for content-blind writing records from GNU Emacs."
eyebrow: "Producer"
---

`pmbah-mode` is a buffer-local minor mode for GNU Emacs 29.1+ that records the shape of your editing as a content-blind process record. When you choose to sign, it uploads only the public, content-blind manifest and event log to the configured ingest service and copies the returned record URL to your kill ring. Nothing about what you typed leaves your machine; only the shape of the editing does.

## What it captures

- Buffer mutations recorded after `pmbah-mode` starts, not raw keystrokes, OS-level input, or pre-existing buffer contents.
- If the buffer is already non-empty, the mode still records only later mutation positions/lengths/timing. It does not store a starting buffer length, snapshot, hash, or replay fixture. Some length-derived stats may be `unknown` because the verifier cannot infer total document length from the captured suffix alone.
- Codepoint-anchored process metadata: insert, delete, and replace operations with zero-based Unicode codepoint offsets and lengths. Wall-clock timing relative to the session start.
- Source attribution where reliable. Common Emacs commands (`self-insert-command`, `yank`, `kill-region`, and so on) map to typing / paste / cut / etc.; ambiguous cases fall back to `unknown` rather than guess.

## What it does not capture

- Your document text. No plaintext leaves the producer. The local Node helper that builds the public record is passed numeric process metadata only, with one sanctioned exception: if you choose to bind the document at sign time, the helper receives the active region when one is active, otherwise the whole buffer, transiently so it can compute the content-blind binding commitment, then discards it. Only the commitment is uploaded; the text never leaves your machine. See [Bind and check a document](/docs/checking-a-document/).
- Absolute local file paths. The sign-time prompts note that the path is omitted by default.
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

Emacs 29's `package-vc-install` can fetch the Lisp code but does not install npm dependencies for the Node helper. For v0, use a manual checkout / release directory and run `npm ci` there.

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

## Usage

1. Open a writing buffer. It may already contain text; PMBAH records only later mutation metadata.
2. Enable capture: `M-x pmbah-mode`. The mode line shows `PMBAH:N`, where `N` is the local event count.
3. Write normally.
4. Check status when desired: `M-x pmbah-show-session-status`.
5. Freeze, optionally bind the active region or whole buffer, answer y/n capture-context prompts, upload, and copy the record URL: `M-x pmbah-sign-buffer`.
6. If you want to throw away the local session without uploading: `M-x pmbah-discard-session`.

After a successful upload, the local event log is cleared and a fresh session starts for the current buffer. If upload fails, the local event log is retained so you can retry.

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

Use `C-u M-x pmbah-sign-buffer` to skip the prompts and accept the default yes answers: include buffer name and major mode, bind the selected region if active or the whole buffer otherwise, use the "allow extra text before or after it" policy, and affirm the binding.

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

## Sibling producers

The [browser writing page](/write) is the no-install producer: an empty drafting canvas in your browser that records edits made inside it, signs, and returns a short URL. A capture-all browser extension producer of the same record format is also in the repository (`apps/browser-extension/`); its public install path will be linked here once the Chrome Web Store listing is approved.

All three producers (Emacs, the browser writing page, and the extension) sign content-blind manifests that `packages/format` verifies the same way. See [the verification page](/docs/verification/) for the chain of trust and [the records page](/docs/records/) for the public record format.
