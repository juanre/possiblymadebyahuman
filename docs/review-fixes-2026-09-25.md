# Review fixes — 25 September 2026

The three confirmed review findings are fixed in source. Existing Emacs
background-persistence work is preserved. No format or database migration is
required, and this document does not establish deployment.

| Finding | Change | Regression evidence |
| --- | --- | --- |
| P1: malformed JSON below the HTTP byte limit could exhaust the API heap during validation | The content check visits one child at a time and bounds depth, width, total work, field names and diagnostics. Legacy event validation stops after enough failures to fill the error response. | `tests/ingest-resource-limits.test.mjs` sends six malformed payload shapes to a real HTTP server in a child Node process with a 128 MiB heap. Every request returns 400 with bounded diagnostics; health remains available. |
| P2: a failed save between coalesced browser checkpoints left observation permanently in flight | Checkpoint task cleanup releases its in-flight flag, marks metadata dirty, and retains queued work until persistence succeeds. The next edit can retry immediately; finish-time flushing also recovers. | Two cases in `tests/producer-journal.test.mjs` inject a failed journal commit, restore storage, and verify both recovery paths preserve the token, observation identity and event count. |
| P2: Emacs could never recover an observation whose first token-bearing response was lost | Observation has a separately persisted identity. An unavailable response rotates that identity while retaining the writing session and event chain. Recovery and upload use the saved identity; legacy metadata falls back to the writing session ID. | Two native Emacs cases in `tests/emacs-producer.test.mjs` use the real API. One drops the first response after server commit, observes 404, reopens the buffer and successfully publishes under a fresh observation ID. The other reopens old metadata without the new field and successfully reuses its existing token. Both verify the published record. |

The API's legacy one-shot event cap is 131,072, independent of a deployment's
HTTP byte cap. Other validation limits are documented in
[`apps/ingest-api/README.md`](../apps/ingest-api/README.md). Current producers
continue to publish in chunks of at most 4096 events. Public records remain
plaintext-free and retain the same hashes and observation semantics.

Validation completed:

- `npm run typecheck`: passed.
- `npm test`: 478 passed; the optional four-million-event PostgreSQL scale test
  was skipped. The managed suite exercised both current and upgrade databases.
- `npm run build:web` and `node apps/browser-extension/scripts/build.mjs`: passed.
- `npm run test:web-browser`: 154 passed. Its nine service-dependent cases were
  run separately below.
- `npm run test:extension-e2e` against a temporary local PostgreSQL-backed API:
  nine passed, using the installed extension in Chromium.
- `git diff --check`: passed.

That is 641 passing Node and browser tests, excluding duplicate targeted runs.
The temporary integration database was removed after the run. Local logs are
`/tmp/pmbah-fixes-tests.log`, `/tmp/pmbah-fixes-browser.log`, and
`/tmp/pmbah-fixes-e2e.log`.
