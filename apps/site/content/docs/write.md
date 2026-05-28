---
title: "Write in the browser"
summary: "Use the first-party drafting page when you want a no-install PMBAH record for text written inside that page."
---

The `/write` page is the no-install producer. It gives you an empty drafting canvas, records content-opaque edit events from that canvas, and signs/uploads a PMBAH record when you choose **Sign and upload**.

What it captures:

- mutation timing and edit shape from the `/write` textarea;
- Unicode codepoint positions and lengths where the browser exposes enough input detail;
- server-observed process checkpoints for the same event hash chain.

What it does not capture:

- document text;
- text from other browser tabs or sites;
- text you wrote before opening the empty canvas.

For arbitrary websites, use the browser extension producer. The `/write` page is intentionally scoped to text written inside the first-party drafting page.
