# Long-session architecture

Owner requirement, 23 September 2026: a single writing session must support
millions of edits over two years, including a Bible-length Emacs buffer. Storage
capacity must not be confused with per-edit computational cost. This milestone
supersedes the snapshot persistence limitation in the correctness ledger.

## Invariants

- Capture adds one numeric mutation to an append-only journal. Normal capture,
  status, checkpointing and saving must not clone, scan or rewrite prior events.
- Working event memory is bounded. Session metadata and persisted sequence/byte
  cursors are separate from immutable events. Acknowledgement follows storage
  commit; failure preserves the pending event and stops acknowledging further
  capture. First-party and Emacs buffers pause editing; an extension cannot
  prevent someone from editing the host page after capture stops.
- Recovery validates journal continuity. Interrupted final writes may be
  repaired only at an incomplete tail; corruption inside a committed prefix
  must fail visibly. Legacy drafts migrate before their old copy is retired.
- Frozen publication references an immutable event prefix and manifest. Retry
  neither rebinds current text nor changes the signed finish time.
- Publication uses bounded idempotent chunks and resumes at the server's
  committed sequence. The server verifies sequence, chronology and the hash
  chain before exposing a finalized record. Incomplete uploads are private.
- Public record identity and existing canonical hashes remain unchanged.
  Storage chunks are not separate public records or automatic continuations.
- Summaries and event pages load separately. Full verification streams every
  event with bounded memory; partial loading must never claim full verification.
- No public or durable producer payload contains document plaintext.

## Architecture

Browser producers use transactional event storage and separate session metadata.
Emacs uses a private append-only numeric-event journal and atomic small metadata.
Interactive Emacs capture uses a persistent disk worker: the modification hook
only queues numeric events, and worker acknowledgement follows journal fsync
and atomic metadata commit. The pending queue is capped at 256 events; failures
retain the exact request for idempotent retry, and checkpoints never outrun the
acknowledged cursor. Readiness and per-frame credits bound each transport send
to 4096 bytes. Normal lifecycle transitions drain storage before changing paths,
releasing locks, or publishing. Abrupt failure may lose not-yet-durable events.
Batch Emacs callers retain a synchronous persistence interface.

Both expose bounded event-page readers. Recovery and explicit full verification
may take linear time; adding the next event must not depend on history length.

Browser restart loads metadata committed atomically with IndexedDB event rows;
it does not rescan the stored journal. Full browser-prefix validation occurs
during legacy migration and publication. Emacs recovery scans its file journal
and checks persisted count, byte and hash anchors before accepting its state or
repairing an unacknowledged tail.

The ingest service stores bounded event chunks in PostgreSQL. Upload transitions
are serialized transactionally. Fixed-size analysis accumulators advance as each
chunk is accepted. Exact delay percentiles use persistent delay counts, allowing
PostgreSQL to sort on disk rather than retaining all delays in Node memory.
Finalization seals the already validated chain tip and atomically publishes the
manifest, summaries, observation binding and chunk references.

Legacy array APIs remain only where required for existing records, small bounded
payloads or explicit exports. Production capture must never fall back to full
snapshots after a journal failure. Unused superseded code must be removed.

## Validation requirements

- Historical canonical vectors and hashes unchanged.
- Equivalent statistics and analyzer results across arbitrary chunk boundaries.
- Millions of events and two-year timestamps; retained memory and write volume
  bounded per append, measured near the beginning and end of the session.
- Crash/restart at append, metadata update, migration, chunk acceptance and
  finalization; exact retry after lost responses.
- Reject reordered, overlapping conflicting, truncated, malformed and tampered
  input without publishing a partial record or changing a committed prefix.
- All producers use the scalable path; browser integration, native Emacs,
  PostgreSQL, and production-container release tests cover it.

## Measured evidence

Deterministic fixtures contain numeric events only. These measurements describe
this local machine, not a production service latency guarantee.

- `node --max-old-space-size=128 --expose-gc scripts/benchmark-long-record.mjs`:
  4,000,000 events spanning two years; hashing plus fixed-size analysis 17.5 s;
  full paged verification including fixture page hashing 35.3 s. Exactly 977
  pages of at most 4096 events, 630-byte analysis state and 128 overview bins.
  The process completed under the 128 MiB Node heap cap; sampled heap growth
  was about 70.4 MiB, including temporary allocations before garbage collection.
- PostgreSQL scale test (`PMBAH_SCALE_EVENTS=4000000`, Node heap cap 128 MiB):
  4,000,000 events published in 44.3 s; publication plus complete paged read and
  verification 82.5 s. Maximum sampled heap 62 MiB. Final scale/compatibility run:
  18 tests passed, no failures or skips. Exact percentiles match the array oracle.
- Native Emacs (`node scripts/benchmark-emacs-journal.mjs`): a live
  4,000,000-character buffer and 4,000,000-event journal spanning two years.
  After the recovery corrections, the next 400 edits took 308 ms
  (229 ms near the beginning), writing about
  792 bytes per edit (767 bytes near the beginning). The retained event tail
  stayed at 256; metadata was 689 bytes and the checkpoint descriptor 462 bytes.
  Hashing the 400-event checkpoint suffix took 91 ms. Full recovery took 21.8 s
  with the helper under a 96 MiB Node heap cap.

