---
title: "Producer conformance"
summary: "What it takes for a producer (browser extension, Emacs minor mode, or anything else) to be considered conformant."
---

`possiblymadebyahuman` is producer-agnostic. The browser extension and the Emacs minor mode are the first two implementations, and others can follow. To stay consistent with the public format, every producer must clear the same checks.

A producer is **conformant** if it passes:

1. **Canonicalization vectors** — given a public process event, the producer canonicalises it byte-identically to the format package (sorted keys, no whitespace, fixed numeric formatting).
2. **Hash-chain vectors** — given a vector event log and session id, the producer computes the same BLAKE3 chain over the canonical public events and the same final `record_hash`. The chain hash is over process events only — never over text.
3. **Process-length vectors** — given a vector event log, the producer computes the same observed process length and follows the same rules for emitting explicit `null` in `pos`, `del_len`, or `ins_len` when a value cannot be derived content-blindly.
4. **Capability accuracy** — the producer's declared capability set matches what it actually delivers. If `timing` is declared, every event has a real `t`. If `source_attribution` is declared, every event has a real `source`. If a capability is genuinely unavailable in a given runtime, the producer must omit it from `capabilities`; downstream analyzers then report "not applicable" rather than penalising the record.
5. **Content-blindness on public uploads** — `POST /api/records` must not include text fields, inserted text, final text, or text-derived hashes. The ingest API rejects unexpected manifest fields and content-bearing fields, and a conformant producer must not surface a "ship text" path in its public flow. Producers may transiently inspect text in-memory to derive a numeric process field, but the string must be discarded in the same statement and never recorded, hashed, logged, persisted, or uploaded.
6. **Capture-context preview** — the producer must show the signer the exact `capture_context` that will be uploaded, and let them edit or remove fields before submission.

## Source attribution accuracy

This is the rule producers are most likely to get wrong.

- `typing` means real key-level input was observed.
- `paste`, `cut`, `drop` mean the producer is *certain* about clipboard/drag-and-drop sourcing.
- `ime` means IME composition was the source.
- `autocomplete` means a suggestion-engine commit.
- `programmatic` means JS, AppleScript, or another script wrote the field.
- `unknown` is what you use when you cannot reliably attribute the input. It is a first-class value, not a failure state, and it keeps the format precise about known and unknown fields.

Dressing `unknown` up as `typing` because it produces a "more impressive" record is the single most product-corrupting mistake a producer can make.

## Transient inspection versus retention

A producer may transiently inspect editor text only when necessary to derive numeric process metadata such as position or length. It must discard the string immediately. It must not store, hash, log, upload, reconstruct, or pass document text to helper processes.

## How to actually run the conformance suite

The conformance vectors live under `packages/conformance/vectors/` in this monorepo. The suite verifies them inside the project's own tests (`make check`). A third-party producer should run the same vectors through its own canonicaliser and chain hasher before publishing.

If you would like to publish a producer and discover the conformance harness disagrees with you, the conformance package is the ground truth — not the other way round.
