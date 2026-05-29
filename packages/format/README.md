# `@possiblymadebyahuman/format`

Core content-blind event-log contract package for PMBAH format versions `0.1` and `0.2`.

## Responsibility

- Event mutation, public manifest, producer, capture-context, source, capability, and signal-adjacent shared types.
- UUIDv4 session-id validation for public manifests.
- Canonical JSON serialization for public event objects.
- BLAKE3 `b3:` hashing helpers for public process records.
- Event hash-chain computation and verification for `0.1` and `0.2` records.
- Format `0.2` `text_binding` helpers for local `canon-letters/0.1` commitments and exact/prefix candidate checks, using pinned Unicode 17.0.0 full case folding.
- Observed process-length math from public mutation positions/lengths, returning `null` when unknown measurements make length unknowable.
- Record verification helper for public manifest/event structure plus hash-chain checks.

## Non-responsibility

- UI, HTTP routing, storage implementations, analyzer conclusions, or producer capture mechanics.
- Text reconstruction, plaintext upload/storage, or inserted-text fixtures in production/public APIs.
- Plaintext storage for public records.
- Human/AI verdicts, scores, or badges.

Public records are content-blind. They do not contain `ins_text`, `ins_hash`,
`final_text`, `final_text_hash`, or `final_text_length`. Format `0.2` text binding
stores only a salted commitment over a lossy local canonical form; candidate text
checks stay client-side. Unknown public mutation
measurements use explicit JSON `null` for `pos`, `del_len`, and `ins_len`; those
fields are not omitted.

The public manifest field for multi-session linkage is `parent_record`.
`parent_record_hash` is reserved for future storage/database internals and is
rejected in public manifest validation.