A linear pass is still required to recover/verify a journal or check every event
in a record. That work is separate from normal edits. Interactive Emacs signing
and browser verification run outside the editor's foreground execution path.

## Compatibility and cleanup

Migration 005 adds chunked storage without rewriting existing public hashes or
inline records. Browser drafts migrate from the old snapshot only after their
new event journal verifies. Emacs preserves explicit old helper entry points for
existing configurations; normal capture/signing use journal descriptors. Old
one-shot API and explicit diagnostic export remain bounded compatibility tools,
not alternate production capture paths. Default statistics share one streaming
implementation. Array-only custom analyzers are reported as unavailable for
chunked records instead of silently substituting another analyzer.

## Independent review and cleanup

Three agents implemented and cross-reviewed producer capture/storage, native
Emacs and PostgreSQL publication. The coordinator reviewed shared hashing,
streaming analysis, paged verification and the integration changes. Review found
and fixed discard/append races, mutable retry context, duplicate legacy session
IDs, stopped DOM observers, duplicate publication ownership, and asynchronous
Emacs freeze/cancellation boundaries. Regression tests cover those failures.

A subsequent fresh review found three Emacs recovery defects: failed inspection
could leave live state that bypassed inspection on retry; saved hash anchors were
not compared; and tail repair could truncate acknowledged bytes before rejecting
the journal. The recovery corrections stage live state until validation and
metadata persistence succeed, check persisted anchors during the scan, and allow
tail repair only after those checks. Errors and quits retain a retryable original
state and preserve damaged acknowledged bytes.

The unused registry `reopen()` API and its obsolete test were removed. Uploaded
segments stay immutable; `continueFrom()` creates an explicit linked segment.
Shared hashing and analysis replace duplicated implementations. Production
producers have no snapshot fallback. Current architecture/producer docs describe
the journal and chunk protocol, and the Docker dependency stage includes every
workspace manifest. Historical milestone evidence remains labelled as historical.

The compatibility paths retained intentionally are old public inline records,
bounded one-shot ingest, one-time legacy draft migration, explicit diagnostic
exports and Emacs helper entry points used by existing configurations. They do
not participate in normal journal appends.

## Review entry points

| Boundary | Implementation | Evidence |
| --- | --- | --- |
| Shared record identity | [incremental hashing and verification](../packages/format/src/index.ts) | [streaming/hash-vector tests](../tests/streaming-record.test.mjs) |
| Browser persistence | [registry](../packages/producer-core/src/registry.ts), [IndexedDB journal](../packages/browser-storage/src/index.ts), [upload protocol](../packages/browser-storage/src/upload.ts) | [journal tests](../tests/producer-journal.test.mjs), [migration tests](../tests/browser/journal-storage.spec.mjs) |
| Incremental browser measurements | [numeric text index](../packages/browser-capture/src/numeric-text-index.ts), [rich DOM index](../apps/browser-extension/src/lib/richtext-index.ts) | [numeric oracle](../tests/numeric-text-index.test.mjs), [DOM oracle](../tests/browser/richtext-index.spec.mjs), [producer parity](../tests/browser/producer-capture-parity.spec.mjs) |
| Native capture and publication | [Emacs mode](../producers/emacs/pmbah-mode.el), [journal helper](../producers/emacs/scripts/event-journal.mjs) | [native journal/lifecycle tests](../tests/emacs-journal.test.mjs), [live-buffer benchmark](../scripts/benchmark-emacs-journal.mjs) |
| Server transactions and analysis | [upload API](../apps/ingest-api/src/chunked-api.ts), [chunk store](../packages/storage/src/chunked.ts), [analysis accumulator](../packages/analyzers/src/streaming.ts), [migration 005](../packages/storage/migrations/005_chunked_records.sql) | [real PostgreSQL tests and scale fixture](../tests/chunked-ingest.test.mjs) |
| Public verification | [paged verifier](../apps/web/src/stream-record.ts), [worker](../apps/web/src/record-verifier.worker.ts), [reader](../apps/web/src/paged-record-page.tsx) | [browser integrity tests](../tests/browser/paged-record.spec.mjs), [bounded-memory benchmark](../scripts/benchmark-long-record.mjs) |

## Initial integration — before the fresh-review recovery corrections

- `PMBAH_SCALE_EVENTS=4000000 npm run check`: TypeScript and all **400 tests**
  passed, with no failures or skips. Includes native Emacs, real PostgreSQL,
  legacy compatibility, privacy, migration and four-million-event publication.
- `BUILD_REVISION=review-worktree-20260923-long-session make test-release-container`:
  production image built with the complete workspace manifest list; startup
  migrations and HTTP smoke passed; all **163 Chromium tests** passed, including
  the installed extension and paged-record integrity/retry cases.
- The native Emacs subset passed **52 tests**, including asynchronous cancellation
  during both manifest creation and publication.
- `git diff --check`: passed. Generated build/test outputs were removed; the
  dedicated test PostgreSQL service was returned to its previous stopped state.
  Disposable release containers, networks, images and databases were cleaned up.

The subsequent recovery corrections and GHCR release are covered by the
[0.3.3 candidate handoff](release-0.3.3-candidate-handoff.md). Migrations 004 and
005 run at image startup. Render deployment, UX and broader copy decisions
remain separate from this release publication.
