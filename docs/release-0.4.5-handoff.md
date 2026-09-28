# Release 0.4.5 handoff

Release tag `v0.4.5` ships the application image and Emacs producer 0.1.5. The
Chrome extension stays at 0.4.2.

Signing never waits for another edit because of a capture gap. When the text
changed without being recorded (a file edited outside Emacs, a paused
capture, a draft reopened with text that differs from its history, or another
extension changing the `/write` canvas), the producer records that change as
one edit of unknown position and size, then signs and includes the current
text in the text check. The record shows where the text changed unrecorded.

- **Emacs 0.1.5.** Signing and `M-x pmbah-copy-file` go through a pending gap.
  The copy command reports "nothing was published or copied" when publishing
  cannot start.
- **`/write`.** Signing goes through a gap the same way, through the shared
  `recordUnrecordedChange` in `packages/producer-core`.
- **Chrome extension.** Unchanged for now: a draft resumed and finished before
  any new edit can still publish only its earlier activity. It adopts the same
  behaviour in its next release.

## Publication and deployment

Deploy the service's `:latest` image on Render after the tag workflow
publishes it. No migration. Emacs users update their checkout and reload
`pmbah-mode.el`.

## Validation

Before tagging: type checking, 562 Node tests under managed PostgreSQL (one
intentional skip), including Emacs publishing a record with an unrecorded
change through the real ingest server with a text binding that matches the
current text, and the release gate with 184 browser tests.
