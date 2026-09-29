# Release 0.4.6 handoff

Release tag `v0.4.6` ships the application image and Chrome extension 0.4.3.

- **Sizes over the measured edits.** One edit recorded without its size (for
  example the unrecorded change a producer records when it signs through a
  gap) used to make Deleted and Largest insertion "not measured" for the whole
  record. Stats now also keep the totals over the edits whose sizes are known
  and the number of edits without a size (`measured_inserted_codepoints`,
  `measured_deleted_codepoints`, `measured_largest_insert_codepoints`,
  `unknown_size_edit_count`). The record header shows Deleted and Largest
  insertion over the measured edits, with a note saying how many edits they do
  not cover. Length stays "not measured" when it cannot be known.
- **Paged records read like short records.** A record uploaded in pages with
  at most 250,000 events is verified as soon as its page opens and then shows
  the same edit timeline, writing rhythm and technical details as a short
  record. Larger records keep the "Verify full record" button and the
  fixed-size overview. The extension and Emacs always upload in pages, so this
  covers most real records.
- **Chrome extension 0.4.3.** Signing goes through a capture gap the way
  `/write` and Emacs 0.1.5 do: the change made while capture was not
  recording is recorded as one edit of unknown position and size, and the
  record includes the current text.

## Publication and deployment

The tag workflow publishes `ghcr.io/juanre/possiblymadebyahuman:0.4.6` and
`:latest`, and the release carries the extension package. Deploy the service's
`:latest` image on Render. Migration 011 adds four columns to `record_stats`
and fills them for stored records from their inline or paged events; it runs
before the service reports ready, and the 0.4.5 instance serving during the
switch does not read the new columns. Require `/health` to report the tagged
commit and `/ready` to succeed.

Upload the 0.4.3 extension package to the Chrome Web Store
(`docs/chrome-web-store-prep.md`).

## Validation

Before tagging: type checking, 566 Node tests under managed PostgreSQL (one
intentional skip), including migration 011 filling the measured totals of a
stored inline record and a stored paged record with an unknown-size edit, and
the release gate with 189 browser tests. The extension end-to-end spec that
resumes a draft and finishes it at once, publishing one unknown change and a
text check over the current text, passed against the local container.
