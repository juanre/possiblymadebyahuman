# Architecture

This document maps the approved v0 source of truth (`docs/sot.md`) into the repository scaffold. The product specification in `docs/spec.md` remains the product and format thesis; `docs/sot.md` is the implementation source of truth.

## Product boundaries

`possiblymadebyahuman` is a writing-record system, not a detector.

- Public records are content-blind by default: they store edit structure, metadata, statistics, and analyzer facts, not plaintext writing or text-derived hashes.
- Producers may transiently inspect editor text only when necessary to derive numeric process metadata, then must discard it; they do not store, hash, replay, or upload document text.
- The product must not display a human/AI verdict, confidence percentage, humanness score, or certification-style badge.
- Producers emit the event-log contract.
- Ingestion verifies and stores records; it does not make authorship claims.
- Analyzers are pure functions that return descriptive signals.
- Presentation explains facts and verification status; it does not judge humanity.

## Repository layout

```text
docs/
  sot.md
  architecture.md
  spec/canonicalization.md

packages/
  format/        # hard event-log/manifest contract and future format algorithms
  conformance/   # vector files and compatibility runner
  analyzers/     # analyzer interface, registry, and v0 analyzer homes
  storage/       # immutable record storage abstractions

apps/
  ingest-api/           # future Layer 2 HTTP service
  web/                  # future Vite React record page app
  site/                 # future Hugo landing/docs/blog site
  browser-extension/    # future capture-all browser producer

producers/
  emacs/         # future Emacs minor-mode producer
```

## Layer dependencies

The event-log/core format is the first hard dependency for every other layer.

1. `packages/format` defines the shared content-blind contract and canonicalize/hash-chain/verify APIs.
2. Producers depend on `packages/format` and the conformance vectors.
3. `apps/ingest-api` depends on `packages/format`, `packages/storage`, and later `packages/analyzers`.
4. `apps/web` depends on `packages/format` for browser-side verification and consumes backend record data.
5. `packages/analyzers` depends on `packages/format` types and must remain pure.
6. `packages/conformance` depends on the format contract and is the compatibility gate for all producers.

## Milestones

### M0 — architecture/scaffold

Current milestone. Create the monorepo skeleton, architecture docs, canonicalization spec home, package/app READMEs, and placeholder install/typecheck/test commands. Do not implement core algorithms.

### M1 — core format and conformance

Implement event/manifest types, canonical JSON serialization, BLAKE3 `b3:` hashing, event hash-chain verification, content-blind process-length math, and conformance vectors.

### M2 — backend persistence and stats

Add Postgres schema/migrations, immutable record storage, short-signature generation, record ingestion/fetch APIs, and record statistics.

### M3 — analyzers

Implement analyzer interface/registry plus `timing-distribution` and `edit-topology` analyzers. Outputs remain descriptive facts only.

### M4 — Vite React record app

Build the public record page, content-blind process timeline, quick stats, signal cards, and verification panel.

### M5 — Hugo site

Build landing/docs/blog pages that explain the product promise, privacy model, verification, and threat model without detector language.

### M6 — browser extension producer

Build local capture, sign/freeze/upload/copy-link flow, local TTL, capture-context review, and conformance pass.

### M7 — Emacs producer

Build the minor mode, buffer capture, signing/upload flow, capture-context review, and conformance pass.

## Out of scope for M0

- Canonicalization implementation.
- BLAKE3 hashing or event hash-chain implementation.
- Content-blind verification implementation.
- Event/manifest schema completion beyond scaffold placeholders.
- Conformance vectors beyond placeholder homes.
- HTTP APIs, database migrations, storage implementations, or analyzer execution.
- Vite/Hugo/browser-extension/Emacs runtime implementation.
- User management, public deletion API, or plaintext storage.
