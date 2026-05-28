# `@possiblymadebyahuman/format`

Core event-log contract package.

## Responsibility

- Event mutation, manifest, producer, capture-context, source, capability, and related shared types in M1.
- Future canonical JSON serialization, `b3:` hashing, hash-chain verification, deterministic replay, and final-text hash helpers.

## Non-responsibility

- UI, HTTP routing, storage implementations, analyzer conclusions, or producer capture mechanics.
- Plaintext storage for public records.
- Human/AI verdicts, scores, or badges.

M0 contains only scaffold placeholders; core algorithms are intentionally deferred to M1.
