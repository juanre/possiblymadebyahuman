---
title: "Bind and check a document"
summary: "Optionally bind the text you signed to a record, and let a reader check a document against it in their browser, comparing wording, not exact text."
---

A writing record shows the *shape* of an editing process. On its own it is not tied to any particular finished document; the URL could be pasted next to anything. **Binding** closes that gap: when you sign, you can commit the record to the specific text you wrote, so a reader can later check whether a document they were given is that text.

This is provenance, not a verdict. A match says the words line up; it never claims a human wrote them.

## Binding when you sign

In `/write`, the browser extension, and Emacs, signing offers to **bind the document**:

- Binding is on by default; you can opt out and sign the **process only** (no document bound), for example while you are still editing.
- The text being bound is producer-specific:
  - `/write`: selected text in the writing canvas if there is a selection; otherwise all current canvas content.
  - Browser extension: selected text in the active field/editor if there is a selection; otherwise all current content of that field/editor. This is the path to sign only the body of an email or reply in a larger page such as Gmail.
  - Emacs: active region when `use-region-p` is true; otherwise the whole buffer.
The producer computes the binding **locally** from that selected-or-fallback text and **discards the text**. Only a content-blind commitment is uploaded: a salted hash of the text's canonical letters and digits, plus its length. The text itself never leaves your machine, and the commitment cannot be turned back into the text.

A selection with no letters or digits (for example emoji or punctuation only) cannot be bound; signing falls back to process-only.

## Checking a document

A record that has a binding shows a **Check a document** box. Paste the document you want to check; the comparison runs **in your browser** and the pasted text is never uploaded. You get one of:

- **Same wording as the signed text.**
- **Same wording, plus N more characters after it**, **with N more before it**, or with a small amount of surrounding material near the beginning/end of the pasted document.
- **These letters don't match what the author signed.**

## What a match means, and does not

A match compares **letters and digits in order**. It **ignores spacing, punctuation, case, and number formatting**. It is **not** a check of exact text.

That looseness is deliberate; it survives the mangling real documents pick up in transit (rewrapped lines, smart quotes, changed spacing). The cost is that texts which share the same ordered letters and digits read as a match even when they differ in punctuation or number formatting. For example, `$1,000.00` and `$100,000` both reduce to `100000`, so they would verify as the same wording. When a binding covers only a short run of text, the checker says so, because a short run is weak evidence on its own.

The check is **bounded near the edges**: it matches the whole pasted document, or a window starting within 160 canonical letters/digits of the beginning or ending within 160 canonical letters/digits of the end. It does **not** do an unbounded interior search. If your signed text sits deep in the middle of a larger paste, paste just the signed portion to check it.

## The other half is yours to judge

Binding answers "is this the text that was signed?" It does not answer "was this much writing actually done here?" That second question is contextual, so the record shows it as facts under **How this was written**, the signed text's size next to the recorded process (duration, edit count, pastes), and leaves the judgment to you. An automated wording match is never combined with that human judgment into a single "verified" verdict.

## Records with no binding

A record may carry no binding: the signer bound the process only, or it predates the feature. Those records show **"No document was bound to this record."** That is a plain statement of fact, not a failure: the writing-record and its hash chain are exactly as valid; there is simply no document to check against.
