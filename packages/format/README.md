# `@possiblymadebyahuman/format`

Core content-blind event-log contract package for PMBAH format versions `0.1`, `0.2` and `0.3`.

## Responsibility

- Event mutation, public manifest, producer, capture-context, source, capability, and signal-adjacent shared types.
- UUIDv4 session-id validation for public manifests.
- Canonical JSON serialization for public event objects.
- BLAKE3 `b3:` hashing helpers for public process records.
- Event hash-chain computation and verification for `0.1`, `0.2` and `0.3` records.
- Format `0.3` finalization seals finish duration, optional parent and optional binding over the unchanged `0.2` event-chain domain; existing checkpoints and older record hashes remain valid.
- Format `0.2` `text_binding` helpers for local `canon-letters/0.1` commitments and bounded edge-window candidate checks, using pinned Unicode 17.0.0 full case folding.
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

Event `t` and manifest `duration_ms` accept non-negative safe integers through `Number.MAX_SAFE_INTEGER` (9,007,199,254,740,991 milliseconds). Counts, codepoint positions and lengths keep their signed 32-bit bounds. PostgreSQL time statistics use `bigint`; dates use `timestamptz`. This widened validation does not change format versions, canonical bytes or existing record hashes.

The public manifest field for multi-session linkage is `parent_record`.
`parent_record_hash` is reserved for storage/database internals and is
rejected in public manifest validation.

`computeRecordHash(events, sessionId, "0.3", textBinding, {duration_ms, parent_record})` requires the finalization metadata. `FORMAT_VERSION` remains `0.2` for legacy helper compatibility; producers opt into `FORMAT_VERSION_0_3` explicitly. See the normative [finalization contract](../../docs/spec/canonicalization.md#format-03-finalization).
