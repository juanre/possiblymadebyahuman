# Release 0.4.4 handoff

Release tag `v0.4.4` ships the application image and Emacs producer 0.1.4. The
Chrome extension stays at 0.4.2; nothing new goes to the Chrome Web Store.

This release includes:

- **Continuations that pick up exactly where their parent ended.** In a
  format 0.3 record with `parent_record`, a first edit with a known position
  claims the continuation starts from exactly the parent's final text. The
  service then starts its length and statistics from the parent's stored final
  length, keeps that as `record_stats.starting_length` (migration 010), and the
  record page and the paged viewer draw the length curve from there. A gap at
  the first edit, or an unknown parent length, still leaves the length unknown.
  No published record was a continuation, so no existing record is read
  differently.
- **Record page.** A continuation says in its header that it continues an
  earlier record, with a link. Earlier records do not link forward.
- **Emacs 0.1.4.** After publishing, Emacs continues the same buffer without a
  gap when it can prove the text is exactly the published text (the buffer was
  frozen by this Emacs and is unchanged). After a restart, or any change
  between freezing and continuing, it keeps the gap. New command
  `M-x pmbah-copy-file`: publishes unsigned history first (after asking), writes
  a copy, and records the original and the copy as separate continuations of
  the same record, each starting from the published length. Continuation start
  times now keep exact milliseconds.

## Publication and deployment

The tag workflow runs the reusable checks and publishes
`ghcr.io/juanre/possiblymadebyahuman:0.4.4` and `:latest`. Deploy the service's
`:latest` image on Render. Migration 010 adds a nullable column with a default
and runs before the service reports ready; the 0.4.3 instance serving during
the switch does not read it. Require `/health` to report the tagged commit and
`/ready` to succeed.

Emacs users update their checkout of the repository, including
`producers/emacs/scripts`, and reload `pmbah-mode.el` or restart Emacs.

## Validation

Before tagging, the branch passed type checking, 558 Node tests under managed
PostgreSQL (one intentional skip), including Emacs publishing a continuation
and a `pmbah-copy-file` copy to the real ingest server and the service starting
both from the parent's length, and the release gate with 184 browser tests.
