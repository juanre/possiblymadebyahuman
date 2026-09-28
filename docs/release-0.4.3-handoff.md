# Release 0.4.3 handoff

Release tag `v0.4.3` is a service release. The Chrome extension stays at
0.4.2 and the Emacs producer at 0.1.3; neither changed, so there is nothing new
to upload to the Chrome Web Store.

This release includes:

- **Busy-server answers keep the connection.** When the service is at its
  in-flight limit it answers `503 server_busy` with `Retry-After`. It used to
  close the connection as well, so a client still sending its body saw a reset
  instead of the answer. It now keeps the connection, as the rate-limited `429`
  already did.
- **The empty `capture_context` column is dropped.** Migration 008 emptied
  `records.capture_context` in 0.4.2, and no release since then reads or
  writes it. Migration 009 drops the column.

## Publication and deployment

The tag workflow runs the reusable checks and publishes
`ghcr.io/juanre/possiblymadebyahuman:0.4.3` and `:latest`. Deploy the service's
`:latest` image on Render. Migration 009 runs before the service reports
ready. The 0.4.2 instance still serving during the switch does not use the
column, so dropping it is safe while both run. Require `/health` to report the
tagged commit and `/ready` to succeed.

## Validation

Before tagging, the branch passed type checking, 543 Node tests under managed
PostgreSQL (one intentional skip), including an upgrade test that stores where
a record and a staged upload were written at the 007 schema and checks that
migrations 008 and 009 remove both and the column, and a test that a client
sending a 4 MB body to a busy server receives the 503. The release gate and the
tag workflow repeat the checks.
