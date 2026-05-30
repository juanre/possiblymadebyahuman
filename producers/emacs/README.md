# Emacs producer

Native Emacs producer for PossiblyMadeByAHuman (PMBAH) content-blind writing records.

`pmbah-mode` is a buffer-local minor mode. It records Emacs buffer mutations from
`after-change-functions`, builds a PMBAH format `0.1` record locally, uploads only
the public content-blind record to an ingest API, and copies the returned short URL
to the kill ring.

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
  object (`scheme`, `policy`, `canonical_length`, `commitment`) survives. The text never
  leaves your machine. This is a local-compute exception, not a storage exception.
- Absolute local file paths are noted as omitted at sign time and are not
  uploaded by default.
- Emacs buffer names and major modes can identify a document or workflow; the
  mode asks before including them in `capture_context`.
- This producer does not make or imply a human/AI verdict. It records facts about
  an editing session.

## Files

- `pmbah-mode.el` — Emacs minor mode and upload flow.
- `scripts/build-record.mjs` — local helper that uses the shared TypeScript
  format package to compute BLAKE3 record hash chains and verification over the
  public process record.

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

## Usage

1. Open a writing buffer. It may already contain text; PMBAH records only later
   mutation metadata.
2. Enable capture:

   ```elisp
   M-x pmbah-mode
   ```

3. Write normally. The mode line shows `PMBAH:N`, where `N` is the local event
   count.
4. Check status when desired:

   ```elisp
   M-x pmbah-show-session-status
   ```

5. Freeze, optionally bind the document text, answer capture-context prompts,
   upload, and copy the short URL:

   ```elisp
   M-x pmbah-sign-buffer
   ```

6. If you want to throw away the local session without uploading:

   ```elisp
   M-x pmbah-discard-session
   ```

After a successful upload, the local event log is cleared and a fresh session is
started for the current buffer. If upload fails, the local event log remains so
you can retry.

## Verify the installation

A quick public-service check:

1. In Emacs, open a buffer and run `M-x pmbah-mode`.
2. Type a short draft.
3. Run `M-x pmbah-show-session-status`; confirm the API URL is
   `https://possiblymadebyahuman.com`.
4. Run `M-x pmbah-sign-buffer`; answer the binding and capture-context prompts,
   upload, and confirm a short URL is copied to the kill ring.

For a local development check instead, start with `make local-container` (or
`PMBAH_PORT=18800 make local-container`) and set `PMBAH_API_BASE_URL` /
`pmbah-api-base-url` to the matching local origin.

## Sign-time binding and capture context

`pmbah-sign-buffer` asks whether to bind the document text to the record. If you
bind it, the text used is:

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
- confirm default capture context avoids absolute file paths.

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
