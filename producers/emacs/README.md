# Emacs producer

Native Emacs producer for PossiblyMadeByAHuman (PMBAH) content-opaque writing records.

`pmbah-mode` is a buffer-local minor mode. It records Emacs buffer mutations from
`after-change-functions`, builds a PMBAH format `0.1` record locally, uploads only
the public content-opaque record to an ingest API, and copies the returned short URL
to the kill ring.

## Privacy and scope

- Captures **buffer mutations after `pmbah-mode` starts**, not physical
  keystrokes, OS-level input, or pre-existing buffer contents.
- Public uploads contain mutation shape, timing, source labels, manifest metadata,
  and public process hashes. They do **not** include plaintext insertion text.
- The local helper payload contains process metadata only. The mode does not pass
  buffer text to the helper, compute text hashes, or require text reconstruction.
- By default, `pmbah-mode` refuses to start in a non-empty buffer. Start in an
  empty draft or discard/finish existing text outside PMBAH before enabling it.
- Absolute local file paths are shown in the preview as omitted and are not
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

Then add the producer directory to your Emacs configuration:

```elisp
(add-to-list 'load-path "/path/to/possiblymadebyahuman/producers/emacs")
(require 'pmbah-mode)
```

If you copy `pmbah-mode.el` somewhere else, keep the helper in the dependency
installed checkout and point Emacs at it:

```elisp
(setq pmbah-helper-script
      "/path/to/possiblymadebyahuman/producers/emacs/scripts/build-record.mjs")
```

`use-package` users can do the same manual load-path setup:

```elisp
(use-package pmbah-mode
  :load-path "/path/to/possiblymadebyahuman/producers/emacs"
  :commands (pmbah-mode pmbah-sign-buffer pmbah-show-session-status)
  :custom
  (pmbah-helper-script
   "/path/to/possiblymadebyahuman/producers/emacs/scripts/build-record.mjs"))
```

Emacs 29 `package-vc-install` can fetch Lisp code, but it does not install npm
dependencies for the Node helper. For v0, prefer a manual checkout/release
directory and run `npm ci` there.

## Configuration

### API base URL

`pmbah-api-base-url` defaults to `http://localhost:8000`, matching
`make local-container`.

Environment variable:

```sh
export PMBAH_API_BASE_URL=http://localhost:8000
```

Emacs Lisp:

```elisp
(setq pmbah-api-base-url "http://localhost:8000")
```

If you run the local container on a custom port, match that port:

```sh
PMBAH_PORT=18800 make local-container
export PMBAH_API_BASE_URL=http://localhost:18800
```

For production, set the value to the deployed HTTPS origin, for example:

```elisp
(setq pmbah-api-base-url "https://possiblymadebyahuman.com")
```

Do not publish docs or configs with fake production hosts as if they were live.
Use an explicit placeholder such as `https://<your-pmbah-host>` until the actual
service URL is approved.

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

1. Open an **empty** writing buffer.
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

5. Freeze, review context, upload, and copy the short URL:

   ```elisp
   M-x pmbah-sign-buffer
   ```

6. If you want to throw away the local session without uploading:

   ```elisp
   M-x pmbah-discard-session
   ```

After a successful upload, the local event log is cleared. If the current buffer
is still non-empty, capture is disabled so a new record is not silently started
against existing text; open a new empty buffer for another record. If upload
fails, the local event log remains so you can retry.

## Verify the installation

A quick local check:

1. Start the API: `make local-container`.
2. In Emacs, open a new empty buffer and run `M-x pmbah-mode`.
3. Type a short draft.
4. Run `M-x pmbah-show-session-status`; confirm the event count is non-zero and
   the API URL is the one you expect.
5. Run `M-x pmbah-sign-buffer`; review capture context, upload, and confirm a
   short URL is copied to the kill ring.

For a custom local port, start with `PMBAH_PORT=18800 make local-container` and
set `PMBAH_API_BASE_URL` / `pmbah-api-base-url` to `http://localhost:18800`.

## Capture context review

`pmbah-sign-buffer` opens a `*PMBAH capture context*` preview before upload. It
shows:

- buffer name candidate;
- major mode candidate;
- absolute file path status, explicitly omitted by default;
- the content-opaque upload guarantee.

It then asks separately whether to include `emacs.buffer_name` and
`emacs.major_mode`. If both are declined, the context is only:

```json
{ "surface": "emacs" }
```

## Event semantics and limitations

- Emacs supplies `after-change-functions` arguments `(beg end len)` in character
  positions. The producer records zero-based Unicode codepoint offsets/lengths
  for PMBAH events.
- `insert`, `delete`, and `replace` are represented from the Emacs mutation.
- The mode can identify a few common commands (`self-insert-command`, `yank`,
  `kill-region`, etc.) but falls back to `unknown` when attribution is uncertain.
  It therefore declares `timing` and `pause_fidelity`, not `source_attribution`
  or `keystroke_level`.
- By default, `pmbah-mode` refuses to start in a non-empty buffer. PMBAH records
  captured writing after capture starts; it does not silently baseline an
  existing document or include pre-existing buffer length/hash/structure in a
  record.
- Emacs hooks describe buffer changes, not every author intention, macro step,
  editor decision, or external cause.

## Local conformance/testing

The repository test suite includes Emacs batch tests that:

- enable `pmbah-mode` in a real empty Emacs buffer;
- perform Unicode, delete, insert, and replace mutations;
- verify codepoint offsets/lengths;
- verify the generated record with `packages/format` structure/hash-chain logic;
- confirm public events do not contain plaintext fields;
- confirm the helper payload does not contain buffer text, inserted text, final
  text, text hashes, or text replay fixtures;
- confirm non-empty buffers are refused by default;
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
- Upload HTTP errors: ensure `pmbah-api-base-url` points to an ingest API with
  `POST /api/records`, usually `http://localhost:8000` for `make local-container`,
  and that `/ready` is healthy.
- `PMBAH refuses to start in a non-empty buffer`: this is intentional. Start in
  an empty draft so pre-existing text is not included in the record scope.
- No URL copied: upload did not complete; the local session is retained for
  retry.
