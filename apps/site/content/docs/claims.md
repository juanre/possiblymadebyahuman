---
title: "What we claim — and do not claim"
summary: "A short, candid list of what the record means and what it deliberately does not mean."
---

## We claim

- The record describes a sequence of buffer mutations: where text was inserted, where it was deleted, when, and from what input source (typing, paste, drop, IME, autocomplete, programmatic, or unknown).
- The record is hash-addressed. Anyone with the URL can recompute the BLAKE3 hash chain from the stored events and confirm that the events have not been altered since the signer uploaded them.
- The record was uploaded at a specific server-stamped time (`ingested_server_t`).
- The producer that created the record declared a specific set of capabilities (e.g. timing, source attribution). Analyzers report when a capability is missing instead of penalising the record for it.

## We do not claim

- That a human originated the ideas in the writing.
- That the person who signed the record wrote the words themselves.
- That the writer did or did not consult an external AI, source, or notebook.
- That a careful retype of an AI draft from another screen can be detected. It cannot, and any system claiming otherwise is overselling itself.
- That the absence of pastes, long pauses, or revisions means "this was a human." It does not.

## Why this matters

The temptation with a system like this is to ship a single number — a score, a percentage, a colour bar — and let readers infer "this was human." We do not.

Aggregate humanness scores are exactly the failure mode this product exists to avoid. Analyzer signals are presented as factual descriptors (counts, distributions, deltas), each with its own explanation, and never combined into a single verdict.
