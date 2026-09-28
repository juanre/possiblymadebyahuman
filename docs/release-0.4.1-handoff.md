# Release 0.4.1 handoff

Release tag `v0.4.1` ships extension 0.4.1, Emacs producer 0.1.3 and the
application image. Records now describe only the writing process: nothing
about the page, site, file or tool context the text was written in is sent,
stored or shown.

This release includes:

- **Format.** `capture_context` is no longer part of the record format; a
  manifest containing it is rejected. It was never part of the record hash.
- **Producers.** The Chrome extension no longer reads the page title or sends
  the page address, site or field, and its finish review no longer offers
  public context choices. `/write` and Emacs send nothing about where they
  write; Emacs no longer asks about the buffer name or major mode. Private
  draft names stay in the writer's browser.
- **Service.** Uploads from earlier producers (extension up to 0.4.0, Emacs up
  to 0.1.2) are accepted and their `capture_context` is discarded on arrival.
  Migration 008 clears it from every stored record and staged upload. Records
  keep the producer name and version for issue tracking.
- **Record page.** The summary gives only the span and publication date, the
  capture context section is gone, and checkpoint and upload times are listed
  under Timing and counts.

## Publication and deployment

The tag workflow runs the reusable checks, publishes
`ghcr.io/juanre/possiblymadebyahuman:0.4.1` and `:latest`, and attaches
`possiblymadebyahuman-extension-0.4.1.zip` to the GitHub release. Deploy the
service's `:latest` image on Render. Migration 008 runs before the service
reports ready; require `/health` to report the tagged commit and `/ready` to
succeed. Records published before this release then no longer show where
they were written.

The `records.capture_context` column is kept, always empty, so an instance of
the previous release can keep inserting during the deploy switch. Drop it in a
later release.

Upload the 0.4.1 ZIP to the Chrome Web Store listing in place of 0.4.0, and
update the dashboard as described in
[`chrome-web-store-listing.md`](chrome-web-store-listing.md): untick Web
history, paste the updated description, reviewer instructions and `storage`
justification, and retake screenshots 3 and 4.

## Validation

Before tagging, the branch passed type checking, 542 Node tests under managed
PostgreSQL (one intentional skip), including the migration 008 test, and the
release gate: production container startup and migrations, HTTP smoke, and 182
browser tests including the extension end-to-end tests. The tag workflow
repeats the checks against the exact release commit.
