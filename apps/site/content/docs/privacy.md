---
title: "Content-blind privacy model"
summary: "What public records store, what stays on your machine, and what the signer controls before publishing."
group: "How it holds up"
weight: 2
---

`possiblymadebyahuman` is **content-blind**. Public records describe the shape of an editing process; they never contain the document's text. If the signer chooses to let readers check a copy of the text, the producer computes a salted fingerprint of it on the signer's machine and publishes only that fingerprint. See [Bind and check a document](/docs/checking-a-document/).

## What public records contain

- An event log of edits: `seq`, `t`, `op`, `pos`, `del_len`, `ins_len` and `source`. Each numeric field is a measured position, length or time. When a producer cannot measure a value without keeping text, the field is an explicit `null`.
- A manifest with the BLAKE3 record hash, producer name and version, declared capabilities, event count and duration. Newer records also seal the finish time and an optional link to an earlier record they continue.
- Precomputed statistics: counts of typed, pasted, cut, dropped, composed, autocompleted, programmatic and unknown edits; characters inserted and deleted when known; the largest single insertion; document length when known; delays between edits; and a delay histogram.
- Analyzer signals, each with its measurements and an explanation.
- An optional `text_binding`, only when the signer chose it: a `scheme`, a `canonical_length` and a salted `commitment` over the signed text's letters and digits. Anyone can test candidate wording against it.

## What public records never contain

- The text of the document, or any fingerprint of it other than the optional `text_binding`.
- Fingerprints of individual insertions or of the raw document. The event hash chain covers the edit events, never the words.
- Account or identity fields. There is no user system.
- Anything about where the text was written: no page address or title, site, field, label, file name, buffer name or editor mode.

## What stays on your machine

Producers may read the editor's text for an instant to measure an edit (for example, how long a paste was) and then discard it. That text is never stored with the writing history, sent in checkpoints, logged, or uploaded. The one text-derived value that can leave your machine is the optional `text_binding` computed when you sign.

Each producer also keeps local state on your machine:

- **Chrome extension.** Unfinished drafts and saved links live in `chrome.storage.local`. A draft holds numeric edit events, session details, the hash-chain tip and a **bearer** token that authenticates the draft's server-observed checkpoints. The token is sent only to the service; it is never shown to web pages, logged, or published. Saved links and drafts stay until you remove them. **Export all links** downloads your saved-link list, including private draft names and site information; it contains no document text and no tokens. Removing browser data or uninstalling the extension removes this history.
- **The `/write` drafting page.** Your drafts' text is saved in this browser so you can come back to it, and it is never sent to the service. It is kept apart from the drafts' writing history, which holds the same numeric edit events and bearer token as the extension. Deleting a draft removes both from this browser. Clearing the site's data removes all of them.
- **Emacs `pmbah-mode`.** Writing history for opted-in files lives in owner-only files under `pmbah-state-directory` (by default `~/.emacs.d/pmbah/`): numeric events, session details and the checkpoint token, never document text. Signing and uploading, or discarding, clears a file's current history. Unreadable history is kept aside with a `.stale` suffix until you remove it.

## What the signer controls

The Chrome extension records only the editor you explicitly choose, through its context menu, keyboard shortcut or side panel. Its controls live in the browser's side panel, never over the web page. Reloading, navigating away, stopping or finishing ends recording in that editor.

Before publishing, you can:

- choose whether readers can check a copy of the text against the record;
- decide not to publish at all.

## Nothing about where you wrote

A record describes the writing process and nothing else. It carries no capture context: nothing about the page, site, field or file you wrote in. It names the producer that made it, such as the Chrome extension or Emacs, with its version and declared capabilities. Draft names in the extension and on `/write` stay in your browser.

Earlier versions of the Chrome extension, Emacs `pmbah-mode` and the `/write` page sent some of these details with a record, such as a page address and title, a label, or an Emacs buffer name and mode. The service discards them when they arrive, and they have been removed from every record already stored. They were never part of the record hash, so those records still verify.

## Signed finish time

A newer record seals the time from the start of the writing session to the moment of publishing, including pauses. This is the producer's claim about elapsed time; it does not mean the service watched the whole interval. A record that continues an earlier one names it by hash, so the two records are publicly linkable.

## Server-observed checkpoints

While you write, the producer periodically sends the service a checkpoint: the session's observation id, the number of recorded edits, the hash-chain tip at that point, and after the first checkpoint the session's bearer token. The first edit is sent at once; after that, checkpoints go out every 50 edits or every minute of active writing, never while you are idle. The service stores a hash of the token, never the token itself. See [Server-observed commitments](/docs/server-observed-commitments/) for how records show this.

Checkpoint data for unpublished sessions does not expire, so a draft you return to months later keeps its earlier checkpoints. Deleting a local draft does not delete the service's checkpoint data, which contains no text.

If the service cannot be reached, checkpoints fail and recording continues locally.

## What we cannot offer

- Deletion of published records on request. There is no public deletion API, and no accounts that would let the service know who published a record. The operator may remove a record that is clearly abusive or unlawful when it is reported; see [Terms / Service Notes](/docs/terms/).
- Secrecy for predictable text you chose to make checkable. The fingerprint's salt is public, so short or predictable wording can be guessed. Leave the text check off if that matters.
- Knowledge of copies kept elsewhere. This page describes what this service and its producers store.

## Contact

Ask privacy questions, or point out anything unclear here, in the project's [GitHub issues](https://github.com/juanre/possiblymadebyahuman/issues). To report a record that contains abusive or unlawful material, or for any legal request, write to [pmbah@aweb.ai](mailto:pmbah@aweb.ai) rather than opening a public issue.
