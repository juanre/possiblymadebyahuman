# Emacs producer

Native Emacs producer for PossiblyMadeByAHuman (PMBAH) content-blind writing records.

`pmbah-mode` is a buffer-local minor mode. It records Emacs buffer mutations from
`after-change-functions`, builds a PMBAH format `0.1` record locally, uploads only
the public content-free record to an ingest API, and copies the returned short URL
to the kill ring.

## Privacy and scope

- Captures **buffer mutations**, not physical keystrokes or OS-level input.
- Public uploads contain mutation shape, timing, source labels, manifest metadata,
  and hashes. They do **not** include plaintext insertion text.
- Plaintext remains inside Emacs and is passed only to the local Node helper on
  stdin to compute `final_text_hash` and locally verify deterministic replay.
- Absolute local file paths are shown in the preview as omitted and are not
  uploaded by default.
- Emacs buffer names and major modes can identify a document or workflow; the
  mode asks before including them in `capture_context`.
- This producer does not make or imply a human/AI verdict. It records facts about
  an editing session.

## Files

- `pmbah-mode.el` — Emacs minor mode and upload flow.
- `scripts/build-record.mjs` — local helper that uses the shared TypeScript
  format package to compute BLAKE3 hashes, record hash chains, and verification.

## Requirements

- GNU Emacs 29.1 or newer.
- Node.js that can run this repository's TypeScript sources directly, matching
  the repo's normal development runtime.
- Repository dependencies installed with `npm install` from the repository root.
- A running PMBAH ingest API.

## Installation

From this repository, add the producer directory to your Emacs load path:

```elisp
(add-to-list 'load-path "/path/to/possiblymadebyahuman/producers/emacs")
(require 'pmbah-mode)
```

If you install/copy the file elsewhere, set `pmbah-helper-script` to the helper in
this repository:

```elisp
(setq pmbah-helper-script
      "/path/to/possiblymadebyahuman/producers/emacs/scripts/build-record.mjs")
```

## Configuration

Set the ingest API base URL with either the environment variable:

```sh
export PMBAH_API_BASE_URL=http://localhost:8787
```

or Emacs Lisp:

```elisp
(setq pmbah-api-base-url "http://localhost:8787")
```

Optional Node override:

```elisp
(setq pmbah-node-command "/path/to/node")
```

## Usage

1. Open or create a writing buffer.
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

After a successful upload, the local event log is cleared and a fresh session is
started for the current buffer. If upload fails, the local event log remains so
you can retry.

## Capture context review

`pmbah-sign-buffer` opens a `*PMBAH capture context*` preview before upload. It
shows:

- buffer name candidate;
- major mode candidate;
- absolute file path status, explicitly omitted by default;
- the content-blind upload guarantee.

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
- If enabled in a non-empty buffer, the producer starts with a programmatic
  initial snapshot event so local deterministic replay starts from an empty
  buffer without uploading plaintext.
- Emacs hooks describe buffer changes, not every author intention, macro step,
  editor decision, or external cause.

## Local conformance/testing

The repository test suite includes an Emacs batch test that:

- enables `pmbah-mode` in a real Emacs buffer;
- performs Unicode, delete, insert, and replace mutations;
- verifies codepoint offsets/lengths;
- verifies the generated record with `packages/format` replay/hash-chain logic;
- confirms public events do not contain plaintext fields;
- confirms default capture context avoids absolute file paths.

Run it with:

```sh
node --test tests/emacs-producer.test.mjs
```

or as part of the full project check:

```sh
make check
```

## Troubleshooting

- `PMBAH helper script is not readable`: set `pmbah-helper-script` to the helper
  path in this repository.
- `generated record failed verification`: keep the local session and report the
  sequence; the helper rejected an internally inconsistent record before upload.
- Upload HTTP errors: ensure `pmbah-api-base-url` points to an ingest API with
  `POST /api/records` and that the backend is healthy.
- No URL copied: upload did not complete; the local session is retained for
  retry.
