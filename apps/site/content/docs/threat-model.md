---
title: "Threat model"
summary: "Who and what this product can and cannot defend against."
---

A threat model is what keeps a system honest. This is ours, deliberately short.

## Who we are trying to be useful to

- An author who wants to show *some* of the work behind a piece of writing, without handing over the writing itself.
- A reader who wants to look at the editing process behind something they were given.
- A small audience of curious technical readers who will check the hash chain.

## What an adversary can trivially do

- **Retype an AI draft from another screen.** A producer will record clean typing and short pauses. The record will look unremarkable. There is no defence against this and we do not claim one.
- **Run a script that issues `insert` mutations slowly with realistic delays.** A keyboard-level producer can detect that no real key events fired, but only on producers that declare `keystroke_level` — most do not. A reader should not over-read the absence of pastes.
- **Sign a record on a real document and re-use it elsewhere.** A record's URL travels with the record. Nothing binds the record to a piece of distributed writing except the signer's own claim.
- **Decline to sign at all.** The product is opt-in. Absence of a record means nothing about authorship.

## What the system does defend against

- **Silent tampering with stored events.** The hash chain detects any change. A reader can recompute it locally.
- **Backend silently editing a record.** Same defence: anyone with the URL can verify the chain.
- **A producer claiming a capability it does not have.** Conformance vectors and capability-honesty checks fail closed if a producer advertises `timing` or `source_attribution` without actually supplying them.
- **A "humanness score" creeping into the UI.** It is a product-level invariant that no aggregate verdict is rendered. Analyzer signals are facts with explanations, never combined into a single score.
- **Plaintext leaking into public storage.** Producers strip plaintext before upload; the ingest API rejects content-bearing fields on public submissions; the record app renders structure only.

## What we explicitly do not do

- We do not authenticate users. There are no accounts in v0.
- We do not offer public deletion. Records are permanent by default; this is acceptable only because they do not contain plaintext or identifying user fields.
- We do not vouch for `capture_context`. The signer chose what to include. Treat URL and title as provenance hints, not as facts.
- We do not promise anonymity. The signer's network and producer environment may leak identity in ways outside this service's control.

## In one sentence

The system protects the *integrity* of a writing record once it has been signed. It does not, and cannot, protect against an author who decides to mislead a reader about *what* was signed.
