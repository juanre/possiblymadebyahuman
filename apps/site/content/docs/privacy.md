---
title: "Content-blind privacy model"
summary: "What public records store, what they deliberately do not, and what the signer controls before upload."
---

The default mode of `possiblymadebyahuman` is **content-blind**. Public records describe the shape of an editing process. They do not contain, store, upload, or reconstruct the document's text. If the signer chooses to bind a document, the producer computes a content-blind commitment to it locally and uploads only that commitment — a salted hash of the text's canonical letters and digits, which cannot be turned back into the text. See [Bind and check a document](/docs/checking-a-document/).

## What public records contain

- A canonical event log of buffer mutations: `seq`, `t`, `op`, `pos`, `del_len`, `ins_len`, and `source`. Each numeric field carries a content-blindly derived number; when a producer cannot derive a value without retaining text, the field is explicit `null` rather than a guess.
- A manifest with the BLAKE3 chain hash over the canonical events, producer identity and version, declared capabilities, capture context (when provided), event count, and duration.
- Precomputed statistics: typing/paste/cut/drop/IME/autocomplete/programmatic/unknown counts, codepoints inserted/deleted when known, largest atomic insert, observed process length when known, inter-event delay percentiles, active/idle time, and a delay histogram.
- Analyzer signals, each with explicit measures and an explanation.
- An optional `text_binding`, only when the signer chose to bind a document: its `scheme`, `policy`, `canonical_length`, and the salted `commitment`. This is a content-blind fingerprint of the signed text's canonical letters/digits — it cannot be turned back into the text. See [Bind and check a document](/docs/checking-a-document/).

## What public records do not contain

- The text of the document. Producers may transiently inspect text in-memory to derive a numeric field (e.g. paste length), but the string is discarded in the same statement and never recorded.
- Any text-content hash *other than* the optional `text_binding` commitment described above. The BLAKE3 chain hash is computed over the canonical *process events*, never over text; the only text-derived value a record may carry is the binding commitment, which is salted, computed locally, and cannot reconstruct the text — and only when the signer chose to bind.
- No inserted-text hashes, per-mutation text fingerprints, or full-buffer hashes. The binding (when present) commits once to the canonical letters/digits of the selected text as a whole; nothing fingerprints individual insertions or the raw buffer.
- Any account, email, or directly identifying user field. There is no user system in v0.

## What producers may do transiently

A producer may inspect editor text synchronously when an editor/browser API makes that necessary to derive process metadata such as position, inserted length, deleted length, or selection range. The string must then be discarded. Apart from the optional `text_binding` commitment computed at sign time — and the Emacs helper's approved local-transient receipt of the final text solely to compute that commitment — the inspected string must not be stored in session state, browser storage, Emacs variables, logs, helper payloads, uploaded JSON, or any content hash.

## What the signer controls

Producers (the browser extension and the Emacs minor mode) show every record to the signer before upload, so the signer can:

- review or omit `capture_context` (page title, URL, buffer name, major mode);
- strip query strings and fragments from URLs;
- confirm that no plaintext field is being uploaded;
- decide not to sign at all.

## Capture context, specifically

- Browser URLs strip query strings and fragments by default. The producer shows what would be uploaded.
- Browser page titles can be identifying and are shown to the signer before upload.
- Emacs buffer names can be identifying and are shown to the signer before upload.
- Absolute local file paths are not uploaded by default.
- On the public record page, capture context is presented as *provenance context*, not as proof of authorship.

## Producer-side local storage

Each producer keeps a small amount of state on your machine while a session is open. None of that state contains your text.

- **Browser extension.** Unsigned per-field session event logs are kept in `chrome.storage.local` under the key `pmbah:sessions:v1`, swept by a `chrome.alarms` job 3 days after the session's last edit. Each session record holds numeric process metadata (the event log, the BLAKE3 chain tip, the producer identity), the `observed_session_id`, and a bearer `token` used to authenticate server-observed checkpoints. The bearer token never leaves `SessionRecord.observation.last_observed_token` — it is not logged, not sent to content scripts, not exposed to page JavaScript, and not included in any public record. A static source audit (`tests/browser-extension-canary.test.mjs`) asserts this on every build.
- **`/write` first-party page.** The drafting canvas keeps session events in `window.localStorage` while you write. The state shape is the same numeric event log as the extension, with no text. The page records edits only from the empty drafting canvas; it does not read other tabs, other pages, or any text you wrote before opening the page.
- **Emacs `pmbah-mode`.** Session state lives in buffer-local Emacs variables and a small temporary file produced by the Node helper at sign time. The helper is passed numeric process metadata only, with one approved exception: if you bind a document at sign time, it receives the selected text transiently to compute the content-blind binding commitment, then discards it. It never persists text, and it computes no text-derived value other than that commitment. The session is cleared after a successful upload; on failed upload it stays available locally for retry.

## Server-observed checkpoints

When the producer can reach the ingest service while you write, it commits chain tips at activity-driven cadence (first mutation immediate, then every 50 events or every 60 seconds with at least one new event since the last attempt; never on idle). Each checkpoint sends only `(observed_session_id, event_count, chain_tip, token?)` — a BLAKE3 prefix hash over the event sequence, no text. The server stores `token_hash`, never the bearer token itself. See [Server-observed commitments](/docs/server-observed-commitments/) for the public record's view of this surface.

If the producer can't reach the ingest service, no checkpoints are sent and the local event log is retained until you sign (or discard) the session.

## What we cannot offer

- Deletion of uploaded records. There is no public deletion API in v0. Permanence is the price of not asking for an account. If a record contains material that is clearly abusive (spam, illegal content) and is reported to the maintainers, the service operator may remove it on a case-by-case basis. See [Terms / Service Notes](/docs/terms/).
- Confidentiality against an attacker who already has the text: the system is about *not* uploading, hashing, or storing text, not about protecting text the signer chose to publish elsewhere.
- A guarantee that a third party did not separately keep a copy of the writing. We can only describe what *this* service stores.

## Contact

Privacy questions, ambiguities in this document, or concerns about a specific record are tracked at the project's [GitHub issues](https://github.com/juanre/possiblymadebyahuman/issues). v0 has no separate privacy contact endpoint; the issue tracker is the canonical channel.
