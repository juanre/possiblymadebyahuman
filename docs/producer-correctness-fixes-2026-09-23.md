# Review findings and implementation ledger

Owner direction: make all producers equivalent in correctness, fix implementation
defects individually with independent agent review, and leave UX/copy decisions
for a later discussion. This ledger records source findings, not deployment status.

## Shared correctness contract

All producers must record actual edit timing, represent unknown measurements
honestly, preserve idle time and uncaptured boundaries, seal an immutable upload
before sending it, and recover/retry that same upload after failure. No plaintext
may enter public records or durable producer state. Historical record hashes stay
unchanged. Editor-specific activation and controls can differ.

## Implementation work

| ID | Finding / required outcome | Status / evidence |
| --- | --- | --- |
| C01 | Reject contradictory operation lengths even when position is unknown; rejected appends must not mutate sessions. | Fixed; independent `review_contract` review approved. 50 format/core and 132 API/checkpoint/extension tests passed. |
| C02 | Extension timestamps measured queued worker processing. Carry capture time through registration and delivery queues. | Fixed; capture_timing implementation independently reviewed by coordinator. 142 Node tests and delayed registration/ACK Chromium regression passed. |
| C03 | Equal-length undo/redo disappeared and ambiguous net changes invented sizes. Share honest numeric capture semantics across browser producers. | Fixed; review_contract implementation independently reviewed by coordinator. 69 Node tests, 12 privacy audits, 19 existing and 13 new Chromium capture tests passed. |
| C04 | Emacs starts/resumes against unknown text without marking boundaries. Match browser gap semantics and bind the full buffer when narrowed. | Fixed; emacs_review implementation independently reviewed by coordinator. 26 Emacs tests passed, including gap and narrowing scenarios. |
| C05 | Reader text matching could announce success for a tampered record. Require valid record integrity. | Fixed; capture_timing independent review approved. Five targeted browser tests passed, including tampered event and binding responses. |
| C06 | Clipboard actions could report success without copying or reject unhandled. Report actual outcomes. | Fixed; capture_timing independent review approved. Missing, denied and working clipboard browser cases passed. |
| C07 | Unknown measurements became definite zero/understated totals and disagreed with analyzers. Preserve uncertainty consistently. | Fixed; capture_timing implementation independently reviewed by coordinator. Targeted API/analyzer tests, 11 real PostgreSQL tests and unknown-size browser rendering passed. Migration 004 required. |
| C08 | Persistence failures and reload could lose recoverable uploads or accepted links. Durable recovery must also prevent concurrent writers overwriting state. | Fixed; coordinator and review_contract reviewed browser recovery and exclusive /write storage ownership. Capture-save, frozen-save, reload retry, accepted-link failure, malformed response, failed discard and multi-tab regressions pass. Extension refresh-error warning also tested. |
| C09 | Browser uploads had no complete-request deadline and accepted malformed success responses. Bound requests and validate acknowledgements. | Fixed; capture_timing independent review approved deadline and response validation. Tests cover stalled fetch/body, abort, late settlement, malformed/mismatched acknowledgements and exact retry. |
| C10 | /write and Emacs lacked signed finish, immutable retry and linked continuation guarantees. Align while preserving legacy hashes. | Fixed; both now use format 0.3 for new records, save before upload, recover immutable retries, and link continuations. Independent review approved; 36 native Emacs tests passed, plus browser recovery and continuation regressions. |
| C11 | Large sessions repeatedly serialize full history; storage and API limits need explicit handling, without silently losing edits. | Superseded by the authorized [long-session architecture milestone](long-session-architecture.md): incremental producer journals, chunked publication, streaming analysis and paged verification. Full-scale evidence and final integration are recorded there. |
| C12 | Backend resource/rate limits and operational coverage need review; distinguish existing bounds from deployment assumptions. | Fixed scoped runtime bounds; coordinator independently reviewed normalized admission and deadlines. Runtime and privacy tests passed. Deployment quotas remain explicit decisions below. |
| C13 | Update architectural/status documentation and add cross-producer regression evidence. Source version and deployed version must remain distinct. | Fixed; architecture and producer documentation updated and independently reviewed. The initial TypeScript, 365-test suite and 147-browser-test production-container release gate passed without skips; superseding integration evidence is in the [long-session report](long-session-architecture.md). |

The rows identify implementation and independent review evidence. Source and
regression entry points are linked below. Scope expansions and unresolved
decisions are recorded explicitly rather than described as completed.

### Source and regression entry points

- C01/C07: [format validation and measurements](../packages/format/src/index.ts),
  [analyzers](../packages/analyzers/src/index.ts),
  [format regressions](../tests/format-conformance.test.mjs),
  [API regressions](../tests/ingest-api.test.mjs), and
  [migration 004](../packages/storage/migrations/004_unknown_size_stats.sql).
- C02/C03: [shared numeric capture](../packages/producer-core/src/measured-input.ts),
  [extension capture](../apps/browser-extension/src/content/capture.ts),
  [/write capture](../apps/web/src/write-capture.ts), and
  [cross-producer browser regressions](../tests/browser/producer-capture-parity.spec.mjs).
- C04/C10: [Emacs implementation](../producers/emacs/pmbah-mode.el),
  [native Emacs regressions](../tests/emacs-producer.test.mjs),
  [/write lifecycle](../apps/web/src/write-page.tsx), and
  [/write browser regressions](../tests/browser/write-page.spec.mjs).
