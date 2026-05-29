---
title: "Write in the browser"
summary: "Use the first-party drafting page when you want a no-install PMBAH record for text written inside that page."
---

The `/write` page is the no-install producer. It gives you an empty drafting canvas, records content-blind edit events from that canvas, and signs/uploads a PMBAH record when you choose **Sign and upload**.

What it captures:

- mutation timing and edit shape from the `/write` textarea;
- Unicode codepoint positions and lengths where the browser exposes enough input detail;
- server-observed process checkpoints for the same event hash chain.

What it does not capture:

- document text;
- text from other browser tabs or sites;
- text you wrote before opening the empty canvas.

For arbitrary websites, use the browser extension producer. The `/write` page is intentionally scoped to text written inside the first-party drafting page.

## Binding the document when you sign

When you choose **Sign and upload**, you can also **bind** the document: commit the record to the specific text you wrote, so a reader can later check that a document is the one signed. You affirm "this is the text this record is meant to cover," and binding is on by default; you can opt out and sign the process only. The binding is computed in your browser and only a content-blind commitment is uploaded; the text never leaves the page. See [Bind and check a document](/docs/checking-a-document/) for what a later match does and does not mean.
