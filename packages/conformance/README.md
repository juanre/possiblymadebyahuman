# `@possiblymadebyahuman/conformance`

Compatibility gate for producers and format implementations.

## Responsibility

- Canonicalization vectors.
- Hash-chain vectors.
- Deterministic replay and Unicode codepoint vectors.
- Golden sample records.
- A conformance runner that defines what it means for a producer to be compatible with the format.

## Non-responsibility

- Producer-specific capture code.
- Backend ingestion or storage.
- Analyzer judgment, humanness scoring, or detector language.

M0 provides the home for vectors and tests. Real vectors and runner behavior land in M1.
