# Review fixes — 20 September 2026

The reviewed baseline was `wip/review-fixes` at `f9e81e6`, 32 commits ahead of `main` (`416690f`). These changes address the accepted findings from that review. They are release-hardening work within the existing architecture and format.

The two-tab finding (original finding 3) was withdrawn at the owner's direction: matching fields for the same document should share a session. Identity and matching policy are unchanged. A regression test confirms that the same continuation resumes across tabs.

## Code fixes and evidence

| Original finding | Change | Regression evidence |
| --- | --- | --- |
| 1 — inaccurate `/write` capture | Measure applied changes using numeric before/after measurements; handle word/grapheme deletion, undo, paste and composition without retained plaintext. | `write-capture.test.mjs`; native Chromium deletion, undo and clipboard paste; composition events. |
| 2 — Emacs HTTP errors treated as network failures | Classify HTTP status before the generic `url-retrieve` error flag. | Real HTTP 400/404/409/429 responses through Emacs. |
| 4 — edits silently omitted after failed upload | Keep the retry canvas read-only; prevent discard while signing. | Browser retry tests assert the canvas is frozen. |
| 5 — stalled checkpoints block signing | Abort each browser checkpoint after 30 seconds, including response-body reads; limit flush to two rounds; ignore late results. | Stalled adapter, late completion, and edits arriving during every flush round. |
| 6 — successful checkpoint lost on worker restart | Persist checkpoint outcomes immediately and serialize storage writes. | Reload after an idle checkpoint; overlapping writes cannot reverse snapshot order. |
| 7 — Emacs loses divergence on reopen | Persist divergence and its reason immediately; restore the pin on resume. | File-backed Emacs close/reopen scenario. |
| 8 — continuation lost after uploaded-log cleanup | Clear events/tokens after the uploaded grace period while retaining a continuation reference through the three-day TTL. | Grace sweep, worker restart, non-empty field resumption, cross-tab sharing, and eventual expiry. |
| 9 — directly appended editable field missed | Scan the added root element as well as its descendants. | Dynamically appended textarea in Chromium. |
| 10 — cancelled edits create phantom events | Emit pending browser mutations only after `input` confirms an applied edit. | Cancelled `beforeinput` followed by a real edit in extension and `/write`. |
| 11 — malformed event containers throw | Reject invalid manifest/event containers before array operations. | API tests for absent, null, object and string inputs; real Postgres harness. |
| 12 — integers overflow Postgres | Bound checkpoint counts and aggregate statistics before storage. | Oversized checkpoint and two individually valid insertions that overflow aggregate columns, against real Postgres. |
| 13 — unbounded public metadata | Bound producer ID/version and attestation keys; reject unknown producer keys. | API rejection cases and existing plaintext-boundary audits. |
| 14 — unmeasured waits count as active | Sum only inter-event gaps below the idle threshold in API statistics and timing analysis. | Long initial/final waits, an idle interval, and a single-event record. |
| 15 — Hugo mobile overflow | Wrap long identifiers and allow narrow navigation to wrap. | Four generated Hugo docs at 390px, alongside the existing React phone checks. |

## Copy changes

The elapsed-time claim is retained with its actual boundary: reproducing the span between the first and last server-received checkpoints requires the same wall-clock interval between submissions. It does not establish writing effort; a script can prepare events and wait. Unobserved client timestamps impose no such delay.

The site, record viewer, signing flows and documentation now distinguish selected wording from the process that allegedly produced it; checkpoint receipt times from writing boundaries; and internal hash consistency from comparison against an independently retained hash. Privacy copy describes local text inspection, default-on optional binding, public guess checking, checkpoint traffic, durable Emacs state, continuation retention, and the unsaved `/write` canvas. Store-preparation copy reflects extension v0.1.1 and labels old artifact metrics as historical. Architecture and binding status descriptions reflect the implementation.

## Validation

- `npm run check`: **279 passed, 0 failed, 0 skipped**, including typechecking, real Emacs and Docker Postgres tests, conformance and privacy audits, and Hugo generation.
- Full Chromium suite with `PMBAH_LOCAL_BASE_URL` pointing at current-source runtime plus a disposable Postgres 16 database: **56 passed, 0 skipped**, including the installed-extension capture/sign/upload/continue flow.
- After final prompt and status-label polish: all **24 Emacs tests** and **22 `/write`/mobile browser tests** passed again.
- Web build, Hugo build and deterministic extension v0.1.1 packaging succeeded. `git diff --check` passed.
- Added PR/main checks that exercise Emacs, Postgres, Hugo and the installed extension. Workflow YAML parsed locally; the hosted workflow has not run yet.
- The initial URL-required release gate has been replaced by a self-contained disposable Docker/Postgres gate; installed-extension testing cannot silently skip.

At the initial handoff, no source changes had been committed, pushed or deployed. Existing local application/database containers were left running; disposable test databases were removed.

## Limits

The follow-up correction presents legacy active-time caches with endpoint waits excluded, without rewriting the stored cache or immutable record. Timing analysis is now version 0.1.1. The stricter metadata bounds can reject previously accepted oversized metadata. No database migration is required. Browser runtime evidence is from Chromium; composition coverage includes synthetic IME events, not a manual tour of operating-system input methods. The full release-image gate and Chrome Web Store publication were not performed.


## Release follow-up

The public example is explicitly labeled as historical, with a pinned link to the original Markdown source that its binding covers. The rendered/revised article is not represented as matching that old record, and its lack of server observation is disclosed.

Legacy timing is corrected on API reads, preserving each cached idle total and its original threshold. This provides corrected public values immediately after deployment without a database migration or production-data rewrite. New timing analyses use version 0.1.1; immutable events, hashes, and checkpoints are unaffected.

The release workflow invokes the reusable checks at the tagged revision before publishing. The gate builds the production image, checks its embedded revision, runs its startup migrations and HTTP smoke tests against a fresh Postgres database, and runs the installed extension against it. GitHub Releases receive durable extension zip downloads. Production `/health` exposes only a public revision identifier alongside health status.

Follow-up local evidence: 282 checks and 56 Chromium tests passed, including the full disposable Docker-image gate. Real operating-system IME and Chrome Store account/submission checks still require a human environment; no such manual checks are claimed here.
