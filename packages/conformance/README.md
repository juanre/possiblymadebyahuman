# `@possiblymadebyahuman/conformance`

Compatibility gate for producers and format implementations.

A producer is conformant for format `0.1` iff it passes canonicalization,
hash-chain, content-opaque process-length, golden-record, and capability-accuracy
checks that apply to its declared capabilities.

## Responsibility

- Canonicalization vectors for public process events.
- Hash-chain vectors over public manifest/event data.
- Content-opaque process-length vectors that use operation positions and lengths,
  not document text; unknown process measurements are explicit JSON `null`.
- Golden sample records without text-derived manifest fields.
- Capability-accuracy notes/checks.
- A vector runner that compares implementation output with the checked-in vectors.

## Non-responsibility

- Producer-specific capture code.
- Backend ingestion or storage.
- Plaintext replay, final text hashing, or inserted-text fixtures.
- Analyzer judgment, humanness scoring, or detector language.

## Vectors

Vector files live in `packages/conformance/vectors/`:

- `canonicalization.json`
- `hash-chain.json`
- `process-length.json`
- `golden-records.json`
- `capability-accuracy.json`

Public v0 vectors are content-opaque. They do not contain `ins_text`,
`ins_hash`, `final_text`, `final_text_hash`, or `final_text_length`.
