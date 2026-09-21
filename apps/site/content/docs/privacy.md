---
title: "Content-blind privacy model"
summary: "What public records store, what they do not, and what the signer controls before upload."
group: "How it holds up"
weight: 2
---

`possiblymadebyahuman` is **content-blind**. Public records describe the shape of an editing process. They do not contain, store, upload, or reconstruct the document's text. If the signer chooses to bind a document, the producer computes a content-blind commitment to it locally and uploads only that commitment: a salted hash of the text's canonical letters and digits, which contains no plaintext but allows anyone to test guesses against it. See [Bind and check a document](/docs/checking-a-document/).

## What public records contain

- A canonical event log of buffer mutations: `seq`, `t`, `op`, `pos`, `del_len`, `ins_len`, and `source`. Each numeric field carries a content-blindly derived number; when a producer cannot derive a value without retaining text, the field is explicit `null` rather than a guess.
- A manifest with the BLAKE3 chain hash over the canonical events, producer identity and version, declared capabilities, capture context (when provided), event count, and duration.
- Precomputed statistics: typing/paste/cut/drop/IME/autocomplete/programmatic/unknown counts, codepoints inserted/deleted when known, largest atomic insert, observed process length when known, inter-event delay percentiles, active/idle time, and a delay histogram.
- Analyzer signals, each with explicit measures and an explanation.
- An optional `text_binding`, only when the signer chose to bind a document: its `scheme`, `canonical_length`, and the salted `commitment`. This is a content-blind fingerprint of the signed text's canonical letters/digits; it allows anyone to test candidate wording. See [Bind and check a document](/docs/checking-a-document/).

## What public records do not contain

- The text of the document. Producers may transiently inspect text in-memory to derive a numeric field (e.g. paste length), but the string is discarded after the local measurement and never recorded.
- Any text-content hash *other than* the optional `text_binding` commitment described above. The BLAKE3 chain hash is computed over the canonical *process events*, never over text; the only text-derived value a record may carry is the binding commitment, which is salted and computed locally, and only when the signer chose to bind.
- No inserted-text hashes, per-mutation text fingerprints, or full-buffer hashes. The binding (when present) commits once to the canonical letters/digits of the selected text as a whole; nothing fingerprints individual insertions or the raw buffer.
- Any dedicated account or identity field. There is no user system, though capture context can identify a person or document.

## What producers may do transiently

A producer may inspect editor text synchronously when an editor/browser API makes that necessary to derive process metadata such as position, inserted length, deleted length, or selection range. The string must then be discarded. Apart from the optional `text_binding` commitment computed at sign time (and the Emacs helper's approved local-transient receipt of the final text solely to compute that commitment), the inspected string must not be retained in capture state, browser storage, logs, helper payloads, uploaded JSON, or any content hash.

## What the signer controls

Producers (the browser extension and the Emacs minor mode) offer capture-context and binding choices before upload, so the signer can:

- review or omit `capture_context` (page title, URL, buffer name, major mode);
- strip query strings and fragments from URLs;
- choose whether to include a document commitment;
- decide not to sign at all.

## Capture context, specifically

- Browser URLs strip query strings and fragments by default. The producer shows what would be uploaded.
- Browser page titles can be identifying and are shown to the signer before upload.
- Emacs buffer names can be identifying and are shown to the signer before upload.
- Absolute local file paths are not uploaded by default.
- On the public record page, capture context is presented as *provenance context*, not as proof of authorship.

## Producer-side local storage

Each producer keeps a small amount of state on your machine while a session is open. None of that state contains your text.

- **Browser extension.** Unsigned per-field session event logs are kept in `chrome.storage.local` under the key `pmbah:sessions:v1`, swept on startup, field registration, and by an hourly alarm after 3 days without an edit. Each session record holds numeric process metadata (the event log, the BLAKE3 chain tip, the producer identity), the `observed_session_id`, and a bearer `token` used to authenticate server-observed checkpoints. The bearer token is held in `SessionRecord.observation.last_observed_token` and sent only to the ingest service for checkpoints and record binding; it is not logged, not sent to content scripts, not exposed to page JavaScript, and not included in any public record. If you bind a document at sign time, the content script reads selected text in the active field/editor, or all current content of that field/editor when nothing is selected, transiently to compute the content-blind binding commitment; only the binding object is passed to the service worker/upload. Regression checks (`tests/browser-extension-canary.test.mjs`) cover token isolation and plaintext boundaries.
  After upload, the extension clears the local event log after a short grace period and retains a small continuation reference for up to the three-day session TTL. This lets later edits link to the uploaded record, including after a browser restart.
- **`/write` first-party page.** The drafting canvas keeps session events in `window.localStorage` while you write. The state shape is the same numeric event log as the extension, with no text. The page records edits only from the empty drafting canvas; it does not read other tabs, other pages, or any text you wrote before opening the page. If you bind a document at sign time, it binds selected text in the writing canvas, or all current canvas content when nothing is selected; only the content-blind binding object is uploaded.
  The `/write` canvas text is not saved locally. Copy your writing elsewhere before reloading or closing the page. A saved process record cannot restore it.
- **Emacs `pmbah-mode`.** Session state lives in buffer-local variables and, for file buffers, owner-only JSON files under `pmbah-state-directory` (by default `~/.emacs.d/pmbah/`). These contain numeric events, session metadata, observation state and its bearer token, never document text. A file buffer can resume after closing or restarting Emacs. Upload or discard deletes its current state file. Unreadable, incompatible, or over-age state is renamed with a `.stale` suffix and kept until you remove it. The helper is passed numeric process metadata only, with one approved exception: if you bind a document at sign time, it receives the active region when one is active, otherwise the whole buffer, transiently to compute the content-blind binding commitment, then discards it. It never persists text, and it computes no text-derived value other than that commitment. The session is cleared after a successful upload; on failed upload it stays available locally for retry.

## Server-observed checkpoints

When the producer can reach the ingest service while you write, it commits chain tips at activity-driven cadence (first mutation immediate, then every 50 events or every 60 seconds with at least one new event since the last attempt; never on idle). Each checkpoint sends only `(observed_session_id, event_count, chain_tip, token?)`: a BLAKE3 prefix hash over the event sequence, no text. The server stores `token_hash`, never the bearer token itself. See [Server-observed commitments](/docs/server-observed-commitments/) for the public record's view of this surface.

If the producer cannot reach the ingest service, checkpoint attempts fail while capture continues locally. The retention rules above still apply.

## What we cannot offer

- Deletion of uploaded records. There is no public deletion API. Permanence is the price of not asking for an account. If a record contains material that is clearly abusive (spam, illegal content) and is reported to the maintainers, the service operator may remove it on a case-by-case basis. See [Terms / Service Notes](/docs/terms/).
- Secrecy for predictable bound text. The binding's salt is public, so anyone can test guesses against it; short or predictable text may be guessed. Binding is not encryption. You can turn it off and upload a process-only record.
- A guarantee that a third party did not separately keep a copy of the writing. We can only describe what *this* service stores.

## Contact

Privacy questions, ambiguities in this document, or concerns about a specific record are tracked at the project's [GitHub issues](https://github.com/juanre/possiblymadebyahuman/issues). There is no separate privacy contact endpoint; the issue tracker is the canonical channel.
