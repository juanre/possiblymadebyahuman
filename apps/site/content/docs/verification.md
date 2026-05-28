---
title: "How to verify a record"
summary: "Recompute the BLAKE3 hash chain in your own browser and compare it to the full record hash."
---

Every public record page includes a **Verification** section. It runs in your browser, recomputes the hash chain from the stored events, and compares the result to the record's full hash.

## What clicking "Re-verify chain" does

1. Loads the manifest and event log from `/api/records/<short_signature_or_hash>`.
2. Canonicalises each event into deterministic JSON bytes.
3. Computes the hash chain:

```text
chain[0] = BLAKE3(format_version || session_id || canonical(event[0]))
chain[i] = BLAKE3(chain[i-1]      || canonical(event[i]))
```

4. Compares `chain[N-1]` to `manifest.record_hash`.
5. Renders either "Hash chain verified against the full record hash." or a list of validation errors.

The computed hash is displayed next to the manifest hash so you can compare them visually too.

## What verification does and does not mean

Verification confirms:

- The events were not altered after the signer uploaded them.
- The manifest is internally consistent (event count, declared duration vs. last event time, etc.).
- The `record_hash` in the manifest matches what the events actually produce when re-hashed in canonical form.

Verification does **not** confirm:

- That the signer authored the words. The system does not store, hash, or reconstruct the text; it has no way to check what was written.
- That a human typed the events instead of a script driving the producer.
- That the `capture_context` is true — that field is metadata the signer chose to include, not a sworn attribution.

## Hand-verifying without the record page

You can recompute the same hash chain yourself:

1. `GET /api/records/<short_signature>` to fetch the manifest and events.
2. Canonicalise each event with sorted keys and no whitespace (UTF-8 bytes).
3. Apply the chain definition above with BLAKE3.
4. Compare to `manifest.record_hash`.

The format package exports `canonicalizeEvent`, `computeEventHashChain`, `computeRecordHash`, and `verifyRecord` so you can do this from any TypeScript or JavaScript runtime. The Emacs and browser producers must produce records that satisfy the same checks; that is what makes the conformance suite worth running.
