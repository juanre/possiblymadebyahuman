---
title: "Content-blind privacy model"
summary: "What public records store, what they deliberately do not, and what the signer controls before upload."
---

The default mode of `possiblymadebyahuman` is **content-opaque**. Public records describe the shape of an editing process. They do not contain, store, or reconstruct the document's text.

## What public records contain

- A canonical event log of buffer mutations: `seq`, `t`, `op`, `pos`, `del_len`, `ins_len`, and `source`. Each numeric field carries a content-opaquely derived number; when a producer cannot derive a value without inspecting text it cannot capture, the field is explicit `null` rather than a guess.
- A manifest with the BLAKE3 chain hash over the canonical events, producer identity and version, declared capabilities, capture context (when provided), event count, and duration.
- Precomputed statistics: typing/paste/cut/drop/IME/autocomplete/programmatic/unknown counts, codepoints inserted/deleted, largest atomic insert, inter-event delay percentiles, active/idle time, and a delay histogram.
- Analyzer signals, each with explicit measures and an explanation.

## What public records do not contain

- The text of the document. Producers may transiently inspect text in-memory to derive a numeric field (e.g. paste length), but the string is discarded in the same statement and never recorded.
- Any text-content hash. The BLAKE3 chain hash is computed over the canonical *process events*, never over text.
- Final-text hashes, full-buffer hashes, inserted-text hashes, or any other fingerprint of text content.
- Any account, email, or directly identifying user field. There is no user system in v0.

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

## What we cannot offer

- Deletion of uploaded records. There is no public deletion API in v0. Permanence is the price of not asking for an account.
- Confidentiality against an attacker who already has the plaintext: the system is about *not* uploading text, not about protecting text the signer chose to publish elsewhere.
- A guarantee that a third party did not separately keep a copy of the writing. We can only describe what *this* service stores.
