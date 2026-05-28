# `@possiblymadebyahuman/format`

Core event-log contract package for format version `0.1`.

## Responsibility

- Event mutation, manifest, producer, capture-context, source, capability, and signal-adjacent shared types.
- Canonical JSON serialization for event objects.
- BLAKE3 `b3:` hashing helpers.
- Event hash-chain computation and verification.
- Deterministic replay helpers using Unicode codepoint offsets/lengths.
- Final-text length/hash helpers for local verification and test fixtures.
- Record verification helper for content-blind chain checks and optional local determinism checks.

## Non-responsibility

- UI, HTTP routing, storage implementations, analyzer conclusions, or producer capture mechanics.
- Plaintext storage for public records.
- Human/AI verdicts, scores, or badges.

Plaintext insertion text is accepted only through local replay fixture/provider APIs. It is not part of the public event schema.
