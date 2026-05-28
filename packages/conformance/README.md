# `@possiblymadebyahuman/conformance`

Compatibility gate for producers and format implementations.

A producer is conformant for format `0.1` iff it passes the canonicalization, hash-chain, deterministic replay/codepoint, golden-record, and capability-honesty checks that apply to its declared capabilities.

## Responsibility

- Canonicalization vectors.
- Hash-chain vectors.
- Deterministic replay and Unicode codepoint vectors.
- Golden sample records.
- Capability-honesty notes/checks.
- A vector runner that compares implementation output with the checked-in vectors.

## Non-responsibility

- Producer-specific capture code.
- Backend ingestion or storage.
- Analyzer judgment, humanness scoring, or detector language.

## Vectors

Vector files live in `packages/conformance/vectors/`:

- `canonicalization.json`
- `hash-chain.json`
- `replay-codepoint.json`
- `golden-records.json`
- `capability-honesty.json`

Replay and golden-record vectors may include local-only plaintext fixtures such as `ins_text` or `replay_insertions_by_seq`. Those fields are not valid public record fields and exist only to verify deterministic replay.
