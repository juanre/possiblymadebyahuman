---
title: "Producer conformance"
summary: "What it takes for a producer (browser extension, Emacs minor mode, or anything else) to be considered conformant."
---

`possiblymadebyahuman` is producer-agnostic. The browser extension and the Emacs minor mode are the first two implementations, and others can follow. Every producer must clear the same checks.

A producer is **conformant** if it passes:

1. **Canonicalization vectors** — given a public process event, the producer canonicalises it byte-identically to the format package (sorted keys, no whitespace, deterministic numeric formatting).
2. **Hash-chain vectors** — given a vector event log and session id, the producer computes the same BLAKE3 chain and final `record_hash` over the public process record.
3. **Process-length vectors** — given an event log, the producer's positions and lengths yield the same observed process length without document text.
4. **Capability accuracy** — the producer's declared capability set matches what it actually delivers. If `timing` is declared, every event has a real `t`. If `source_attribution` is declared, every event has a real `source`. If a capability is genuinely unavailable in a given runtime, the producer must omit it from `capabilities`; downstream analyzers then report "not applicable" rather than penalising the record.
5. **Content-opaque public uploads** — `POST /api/records` must not include plaintext, inserted text, final text, or text-derived hashes such as `ins_hash` or `final_text_hash`. The ingest API rejects unexpected manifest fields and content-bearing fields, and a conformant producer must not surface a "ship plaintext" path in its public flow.
6. **Capture-context preview** — the producer must show the signer the exact `capture_context` that will be uploaded, and let them edit or remove fields before submission.

## Source attribution accuracy

This is the rule producers are most likely to get wrong.

- `typing` means real key-level input was observed.
- `paste`, `cut`, `drop` mean the producer is *certain* about clipboard/drag-and-drop sourcing.
- `ime` means IME composition was the source.
- `autocomplete` means a suggestion-engine commit.
- `programmatic` means JS, AppleScript, or another script wrote the field.
- `unknown` is what you use when you cannot attribute the input. It is a first-class value, not a failure state, and it keeps the format explicit about known and unknown fields.

Dressing `unknown` up as `typing` because it produces a "more impressive" record is the single most product-corrupting mistake a producer can make.

## Transient inspection versus retention

A producer may transiently inspect editor text only when necessary to derive numeric process metadata such as position or length. It must discard the string immediately. It must not store, hash, log, upload, replay, or pass document text to helper processes.

## How to actually run the conformance suite

The conformance vectors live under `packages/conformance/vectors/` in this monorepo. The suite verifies them inside the project's own tests (`make check`). A third-party producer should run the same vectors through its own canonicaliser/hasher before publishing.

If you would like to publish a producer and discover the conformance harness disagrees with you, the conformance package is the ground truth — not the other way round.
