# Release 0.3.3 candidate handoff

This release replaces full-history producer snapshots and monolithic publication
with incremental journals, resumable upload chunks, streaming analysis and paged
verification. It also includes the producer correctness fixes and the subsequent
Emacs recovery corrections. UX redesign remains deferred.

The release tag is `v0.3.3-rc.1`; the extension package version is `0.3.3`.
The existing release workflow publishes the multi-platform GHCR image and the
extension ZIP. Publishing that image does not deploy Render. The owner requested
GHCR publication only; Render deployment remains a separate step.

## Startup migrations

Keep the image's default startup command:

```text
node apps/ingest-api/scripts/start-production.mjs
```

It awaits the checked migration runner before starting the HTTP service. On the
currently deployed schema, this release applies:

- **004:** permits unknown inserted/deleted totals and largest insertion size.
- **005:** adds resumable uploads, immutable event chunks, exact delay counts
  and cached observation summaries. Existing records remain inline and retain
  their hashes.

Migration ordering and checksums are verified. A PostgreSQL advisory lock and
transaction serialize concurrent startups; failed migration aborts startup.
`/ready` requires all migration versions included in the image. No separate
local execution against the production database is required.

Deploy the API/viewer before distributing extension 0.3.3 or using the new Emacs
publication path. Check `/health` against the release commit after a later Render
deployment and require `/ready` to succeed.

## Compatibility and rollback

Legacy bounded uploads and existing inline records remain supported. Browser
drafts migrate only after the new journal verifies; Emacs preserves legacy helper
entry points. Existing valid canonical hashes do not change.

Both migrations are additive or relax constraints. If startup migration fails,
its transaction rolls back; retain the existing service and investigate the
error. After this release accepts chunked records, an older application image
cannot read them correctly. Prefer a forward fix. Restoring an older image then
requires a coordinated database restore to the same pre-release recovery point,
with an explicit decision about writes since that point; do not drop chunk
tables or reapply non-null constraints as an improvised rollback.

## Review and validation

The [architecture report](long-session-architecture.md) links implementations,
regressions and full-scale evidence. The [correctness ledger](producer-correctness-fixes-2026-09-23.md)
records the earlier findings and deferred UX discussion. GitHub release checks
run against the exact tagged commit before publishing the image.

Local release validation after the recovery corrections:

- `PMBAH_SCALE_EVENTS=4000000 npm run check`: TypeScript and **410 tests passed**,
  no failures or skips, including real PostgreSQL publication of four million events.
- `BUILD_REVISION=review-worktree-0.3.3-rc.1 make test-release-container`:
  startup migrations, HTTP smoke and **163 browser tests passed**.
- Native Emacs/helper subset: **57 tests passed**. An independent reviewer also
  ran nine adversarial probes and approved the recovery corrections.
- `node scripts/benchmark-emacs-journal.mjs`: four million live characters and
  events recovered under a 96 MiB helper heap cap; the next 400 edits wrote about
  792 bytes each, retained a 256-event tail and completed in 308 ms.
- Extension ZIP and Hugo site packaging passed; staged diff checks passed.
