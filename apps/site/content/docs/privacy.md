---
title: "Content-blind privacy model"
summary: "What public records store, what they do not, and what the signer controls before upload."
group: "How it holds up"
weight: 2
---

`possiblymadebyahuman` is **content-blind**. Public records describe the shape of an editing process. They do not contain, store, upload, or reconstruct the document's text. If the signer chooses to bind a document, the producer computes a content-blind commitment to it locally and uploads only that commitment: a salted hash of the text's canonical letters and digits, which contains no plaintext but allows anyone to test guesses against it. See [Bind and check a document](/docs/checking-a-document/).

## What public records contain

- A canonical event log of buffer mutations: `seq`, `t`, `op`, `pos`, `del_len`, `ins_len`, and `source`. Each numeric field carries a content-blindly derived number; when a producer cannot derive a value without retaining text, the field is explicit `null` rather than a guess.
- A manifest with the BLAKE3 record hash, producer identity and version, declared capabilities, capture context (when provided), event count, and duration. Format 0.3 also seals elapsed finish time and an optional link to a previous record into the hash; earlier formats retain their original hash rules.
- Precomputed statistics: typing/paste/cut/drop/IME/autocomplete/programmatic/unknown counts, codepoints inserted/deleted when known, largest atomic insert, observed process length when known, inter-event delay percentiles, active/idle time, and a delay histogram.
- Analyzer signals, each with explicit measures and an explanation.
- An optional `text_binding`, only when the signer chose to bind a document: its `scheme`, `canonical_length`, and the salted `commitment`. This is a content-blind fingerprint of the signed text's canonical letters/digits; it allows anyone to test candidate wording. See [Bind and check a document](/docs/checking-a-document/).

## What public records do not contain

- The text of the document. Producers may transiently inspect text in-memory to derive a numeric field (e.g. paste length), but the string is discarded after the local measurement and never recorded.
- Any text-content hash *other than* the optional `text_binding` commitment described above. The BLAKE3 event chain is computed over canonical *process events*, never over text; the only text-derived value a record may carry is the binding commitment, which is salted and computed locally, and only when the signer chose to bind.
- No inserted-text hashes, per-mutation text fingerprints, or full-buffer hashes. The binding (when present) commits once to the canonical letters/digits of the selected text as a whole; nothing fingerprints individual insertions or the raw buffer.
- Any dedicated account or identity field. There is no user system, though capture context can identify a person or document.

## What producers may do transiently

