---
title: "possiblymadebyahuman"
---

<p class="eyebrow">possiblymadebyahuman</p>

# We cannot prove a human wrote it.

This is us caring enough to show you anyway.

`possiblymadebyahuman` is a **content-blind writing-record** service. When you sign a piece of writing, a producer captures the *shape* of how the text was edited — mutations, timing, sources — and uploads it as a hash-addressed record. The text itself stays with you.

<div class="standing-claim">

This record shows the shape of an editing process. It makes pasted and atomically inserted content visible. It does not prove that a human originated the ideas, and it cannot detect a human retyping an AI draft from another screen.

</div>

## What it does

- Records buffer mutations, not keystrokes: where text appeared, where it was deleted, when, and from what input source (typing, paste, drop, IME, autocomplete, programmatic).
- Stores a public, immutable record indexed by its BLAKE3 hash and a short signature.
- Renders the record as quick stats, a content-blind replay scrubber, analyzer signals, and a browser-side hash-chain verification.

## What it does not do

- It does not return a human/AI verdict, score, badge, or certificate of humanity.
- It does not store, transmit, or display the document's plaintext on public records.
- It does not detect a careful retype of an AI draft from another screen, or any other off-system origination.
- It does not track who wrote a record. There is no account system in v0.

## How to look around

- [Docs](/docs/) — the product promise, content-blind privacy model, how records work, how to verify one, threat model, and producer conformance.
- [Blog](/blog/) — short notes on the project's gesture and decisions.
- Public record URLs look like `/<short_signature>` and are rendered by the record app, not by this site.
