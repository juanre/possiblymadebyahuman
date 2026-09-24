# Emacs recovery and lifecycle review — 24 September 2026

Scope: file/session persistence, automatic and interactive recovery, journal
verification/migration, capture interruption, helper ownership, checkpoint and
signing cleanup, and the corresponding installation/usage documentation.
This reviews the Emacs changes following release `v0.3.3-rc.2`.

## Resulting behavior

Opted-in files recover automatically. Verification runs in a helper process and
installs live state only after the journal's saved boundaries, hashes,
observation anchors and frozen manifest verify and metadata is saved. The buffer
shows `PMBAH:recovering` and remains read-only; unrelated buffers keep working.
Closing cancels the worker and preserves saved capture intent. Explicit pauses,
empty sessions, multiple files and frozen uploads survive reopening.

Interactive `pmbah-mode` recovery and `pmbah-recover-session` use the same worker
path. Noninteractive Lisp activation remains synchronous. A read-only metadata
probe lets paused files stay paused without taking ownership from another
buffer. Active recovery rereads metadata after acquiring ownership.

## Confirmed findings and fixes

| Finding | Correction |
| --- | --- |
| Reopening required manual activation; empty opt-ins and pause choices were not durable. | File-visit recovery plus persisted capture intent and empty sessions. |
| Verification blocked the editor for the full history scan. | Worker verification, bounded results, shared transactional state installation. |
| Renaming after a major-mode change could leave recovery under the old filename. | Lifecycle hooks are restored for active and paused sessions. |
| Cancellation after verified installation could release locks while retaining a live cursor. | Retain ownership and close protection whenever installed state survives. |
| Journal append cancellation could duplicate an event on retry. | Protect append/cursor bookkeeping; repair uncertain appends before retry; interrupted saves pause capture. |
| Cancelling checkpoint launch could remove Emacs's change hook while the mode remained enabled. | Contain errors/quits, terminate the attempt, preserve the hook and capture subsequent edits. |
| Fast callbacks could replace a newer HTTP request handle with an already-finished helper. | Check attempt/stage identity and preserve the newer handle. |
| Missing Node leaked helper buffers and a stderr process. | One cleanup path handles partial startup, cancellation and ordinary completion. |
| Closing a recording buffer left checkpoint processes and watchdogs running. | Abandon checkpoint work before releasing session ownership. |
| Shutdown cancellation deleted helper buffers still present in its iteration snapshot. | Skip dead buffers during cancellation and save/exit traversal. |
| A rejected signing command could unlock a recovering buffer. | Reject before signing cleanup runs; preserve recovery protection. |
| Recovery could replace a retained empty session or fail to associate a recovered unnamed session with a file. | Require an unused destination buffer; associate successful recovery with its visited file without replacing unrelated state. |
| Automatic and explicit activation treated damaged state differently; stale-file retirement could replace evidence or claim success after failure. | Preserve damaged saved sessions; require successful persistence and a unique retirement destination for live clock exhaustion. |
| Legacy migration could still materialize the old array in Emacs; an older configured helper did not understand metadata-only requests. | Move migration into the worker and retain the old helper entry point's delegation. Remove superseded Lisp migration code. |
| Recovery metadata parse errors could echo private values; malformed results could carry large arrays into Emacs. | Generic parse errors, field filtering, compact frozen envelopes and a 1 MiB metadata-result cap. Validate session identity before constructing journal paths. |
| Updating an already-loaded package left old global close hooks and missed existing capture intent. | Remove obsolete global hooks and migrate active/paused buffer preferences on reload. |
| Public docs described the old checkpoint protocol and manual reopening behavior. | Update installation, recovery, cancellation, pause and private-journal documentation. |

## Validation

The native lifecycle suites use actual Emacs file visits and process restarts.
Background tests hold verification behind an explicit gate, demonstrate that
other buffers and independent recoveries progress, and then release the gate.
They also exercise stale callbacks, competing ownership, failed metadata commits,
renames/reverts, frozen uploads, missing executables, legacy migration and shutdown.
Journal tests inject cancellation before, during and after writes, then verify
exact event sequences after retry; checkpoint tests verify that future edits
remain captured and helper/HTTP/watchdog resources are cleaned up.

Independent reviews covered the helper/integrity paths and the full editor
lifecycle; no unresolved material findings remained in those scopes. Final
validation passed **96 Emacs/helper tests with zero skips**, **9 deployment/docs
checks**, the Hugo documentation build, and `git diff --check`. Run:

```sh
node --test tests/emacs-producer.test.mjs tests/emacs-journal.test.mjs tests/emacs-lifecycle.test.mjs tests/emacs-async-recovery.test.mjs
```

## Deliberate boundaries

- Full verification still takes time; it now runs outside Emacs's foreground
  work. The recovering file remains protected until verification completes.
- Current journals use bounded streaming memory. Migrating a legacy JSON-array
  snapshot still requires parsing that old array in the worker once; it never
  returns that array to the editor.
- Recovery restores process metadata, never the document's text. Normal document
  saving and Emacs's own text recovery remain separate.
- Renaming onto a file with an unrelated saved session preserves both histories
  and reports the retained path; it does not guess which session should win.
- Diagnostic exports and the old helper entry point remain intentionally
  supported compatibility interfaces, not unused capture paths.
