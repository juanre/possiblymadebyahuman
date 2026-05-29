---
title: "How to verify a record"
summary: "Recompute the record's BLAKE3 hash in your own browser and compare it to the stored hash."
---

Every public record page includes a **Signature & details** section. A record's signature is its BLAKE3 hash, and the short record URL is derived from that hash. When the page loads, it recomputes the hash from the stored events in your own browser and shows the result next to the stored hash, so the "Computed hash" row is your own re-derivation rather than something the server asserts. Nothing you do here is uploaded.

## What the section shows

- **Full record hash** — the record's signature, as stored in the manifest. The short URL is a prefix of this hash.
- **Computed hash** — the same hash, recomputed in your browser from the event log (and, for a bound record, the content-blind document commitment). If it equals the stored hash, the events reproduce the signature.
- **Server metadata** — whether the server recorded an ingestion time, or only a client-claimed time.

When the record was server-observed, this section also carries the one-line observation status and the collapsible list of server-observed commitments.

The recomputation runs automatically when the page loads — there is no button to press. Checking whether a particular text is the one that was signed is a separate tool, the [document checker](/docs/checking-a-document/).

## How the hash is computed

The events are hashed into a chain, seeded with the format version and session id:

```text
chain[0] = BLAKE3(format_version || session_id || canonical(event[0]))
chain[i] = BLAKE3(chain[i-1]      || canonical(event[i]))
```

For a record with no bound document, the final chain value **is** the record hash. For a record that binds a document, the record hash folds the event-chain tip together with the document's content-blind commitment, so the signed text is committed without ever appearing in the record. The browser picks the right derivation from the manifest's `format_version`.

## What this does and does not mean

Recomputing the hash confirms:

- The events were not altered after the signer uploaded them.
- The manifest is internally consistent (event count, declared duration vs. last event time, etc.).
- The stored `record_hash` matches what the events — and any document binding — actually produce when re-hashed in canonical form.

It does **not** confirm:

- That the signer authored the words. The hash chain never inspects the text. A signer may separately **bind** a document so a reader can check that a given text is the one signed (see [Bind and check a document](/docs/checking-a-document/)) — but even a match confirms *wording*, not authorship.
- That a human typed the events instead of a script driving the producer.
- That the `capture_context` is true — that field is metadata the signer chose to include, not a sworn attribution.

A matching hash is a consistency check, not a verdict. Comparing the recomputed hash to the manifest's own hash field tells you the record is internally consistent and unaltered; it says nothing about who wrote the text.

## Hand-verifying without the record page

You can recompute the same hash yourself:

1. `GET /api/records/<short_signature>` to fetch the manifest and events.
2. Canonicalise each event with sorted keys and no whitespace (UTF-8 bytes).
3. Apply the chain definition above with BLAKE3, then fold in the document commitment if the record is bound.
4. Compare to `manifest.record_hash`.

The format package exports `canonicalizeEvent`, `computeEventHashChain`, `computeRecordHash`, and `verifyRecord` so you can do this from any TypeScript or JavaScript runtime; `verifyRecord` selects the bound or unbound derivation from `format_version`. The Emacs and browser producers must produce records that satisfy the same checks; that is what makes the conformance suite worth running.
