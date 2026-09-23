# Extension 0.2.0 UX reset

Implementation branch: `feat/explicit-writing-sessions`. Parent: [epic #3](https://github.com/juanre/possiblymadebyahuman/issues/3). This supersedes the floating-control approach in PR #2. Record format remains 0.2; existing public records are unchanged.

## Result and task coverage

| Task | Implemented behavior | Evidence |
| --- | --- | --- |
| #4 explicit activation | Context menu, keyboard or panel starts one chosen editor. No sessions, text measurement or checkpointing from unchosen fields. Reload/full-document navigation/stop/finish end authorization. | Worker authorization tests; real Chromium capture and installed-extension tests. |
| #5 browser controls | Side panel and toolbar status; no injected overlay. Session selection stays pinned during confirmation. | Panel harness, installed extension, source checks. |
| #6 identity and measurements | Fresh explicit sessions bypass fuzzy identity matching; same-document sharing is a separate user choice. No raw certainty labels. | Dispatcher and worker tests; independent lifecycle review. |
| #7 rich text | Numeric-only Unicode positions, paragraph/BR length, native paste/delete/selection and IME; honest unknown measurements when unsupported. | Pure numeric tests and Chromium rich-text scenarios. |
| #8 historical timeline | Ordinary unknown-position edits appear in bounded activity bins; known prefix remains visible. No invented length. | Unit conservation/density checks and viewer browser tests. |
| #9 finishing and results | Freeze/drain first, exact frame/document target, requested binding cannot silently disappear, single submission, complete URL/Open/Copy, explicit clipboard outcome, retained links after cleanup. | Worker race/authorization tests, panel tests, installed iframe/binding/failure flows. |
| #10 loading | Stable record shell while loading, no title substitution, retry on fetch failure. | Desktop/mobile delayed-fetch tests and failure/retry test. |
| #11 acceptance/copy/package | Current behavior documented in SOT, privacy, installation and store drafts; social descriptions corrected. Packaged Chromium/local-service testing. | Final gate results below. Authenticated Gmail and production deployment remain separate acceptance steps. |

## Decisions made during review

- Capture never starts just because a field receives focus. Dormant targeting listeners retain weak references, not copies of editor text.
- Same-document tabs can explicitly share one process log. Multiple active surfaces are not silently collapsed to one wording binding: finish offers process-only publication. Independent drafts remain separate.
- A stopped snapshot cannot be rebound from later text. Binding failure offers Cancel or explicit process-only publication. An apparently helpful Retry binding control was removed because it could never recover an immutable snapshot. Transport/upload failures retain the same signed record for retry.
- Stop, discard and process-only finish do not compute a wording commitment. Binding is computed only when requested at finish.
- A canceled publication leaves capture stopped. Starting an independent record requires an empty editor; automatic continuations are removed from the extension. `/write` and Emacs retain their own documented behavior.
- Uploaded numeric events/private checkpoint tokens are cleared after the grace period. The local public URL and binding outcome survive until the three-day inactivity expiry. Removing the local reference does not delete a public record.
- Broad host permission remains. Exact right-click targeting in arbitrary embedded editors uses dormant listeners in all frames. `webNavigation` supplies frame/document routing and navigation cleanup; `contextMenus` and `sidePanel` provide browser-owned controls. The package requires Chrome 120, matching its existing JavaScript build target. It does not claim activeTab-only permissions.

## Independent review record

Implementers did not approve their own work:

- Activation/security by activation agent; independently reviewed by rich-text agent and root. Review found document-route races, late joins during finishing, a delayed status probe revoking drain authorization, detached DOM retention, stale active states, and optional binding being computed on Stop. These were corrected and regressions added.
- Rich-text measurement by rich-text agent; independently reviewed by activation and panel agents. No remaining blocking findings; canceled input measurement expiry was added during review.
- Panel/finishing by panel agent; independently reviewed by activation agent and root. Removed the ineffective binding retry. Root checked explicit binding consent; panel's independent integration review caught saved references disappearing after event cleanup.
- Viewer and copy by root; independently reviewed by panel agent. Activity counts preserve events without claiming length; header geometry is tested at desktop/mobile sizes. Empty/malformed and single-event states are explicit. Documentation was corrected for manual copying, stopped sessions, shared-session binding limits and immutable binding failures.
- Final manifest, packaging, tests, shared-core compatibility and delivery procedure received a separate integration review by activation agent.

## Validation

Final local validation: `npm run check` passed **294 tests with no skips**, `make test-release-container` passed **83 browser tests with no skips**, and the Hugo production site build passed. The PR/release handoff records the final CI result and artifact identity. Validation includes deterministic package/privacy canaries and `make test-release-container`: a disposable production image and database, HTTP smoke tests, and the entire browser suite including the installed extension. Test uploads use local disposable services, not production. No dependencies, local state, secrets, source maps or build outputs are committed.

The browser suite covers a chosen empty rich editor, unchosen fields, selected wording in an iframe, native rich-text edits, failed binding, clipboard denial, reopened saved links, exact finish routing, delayed loading and historical activity. Headless installed-extension tests open the real side-panel document in a browser tab to exercise its controls; they do not claim automation of Chrome's native side-panel chrome or context-menu click UI.

## Known limits and next acceptance

- No authenticated Gmail walkthrough has been performed. Browser fixtures do not establish compatibility with Gmail's current editor, pop-out compose windows or account-specific behavior.
- A same-page application route change that keeps the chosen editor alive does not end its capture. Use Stop to end that draft; other editors still require explicit activation.
- Native browser undo/redo and unsupported embedded content can leave positions unknown. Equal-size programmatic rewrites without input events cannot be detected from numeric snapshots alone. Public copy must not promise universal editor coverage.
- Three-day local expiry still applies to saved links; copy links somewhere durable. Public records have no deletion API.
- Store submission/approval is pending. The ZIP is a developer-mode prerelease, not a Chrome Web Store install.
- The server/viewer changes require a separate production deployment; the development branch and local production-container test do not update the live site.

Human acceptance after installing the identified ZIP and deploying the matching viewer:

1. Reload Gmail. Open a fresh compose. Before starting, edit recipient/subject and confirm the panel has no new draft.
2. Right-click the empty body and start its writing record. Type a paragraph, insert emoji, paste, select/replace, delete, and use an IME if relevant. Confirm only the body has an active draft and no webpage overlay appears.
3. Select the intended wording. Finish, review context, and publish. Confirm the full URL is visible; Open and Copy work. Check that the public timeline and wording comparison agree with the selected text.
4. Edit afterward, reload, and reopen controls. Capture must stay stopped and the saved URL must remain available.
5. Repeat with a pop-out compose, a second unrelated compose, and deliberate same-document tab sharing. Shared sessions must not silently choose a binding from one tab.
6. Note the extension version and any failure, without sharing private email text. Keep #11 open until this manual pass and the matching deployed-viewer check are complete.
