---
title: "What we claim, and do not claim"
summary: "A short, candid list of what the record means and what it deliberately does not mean."
---

## We claim

- The record describes a sequence of buffer mutations: where text was inserted, where it was deleted, when, and from what input source (typing, paste, drop, IME, autocomplete, programmatic, or unknown).
- The record is hash-addressed. Anyone with the URL can recompute the BLAKE3 hash chain from the stored events and confirm that the events have not been altered since the signer uploaded them.
- The record was uploaded at a specific server-stamped time (`ingested_server_t`).
- The producer that created the record declared a specific set of capabilities (e.g. timing, source attribution). Analyzers explicitly report when a capability is missing instead of penalising the record for it.
- When the signer bound a document, a reader can check (in their own browser, with nothing uploaded) that a given text matches the signed one at the level of *wording*: letters and digits in order, ignoring spacing, punctuation, case, and number formatting. See [Bind and check a document](/docs/checking-a-document/).

## We do not claim

- That a human originated the ideas in the writing.
- That the person who signed the record wrote the words themselves.
- That the writer did or did not consult an external AI, source, or notebook.
- That a careful retype of an AI draft from another screen can be detected. It cannot, and any system claiming otherwise is overselling itself.
- That the absence of pastes, long pauses, or revisions means "this was a human." It does not.
- That a document-binding match proves authorship, or even exact text. A match confirms a document is the wording the signer committed to; it says nothing about who wrote it, an author can bind a document they did not originate, and it ignores punctuation, case, and number formatting (so e.g. `$1,000.00` and `$100,000` would match).

## Why this matters

The temptation with a system like this is to ship a single number (a score, a percentage, a colour bar) and let readers infer "this was human." We do not.

This service never rolls its signals up into a single human/AI score. Analyzer signals are presented as factual descriptors (counts, distributions, deltas), each with its own explanation, and never combined into a verdict.
