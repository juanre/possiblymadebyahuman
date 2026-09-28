# Release 0.4.0 handoff

Release tag `v0.4.0` ships the public-launch work: extension 0.4.0, Emacs
producer 0.1.2, and the application image with the redesigned record page,
drafts on `/write` and service hardening.

This release includes:

- **Record page.** A descriptive header with writing time, the full span, the
  edit facts and a visible line saying the hash chain was checked in the
  reader's browser and what the server received. The edit timeline cuts pauses
  of 5 minutes or more from its time axis and labels them; the writing rhythm
  is shown as a smoothed curve from 16 ms to 10 s. Technical details stay
  collapsed at the end.
- **`/write` drafts.** Several drafts kept only in the writer's browser, in a
  database separate from the edit journal. A reopened draft continues its
  record only when its saved text matches the recorded chain; otherwise the
  record marks a gap.
- **Service hardening.** Per-client admission and rate limits (`429` with
  `Retry-After`; producers wait and retry), JSON-only API writes (`415`
  otherwise), upload size caps, a command to delete abandoned uploads, operator
  record removal with tombstones, and security headers with a strict content
  security policy.
- **Site.** The Chrome extension leads the landing page and installs from its
  [Chrome Web Store listing](https://chromewebstore.google.com/detail/possiblymadebyahuman/akodlnlfkdoiobdcghmbhhoafokmldoh);
  its page moved to `/docs/chrome-extension/`. Privacy and terms name
  pmbah@aweb.ai for record reports and legal requests.

## Publication and deployment

The tag workflow runs the reusable checks, publishes the application image for
amd64 and arm64 as `ghcr.io/juanre/possiblymadebyahuman:0.4.0` and `:latest`,
and attaches `possiblymadebyahuman-extension-0.4.0.zip` to the GitHub release.
Publishing an image does not deploy Render.

Before deploying on Render:

1. Set `TRUSTED_CLIENT_IP_HEADER=cf-connecting-ip`. Production sits behind
   Cloudflare; without this, every visitor shares the proxy's address and one
   set of rate limits.
2. Keep `PUBLIC_BASE_URL` at the production HTTPS origin.

Then deploy the service's `:latest` image on Render, which this release
updated. Keep the image's
default startup command: migrations 006 (record removal) and 007 (removal
tombstones) run before the service reports ready. Require `/health` to report
the tagged commit and `/ready` to succeed.

Optionally schedule `node apps/ingest-api/scripts/delete-abandoned-uploads.mjs`
daily. Upload the 0.4.0 ZIP to the Chrome Web Store listing as an update; the
store showed 0.3.3 when this release was prepared.

## Validation

Before tagging, the branch passed type checking, 538 Node tests under managed
PostgreSQL (one intentional skip) and the release gate: production container
startup and migrations, HTTP smoke, and 182 browser tests including the
extension end-to-end tests. The tag workflow repeats the checks against the
exact release commit; its result is the final release evidence.