- C05/C06: [reader components](../apps/web/src/components.tsx),
  [reader regressions](../tests/browser/record-page.spec.mjs), and the /write files above.
- C08/C11: [session registry](../packages/producer-core/src/registry.ts),
  [extension dispatcher](../apps/browser-extension/src/lib/dispatcher.ts),
  [persistence regressions](../tests/producer-core-checkpoints.test.mjs), and
  [multi-tab ownership regressions](../tests/browser/write-storage-ownership.spec.mjs).
- C09: [upload deadline](../packages/producer-core/src/upload-deadline.ts),
  [response validation](../packages/producer-core/src/upload-response.ts), and
  [upload regressions](../tests/upload-deadline.test.mjs).
- C12/C13: [API runtime](../apps/ingest-api/src/server.ts),
  [runtime limit regressions](../tests/runtime-resource-limits.test.mjs),
  [architecture](sot.md), and [signed finish contract](signed-finish-and-continuations.md).

### Correctness-pass validation — before the long-session rewrite

- `npm run check`: TypeScript passed; all **365 tests passed**, none skipped.
  Includes native Emacs execution, real PostgreSQL integration, conformance,
  privacy audits, and packaging checks.
- `BUILD_REVISION=review-worktree-20260923 make test-release-container`:
  production image built from the modified working tree; startup migrations and
  HTTP smoke passed against disposable PostgreSQL; all **147 Chromium tests
  passed**, none skipped, including the installed browser extension.
- `git diff --check`: passed.
- Independent agents reviewed capture, persistence/recovery, native Emacs,
  shared contracts, reader integrity, deadlines, runtime limits, and documentation.
  Findings discovered during those reviews were fixed and retested.
- These results preceded the long-session rewrite and its subsequent recovery
  corrections. See the [0.3.3 release handoff](release-0.3.3-candidate-handoff.md)
  for release and startup-migration requirements. Historical valid hashes remain
  unchanged; no production data audit or Render deployment was performed.

## Deferred UX and copy discussion

- Text-check language: “Same wording” overstates a letters/digits-only match
  (for example, `now here` and `nowhere` canonicalize alike).
- Reader information order, density, duplicate visualizations, technical terms,
  analyzer presentation, and visibility of verification context.
- Homepage utility/CTA placement on mobile, a concrete sample record, and the
  “reverse Turing test”/overall tone.
- Extension discoverability in site navigation and onboarding.
- Publishing vocabulary: signing, binding, hashes, and what a link establishes.
- Public metadata defaults, duplicate titles/labels, visibility and deletion
  expectations, and opt-in policy.
- `/write` focus restoration, keyboard interactions, and broader error layout.
- Editor-specific continuation controls and text-binding opt-out policy.

Correctness fixes may require narrowly scoped error/status messages; they do not
constitute approval for a visual redesign or broader copy rewrite.

## Review limitations and maintenance observations

- Authenticated Gmail, native extension panel behavior, and assistive technology
  still need manual acceptance; automated fixtures are not deployment evidence.
- Dense extension lifecycle code deserves simplification as fixes touch it;
  avoid a speculative rewrite during this pass.
- Production PostgreSQL/container behavior must be distinguished from local
  in-memory API/browser evidence.

### C01 compatibility note

Valid historical hashes and canonical vectors remain unchanged. Previously
accepted events with contradictory known sizes now fail structural verification.
No production record dataset was available to audit for those malformed records.

## Capacity and deployment follow-ups

- The former full-history writes and monolithic publishing limit are replaced
  by the [long-session architecture](long-session-architecture.md). A session's
  total size is no longer constrained by one request or one browser storage value.
  Migration 005 is required for the resumable API and immutable event chunks.
- Local disk and browser capacity remain finite. Write failures preserve a
  retryable prefix and stop claiming successful capture; events are never silently
  evicted or automatically split into separate public records. Storage retention
  for unfinished server uploads and lifetime anonymous quotas remain operator
  policy, distinct from bounded per-edit work.
- Per-client rate limits behind a trusted proxy, cumulative anonymous storage
  budgets and monitoring thresholds require deployment policy. No production
  edge protections were verified. In-process admission, body limits and timeouts
  can bound individual requests but do not impose a lifetime storage quota.
- Content-blind browser adapters do not detect arbitrary same-length
  programmatic text changes. Incremental UTF-16 indexing also cannot notice a
  silent same-UTF-16-length replacement before the next edit; finish-time numeric
  measurement detects any remaining codepoint-length drift. They retain no
  document snapshots and do not claim complete visibility into outside edits.

## Additional findings discovered during fixes

- Repeated Emacs edit attempts could bypass an erroring modification hook because
  Emacs removes hooks after errors. Fixed with editor-level read-only state and
  repeated-attempt tests. Save failures retain the latest event and hooks, pause
  editing, and recover through `pmbah-retry-save` without unfreezing signed records.
- Emacs recovery-file rename collisions and multiple recovery owners must never
  overwrite another session. Fixed with ownership locks and collision checks,
  including discard/sign/continuation regressions.
- `/write` now serializes storage ownership between tabs; a saved log can be
  recovered without storing or restoring the canvas text. Failed clearing also
  preserves the canvas and does not reset capture against the wrong baseline.
- A detected uncaptured change could reach signing before another real edit
  marked its boundary. All producers now refuse text binding in that state;
  process-only publication remains available. Six additional browser regressions
  cover numeric drift at finish, recovery by editing, and explicit opt-out.
