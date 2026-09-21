---
title: "Write in the browser"
summary: "Use the first-party drafting page when you want a no-install PMBAH record for text written inside that page."
group: "Write a record"
weight: 1
---

The `/write` page is the no-install producer. It gives you an empty drafting canvas, records content-blind edit events from that canvas, and signs/uploads a PMBAH record when you choose **sign** and confirm with **sign & upload**. You can keep editing after signing; signing again produces a new record covering the whole writing process so far.

Your writing is not saved. Copy it before closing or refreshing the page. Uploading saves the process record, not the canvas text. A failed upload keeps the canvas frozen so retry sends the same signed record.

What it captures:

- mutation timing and edit shape from the `/write` textarea;
- Unicode codepoint positions and lengths where the browser exposes enough input detail;
- server-observed process checkpoints for the same event hash chain.

What it does not capture:

- document text;
- text from other browser tabs or sites;
- text you wrote before opening the empty canvas.

For arbitrary websites, use the browser extension producer. The `/write` page is intentionally scoped to text written inside the first-party drafting page.

The capture context `/write` uploads is fixed and non-identifying: the surface `web-draft`, the label "First-party drafting page", and the page's own URL with no query string. There is nothing to review or redact, which is why the sign sheet does not show one.

## Binding the document when you sign

When you choose **sign**, you can also **bind** the document: commit the record to the specific text you wrote, so a reader can later check that a document is the one signed. Binding is on by default; you can opt out and sign the process only. If text is selected in the writing canvas, `/write` binds that selection; otherwise it binds all current canvas content. The binding is computed in your browser and only a content-blind commitment is uploaded; the text never leaves the page. See [Bind and check a document](/docs/checking-a-document/) for what a later match does and does not mean.