A producer may inspect editor text synchronously when an editor/browser API makes that necessary to derive process metadata such as position, inserted length, deleted length, or selection range. The string must then be discarded. Apart from the optional `text_binding` commitment computed at sign time (and the Emacs helper's approved local-transient receipt of the final text solely to compute that commitment), the inspected string must not be retained in capture state, browser storage, logs, helper payloads, uploaded JSON, or any content hash.

## What the signer controls

The browser extension starts only in an editor you explicitly choose, using the context menu, keyboard shortcut, or side panel. Other fields remain inactive. It shows controls in the browser side panel, not over the webpage. Reloading, navigating to a new page document, stopping, or finishing ends capture authorization. Old local drafts do not activate a new page. Focusing a field only updates the panel’s editor context; it does not authorize capture.

Producers offer a review before upload, so the signer can:

- review or omit `capture_context` (page title, URL, buffer name, major mode);
- strip query strings and fragments from URLs;
- review the text-check scope; `/write` and Emacs also offer a choice to omit the commitment;
- decide not to sign at all.

## Capture context, specifically

- Browser URLs strip query strings and fragments by default. The producer shows what would be uploaded.
- Browser page titles can be identifying and are shown to the signer before upload.
- Emacs buffer names can be identifying and are shown to the signer before upload.
- Absolute local file paths are not uploaded by default.
- On the public record page, capture context is presented as *provenance context*, not as proof of authorship.

## Producer-side local storage

Each producer keeps editing measurements and session state on your machine under the retention rules below. Saved state contains no document text. Metadata such as page titles, URLs and private names can still be identifying.

- **Browser extension.** Extension 0.2.1 and the 0.3.0 candidate keep unsigned per-field session event logs in `chrome.storage.local` under the key `pmbah:sessions:v1` until explicit removal, without automatic expiry. Restarting or reloading detaches capture; resuming a draft requires choosing its field explicitly. Each session record holds numeric events, session metadata, the BLAKE3 chain tip, producer identity, the `observed_session_id`, and a bearer `token` used to authenticate server-observed checkpoints. The bearer token is held in `SessionRecord.observation.last_observed_token` and sent only to the ingest service for checkpoints and record binding; it is not logged, not sent to content scripts, not exposed to page JavaScript, and not included in any public record. If you bind a document at sign time, capture is stopped first and the content script reads selected text in the explicitly chosen field/editor, or all current content of that field/editor when nothing is selected, transiently to compute the content-blind binding commitment; only the binding object is passed to the service worker/upload. Regression checks (`tests/browser-extension-canary.test.mjs`) cover token isolation and plaintext boundaries.
  After upload, the extension clears the local event log and checkpoint credentials after a short grace period and retains a small saved-link reference until explicit removal. Startup, field registration and an hourly alarm perform this cleanup without expiring drafts or links. Browser-data clearing or uninstall can remove local history. Later edits do not automatically start another record, and published records remain immutable.
  The 0.3.0 candidate adds private card names, collapsed searchable saved history and a JSON export of all saved links. Names are stored separately from public capture context and are not automatically copied into the public label. The export includes those private names, site information, dates, record hashes and links; it contains neither document text nor checkpoint credentials. Share the export only if you want to share that metadata. Removing saved links affects this browser only. **Continue in chosen field** creates a separate linked record; the original public record and local saved link remain unchanged.
- **`/write` first-party page.** The drafting canvas keeps session events in `window.localStorage` while you write. The state shape is the same numeric event log as the extension, with no text. The page records edits only from the empty drafting canvas; it does not read other tabs, other pages, or any text you wrote before opening the page. If you bind a document at sign time, it binds selected text in the writing canvas, or all current canvas content when nothing is selected; only the content-blind binding object is uploaded.
  The `/write` canvas text is not saved locally. Copy your writing elsewhere before reloading or closing the page. A saved process record cannot restore it.
- **Emacs `pmbah-mode`.** Session state lives in buffer-local variables and, for file buffers, owner-only JSON files under `pmbah-state-directory` (by default `~/.emacs.d/pmbah/`). These contain numeric events, session metadata, observation state and its bearer token, never document text. A file buffer can resume after closing or restarting Emacs. Upload or discard deletes its current state file. Unreadable or incompatible state, or state outside the exact JSON integer time range, is renamed with a `.stale` suffix and kept until you remove it. The helper is passed numeric process metadata only, with one approved exception: if you bind a document at sign time, it receives the active region when one is active, otherwise the whole buffer, transiently to compute the content-blind binding commitment, then discards it. It never persists text, and it computes no text-derived value other than that commitment. The session is cleared after a successful upload; on failed upload it stays available locally for retry.

## Signed finish and time away

The extension 0.3.0 candidate seals elapsed time at confirmed finish into format 0.3 records. Time away remains in that duration, including a pause followed only by publication. The frozen record is saved locally before network work, so retries keep the same finish time. This is a client-supplied elapsed-time claim; it does not establish continuous server observation or continuous capture.

Explicit continuation creates a new session with a public `parent_record` hash linking to the earlier record. Its clock starts at the prior signed finish, or at a retained local upload-time approximation for older saved records. This relationship makes the two public records linkable. An unfinished draft resumed after a gap retains its original clock and measurements, but missed edits remain unobserved. No text snapshot is stored to bridge the gap.

Existing format 0.1 drafts keep their last-edit timing, and failed legacy uploads keep their frozen format. `/write` and Emacs have not opted into signed-finish format 0.3. Active and idle statistics describe intervals between captured edits; they do not account for time before the first edit or after the last.

## Server-observed checkpoints

When the producer can reach the ingest service while you write, it commits chain tips at activity-driven cadence (first mutation immediate, then every 50 events or every 60 seconds with at least one new event since the last attempt; never on idle). Each checkpoint sends only `(observed_session_id, event_count, chain_tip, token?)`: a BLAKE3 prefix hash over the event sequence, no text. The server stores `token_hash`, never the bearer token itself. See [Server-observed commitments](/docs/server-observed-commitments/) for the public record's view of this surface.

Unfinalized server checkpoint metadata has no automatic expiry, so a resumed session can retain evidence from before a long absence. Discarding local data does not delete server checkpoint metadata.

If the producer cannot reach the ingest service, checkpoint attempts fail while capture continues locally. The retention rules above still apply.

## What we cannot offer

- Deletion of uploaded records. There is no public deletion API. Permanence is the price of not asking for an account. If a record contains material that is clearly abusive (spam, illegal content) and is reported to the maintainers, the service operator may remove it on a case-by-case basis. See [Terms / Service Notes](/docs/terms/).
- Secrecy for predictable bound text. The binding's salt is public, so anyone can test guesses against it; short or predictable text may be guessed. Binding is not encryption. `/write` and Emacs let you turn it off; extension 0.3.1 includes it in normal publication and offers an editing-activity-only fallback if the scope is unavailable or the hash cannot be computed.
- A guarantee that a third party did not separately keep a copy of the writing. We can only describe what *this* service stores.

## Contact

Privacy questions, ambiguities in this document, or concerns about a specific record are tracked at the project's [GitHub issues](https://github.com/juanre/possiblymadebyahuman/issues). There is no separate privacy contact endpoint; the issue tracker is the canonical channel.
