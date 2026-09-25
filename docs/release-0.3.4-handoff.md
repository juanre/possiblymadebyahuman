# Release 0.3.4 handoff

Release tag `v0.3.4` ships extension 0.3.4 and Emacs producer 0.1.1. The
application image includes the API and `/write` fixes. The Emacs source and
its Node helpers are distributed in the repository release archive.

This release includes:

- Bounded API validation work and diagnostics for malformed requests below the
  HTTP byte limit.
- Browser checkpoint recovery after a journal save fails between coalesced
  requests, including recovery on the next edit and during finish.
- A durable Emacs observation identity that can recover from a lost first
  checkpoint response without changing the writing session or event chain.
- The reviewed Emacs automatic/background recovery and background persistence
  changes made since `v0.3.3-rc.2`, including bounded queues, durable-prefix
  checkpoints and exact storage retries.

See the [review fixes and regression evidence](review-fixes-2026-09-25.md),
[Emacs recovery review](emacs-recovery-review-2026-09-24.md), and
[capture latency review](emacs-capture-latency-review-2026-09-24.md).

## Publication and deployment

The existing tag workflow runs the reusable checks, publishes the application
image for amd64 and arm64, and attaches
`possiblymadebyahuman-extension-0.3.4.zip` to the GitHub release. Image tags
include `ghcr.io/juanre/possiblymadebyahuman:0.3.4` and `:latest`.
Publishing an image does not deploy Render. Require `/health` to report the
tagged commit and `/ready` to succeed after deployment.

No new migrations or record-format changes are introduced relative to 0.3.3.
Keep the image's default startup command so migrations 001–005 are checked
before service readiness. The previously deployed `v0.3.3-rc.2` image already
supports the chunked publication used by these producers.

For an unpacked extension update, replace files in the existing installation
directory, reload that extension at `chrome://extensions`, and reload editor
tabs. Keep one installation enabled to retain the existing local history.
For Emacs, update the complete checkout, including `producers/emacs/scripts`,
and reload `pmbah-mode.el` or restart Emacs after ordinary file saving.

The extension remains a developer-mode ZIP distribution. Authenticated Gmail
acceptance and Chrome Web Store publication are separate from this release.

## Validation

The review-fix handoff records 641 passing local tests before the version bump.
The release gate reruns type checking, managed PostgreSQL tests, production
container startup/migrations and browser acceptance, site build and extension
packaging. The tag workflow repeats checks against the exact release commit
before publication; its result is the final release evidence.
