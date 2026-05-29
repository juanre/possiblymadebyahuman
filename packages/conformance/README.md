# `@possiblymadebyahuman/conformance`

Compatibility gate for producers and format implementations.

A producer or verifier is conformant for PMBAH format `0.1`/`0.2` iff it passes
canonicalization, hash-chain, content-blind process-length, text-binding,
golden-record, and capability-accuracy checks that apply to its declared
capabilities.

## Responsibility

- Canonicalization vectors for public process events and `canon-letters/0.1` text bindings.
- Hash-chain vectors over public manifest/event data, including format `0.2` sealed `record_hash` cases.
- Content-blind process-length vectors that use operation positions and lengths,
  not document text; unknown process measurements are explicit JSON `null`.
- Golden sample records without plaintext fields, including sealed text-binding records.
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
- `text-canonicalization.json`
- `text-binding.json`
- `process-length.json`
- `golden-records.json`
- `capability-accuracy.json`

Public vectors are content-blind. They do not contain `ins_text`, `ins_hash`,
`final_text`, `final_text_hash`, or `final_text_length`. Text-binding vectors
store only canonical lengths and `b3:` commitments; candidate plaintext is used
only inside local conformance checks.
