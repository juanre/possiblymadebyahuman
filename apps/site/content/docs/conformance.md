---
title: "Producer conformance"
summary: "What it takes for a producer (browser extension, Emacs minor mode, or anything else) to be considered conformant."
---

`possiblymadebyahuman` is producer-agnostic. The browser extension and the Emacs minor mode are the first two implementations, and others can follow. To stay honest, every producer must clear the same checks.

A producer is **conformant** if it passes:

1. **Canonicalization vectors** — given an event, the producer canonicalises it byte-identically to the format package (sorted keys, no whitespace, deterministic numeric formatting).
2. **Hash-chain vectors** — given a vector event log and session id, the producer computes the same BLAKE3 chain and final `record_hash`.
3. **Replay/codepoint vectors** — given an event log and the original inserted text (for local replay), the producer reconstructs the same final text and the same `final_text_length` / `final_text_hash`. All position and length math uses Unicode codepoints, not UTF-16 units, not bytes.
4. **Capability honesty** — the producer's declared capability set matches what it actually delivers. If `timing` is declared, every event has a real `t`. If `source_attribution` is declared, every event has a real `source`. If a capability is genuinely unavailable in a given runtime, the producer must omit it from `capabilities`; downstream analyzers then report "not applicable" rather than penalising the record.
5. **Content-blindness on public uploads** — `POST /api/records` must not include plaintext fields. The ingest API rejects unexpected manifest fields and content-bearing fields, and a conformant producer must not surface a "ship plaintext" path in its public flow.
6. **Capture-context preview** — the producer must show the signer the exact `capture_context` that will be uploaded, and let them edit or remove fields before submission.

## Source attribution honesty

This is the rule producers are most likely to get wrong.

- `typing` means real key-level input was observed.
- `paste`, `cut`, `drop` mean the producer is *certain* about clipboard/drag-and-drop sourcing.
- `ime` means IME composition was the source.
- `autocomplete` means a suggestion-engine commit.
- `programmatic` means JS, AppleScript, or another script wrote the text.
- `unknown` is what you use when you genuinely cannot attribute the input. It is a first-class value, not a failure state, and it is what keeps the format honest.

Dressing `unknown` up as `typing` because it produces a "more impressive" record is the single most product-corrupting mistake a producer can make.

## How to actually run the conformance suite

The conformance vectors live under `packages/conformance/vectors/` in this monorepo. The suite verifies them inside the project's own tests (`make check`). A third-party producer should run the same vectors through its own canonicaliser/hasher/replayer before publishing.

If you would like to publish a producer and discover the conformance harness disagrees with you, the conformance package is the ground truth — not the other way round.
