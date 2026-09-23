---
title: "How to verify a record"
summary: "Recompute the record's BLAKE3 hash in your own browser and compare it to the stored hash."
group: "Read and verify a record"
weight: 2
---

Every public record page includes a **Signature & details** section. A record's signature is its BLAKE3 hash, and the short record URL is derived from that hash. When the page loads, it recomputes the hash from the stored events and the fields sealed by that format in your own browser, states plainly whether the result matches the stored hash, and shows the recomputed value next to the stored one, so the "Computed hash" row is your own re-derivation rather than something the server asserts. If the events shown do not reproduce the record hash, the section says so and lists why. Nothing you do here is uploaded.

## What the section shows

- **Full record hash**: the record's signature, as stored in the manifest. The short URL is derived from it: the leading characters of the hash bytes in base58, lengthened on collision, and occasionally prefixed with `X` when the natural prefix would shadow a reserved route such as `/docs`.
- **Computed hash**: the same hash, recomputed in your browser from the event log and the format’s sealed fields. Format 0.3 seals duration, the prior-record link and the optional text commitment. Earlier formats retain their original rules. A match means those inputs reproduce the signature.
- **Server metadata**: whether the server recorded an ingestion time, or only a client-claimed time.

The section also carries the one-line observation status for every record (observed, partially observed, not observed, or no observation requested) and, when there are any, the collapsible list of server-observed commitments.

The recomputation runs automatically when the page loads; there is no button to press. Checking whether a particular text is the one that was signed is a separate tool, the [document checker](/docs/checking-a-document/).

## How the hash is computed

The browser selects the hash rules using `manifest.format_version`. Events form a BLAKE3 chain. Format 0.3 intentionally shares the 0.2 event-chain domain so an unfinished draft can preserve existing checkpoints when it upgrades at finish.

For format 0.1, the event tip is the record hash. Format 0.2 uses that tip directly when unbound, or seals it with the optional text binding. Format 0.3 always seals the event tip with canonical JSON containing exactly `format_version`, `duration_ms`, `parent_record` and `text_binding`; absent parent and binding values are explicit `null` in that seal. See [Records and short signatures](/docs/records/) for the formulas.

The extension 0.3.0 candidate uses the new seal; older records still verify without changing their hashes. The API and viewer must support 0.3 before that extension is distributed. `/write` and Emacs have not opted into the new finish behavior.

## What this does and does not mean

Recomputing the hash confirms:

- The events and the fields sealed by their format reproduce the displayed hash.
- The manifest is internally consistent (event count, declared duration vs. last event time, etc.).
- For format 0.3, the elapsed finish time and prior-record link are included in that consistency check. Earlier formats do not seal those fields.

It does **not** confirm:

- That the signer authored the words. The hash chain never inspects the text. A signer may separately **bind** a document so a reader can check that a given text is the one signed (see [Bind and check a document](/docs/checking-a-document/)), but even a match confirms *wording*, not authorship.
- That a human typed the events instead of a script driving the producer.
- That signed duration is independently observed time. It is a client claim; server-observed span measures time between received checkpoints. A long pause may contain no captured edits.
- That the `capture_context` is true; that field is metadata the signer chose to include, not a sworn attribution.

A matching hash is a consistency check, not a verdict. Comparing the recomputed hash to the manifest's own hash field tells you the record is internally consistent; it says nothing about who wrote the text or whether the server replaced both the events and the displayed hash. To check against an earlier record, retain its full hash independently and compare it using a verifier you trust. Other metadata, such as capture context, is not committed by the record hash.

## Hand-verifying without the record page

You can recompute the same hash yourself:

1. `GET /api/records/<short_signature>` to fetch the manifest and events.
2. Canonicalise each event with sorted keys and no whitespace (UTF-8 bytes).
3. Apply the event-chain domain and final-seal rules for `manifest.format_version`. For 0.3, use the 0.2 event domain and seal duration, parent and binding together.
4. Compare to `manifest.record_hash` for internal consistency, or to an independently retained full hash to check against an earlier record.

The format package exports `canonicalizeEvent`, `computeEventHashChain`, `computeRecordHash`, and `verifyRecord` so you can do this from any TypeScript or JavaScript runtime; `verifyRecord` selects the appropriate derivation from `format_version`. The Emacs and browser producers must produce records that satisfy the same checks; that is what makes the conformance suite worth running.
