---
title: "Threat model"
summary: "Who and what this product can and cannot defend against."
---

A threat model is what keeps a system disciplined. This is ours, deliberately short.

## Who we are trying to be useful to

- An author who wants to show *some* of the work behind a piece of writing, without handing over the writing itself.
- A reader who wants to look at the editing process behind something they were given.
- A small audience of curious technical readers who will check the hash chain.

## What an adversary can trivially do

- **Retype an AI draft from another screen.** A producer will record clean typing and short pauses. The record will look unremarkable. There is no defence against this and we do not claim one.
- **Run a script that issues `insert` mutations slowly with realistic delays.** A keyboard-level producer can detect that no real key events fired, but only on producers that declare `keystroke_level` — most do not. A reader should not over-read the absence of pastes.
- **Re-use a record's URL next to different writing.** For a record with no document binding, nothing ties the URL to any particular text except the signer's claim. A *bound* record is different: a reader can check a document against the binding, and entirely different text fails that check (see [Bind and check a document](/docs/checking-a-document/)). Binding is opt-in and proves *wording*, not authorship — an author can still bind a document they did not originate.
- **Decline to sign at all.** The product is opt-in. Absence of a record means nothing about authorship.

## What the system does defend against

- **Silent tampering with stored events.** The hash chain detects any change. A reader can recompute it locally.
- **Backend silently editing a record.** Same defence: anyone with the URL can verify the chain.
- **A producer claiming a capability it does not have.** Conformance vectors and capability-accuracy checks fail closed if a producer advertises `timing` or `source_attribution` without actually supplying them.
- **A single human/AI score creeping into the UI.** It is a product-level invariant that no aggregate verdict is rendered. Analyzer signals are facts with explanations, never combined into a single number.
- **Text leaking into public storage.** Producers do not upload text; the ingest API rejects content-bearing fields on public submissions; the record app renders structure only. A document binding, when present, uploads only a content-blind commitment computed locally — the text itself never leaves the producer.
- **Swapping the published text on a bound record.** When the signer bound a document, a reader can confirm in their own browser that a given document is the one signed — at the level of *wording* (letters and digits in order), not exact bytes. Publishing wholly different text under that record fails the check.

## What we explicitly do not do

- We do not authenticate users. There are no accounts in v0.
- We do not offer public deletion. Records are permanent by default; this is acceptable only because they do not contain text or identifying user fields.
- We do not vouch for `capture_context`. The signer chose what to include. Treat URL and title as provenance hints, not as facts.
- We do not promise anonymity. The signer's network and producer environment may leak identity in ways outside this service's control.

## In one sentence

The system protects the *integrity* of a writing record once it has been signed, and — when the signer binds a document — lets a reader check that a given text is the one signed, at the level of wording. It still cannot prove a human wrote it, and it cannot stop an author who never binds, or who binds a document they did not originate.
