---
title: "Write in the browser"
summary: "Use the drafting page to write, keep several drafts in your browser, and publish a writing record when a piece is ready."
group: "Write a record"
weight: 2
---

The [drafting page](/write) needs no installation. Write there, and it records how the text was edited: when each edit happened, where it landed and how large it was. When a piece is ready, sign it to publish that record at a short link you can share.

To record writing in the text boxes of other websites, such as comments, forum replies or email, use the [Chrome extension](/docs/chrome-extension/).

## Drafts

`/write` keeps a list of your drafts. Each draft is saved in this browser as you type, so you can close the tab, reload, or come back months later and carry on. Drafts have no automatic expiry; they stay until you delete them.

The draft's words are saved only in this browser. They are never sent to the service. Clearing your browser's site data, using a private window, or switching to another browser or device means those drafts are not there. If the browser warns that it may clear saved data when it runs short of space, keep a copy of anything important.

A draft is named after its first line until you rename it. Names are private to this browser and are not part of any published record.

One tab at a time works with your drafts. If they are open in another tab, close that tab and try again.

## What is recorded

- when each edit happened, and how long you paused between edits;
- where each edit landed and how many characters it inserted or deleted, where the browser reports enough detail to measure it;
- whether an edit was typed, pasted, cut, dropped, or came from composition input, autocomplete or an unknown source;
- server-observed checkpoints: while you write, the page sends the service the number of recorded edits and a hash of them, so the service can confirm when it saw the writing unfold.

The record never contains the text. It does not capture other tabs or websites; for those, use the [Chrome extension](/docs/chrome-extension/) or [Emacs](/docs/emacs/).

When you return to a draft, the page checks that the saved text is exactly what the recorded edits produced. If it is, the record continues seamlessly. If it is not (for example, the browser closed before the last edit was saved), the record marks a gap at your next edit, or when you sign if that comes first, instead of pretending the writing was continuous.

The same applies if something else changes the text on the canvas, such as a grammar-checking extension. If you sign before typing again, the record includes that change as one edit of unknown position and size, and the text check covers the text as it is when you sign.

## Signing and publishing

Choose **Sign** and confirm with **Sign & publish**. The signed record includes the time from the start of the draft to the moment you publish, including pauses.

Publishing can also let readers check a copy of the text against the record. This is on by default. The page computes a salted fingerprint of the selected text, or of the whole draft if nothing is selected, and publishes only that fingerprint. Anyone can test guesses of the wording against it, so short or predictable text can be guessed. See [Bind and check a document](/docs/checking-a-document/) for what a match means.

If publishing fails, the signed record stays saved in this browser, and **Retry publishing** sends exactly the same record.

After publishing, the draft keeps its link. Choose **Keep writing** to add to it: your next edits become a new record that names the earlier one, and the earlier link never changes.

The published record carries no draft names, no text and nothing about where it was written.

## Deleting a draft

**Delete draft** removes the draft's text and editing history from this browser. Records you already published stay online; their links are no longer listed in the draft list, so copy any link you want to keep first.
