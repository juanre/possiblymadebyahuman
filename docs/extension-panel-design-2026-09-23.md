# Extension panel: current work, text checks and saved history

Status: **implemented in the 0.3.0 candidate; release and authenticated-site acceptance remain separate**. Extension 0.2.1 is the currently deployed release. It supplied long-duration storage, non-expiring drafts/links and explicit unsigned-draft resumption. The current candidate adds private editable names, focus following, explicit text-check scope, compact searchable/exportable history, signed finish and linked continuations. Deploy the compatible API/viewer before distributing the candidate. This document does not assert production deployment or authenticated Gmail acceptance.

## Candidate implementation

- **This editor** follows exact editor identity in the panel's browser window and active tab. Focus alone never starts capture. Other drafts remain separately accessible; visiting saved history does not retarget an editor. Rename uses a private local name, distinct from the public label reviewed at finish. Defaults use site, field metadata and a stable distinguishing number, never document contents.
- **Finish & get link** pins the target draft. **Selected text** or **Whole field** identifies the text to be signed; changed scope requires another confirmation. Normal publication includes the text check, without an opt-out checkbox or long explanation in the panel. Public context remains available before publication. An unavailable scope or failed text check offers cancellation or explicit publication of editing activity only.
- **Saved records** is last and collapsed by default. It has lightweight paged rows, search by name/site/date/link, Open/Copy, expandable details, Rename, explicit Continue and explicit removal. One recent publication result remains until Done. **Export all links** includes the whole saved-link list and its private names/site metadata, without document text or checkpoint credentials. No time/count eviction was added.
- **Stop** retains an unfinished draft. Resume is explicit, may use a non-empty field on the same site origin, and keeps session identity, checkpoints and clock. Missing edits are not reconstructed; unknown positions prevent an invented document-length curve.
- **Continue in chosen field** starts a distinct session linked to an immutable saved record. It captures only new mutations. Its clock starts at the parent's signed finish, or a retained local upload-time approximation for a legacy parent. The prior saved link remains; no document identity is inferred.
- The extension opts into **format 0.3 signed finish**. Confirmed publication freezes and persists elapsed duration before network work; retries keep the same sealed record. Returning only to publish includes the pause without creating an edit. Duration is a client claim, distinct from the server's received-checkpoint span. Old 0.1 drafts retain last-edit timing; failed legacy uploads keep their original frozen version. `/write` and Emacs have not opted in.
- Viewer length curves hold their measured value between edits and jump at the next edit. They stop at unknown measurements and do not extend over the interval after the last edit. The viewer marks leading/trailing no-edit intervals and distinguishes signed duration, editing span and active/idle time between edits. Rhythm bins count pauses above 100 seconds explicitly.

The [signed-finish contract](signed-finish-and-continuations.md) and [canonicalization specification](spec/canonicalization.md#format-03-finalization) define format compatibility. Historical handoff documents describe their own release state and are not rewritten by this amendment.

## Original feedback and design rationale

The following observations describe the earlier 0.2.0 screenshots and the resulting requirements, not unresolved behavior in 0.3.0.

## What the screenshots reveal

The panel asks the writer to understand cryptographic terminology, infer which of two identically labelled editors belongs to which card, and browse finished records while trying to work. These are connected problems with the panel's organisation and selection model.

Evidence from the 0.2.0 screenshots and implementation:

- `popup.ts` renders all sessions in registry order as full cards. Uploaded records still have a Select this record action and a nested full result panel.
- The worker updates its selected session on an explicit start. Ordinary editor focus remains local to the content script, so the panel cannot follow it.
- Uploaded links remain in session anchors only until the three-day expiry. Upload resets the timestamp, so the anchor normally expires about three days after publication, at the next sweep. Removing the anchor does not remove the public record.
- Session lists include full event arrays and the panel compares them during polling. A history with hundreds of entries needs lightweight summaries and bounded rendering, not just collapsed markup around the same data.

## Panel organisation

1. **This editor**: the editor the writer is actually using, with its current state and relevant actions. Focus moves between enrolled editors should update this immediately, without another Start or Select click.
2. **Other drafts**: compact rows with stable order, not a reshuffling wall of cards. Failures that need action remain visible here, never filed away as successfully saved.
3. **Saved records (count)**: last and collapsed by default. Opening it shows recent records as compact rows. Opening one row reveals details; Open and Copy remain quick actions.

After publication, show one clear success result with its URL and Open/Copy actions so the writer can share it. Keep it visible until the writer moves on; then place it in saved history. Do not accumulate permanently expanded success cards. Collapsing history is a view preference, not deletion.

The permanent introduction can shrink after first use, leaving a Help entry. Internal messages such as "local event log cleared" and checkpoint counts belong in optional details, not the primary task flow.

## Focus and identity rules

- Current-editor context belongs to the panel’s browser window and active tab. Focus in another window must not retarget it.
- Editor focus and capture activation are separate. Focusing a field must never start capture, measure its text or create a session.
- A focus signal for an existing enrolled editor identifies its exact session/tab/frame/document; it must not choose a card by label, URL or descriptor similarity.
- An untracked field must not appear to be covered by the previously focused draft. Show that no writing record is active for this field, with an explicit Start action when eligible.
- Moving into the panel retains the last page-editor context. Browsing a saved record does not change the current editor or redirect later writing events.
- Finishing pins its target until the confirmation is completed or canceled. Focus changes must not silently change the record being published. The review explicitly identifies that draft.
- Cards are user-nameable. Supply reasonable generic defaults from site and available editor metadata, with a stable disambiguator when needed (e.g. "example.com · Comment · 2"). Preserve a custom name across reload, resumption and saving. Do not read field contents, recipients or subjects to invent names. Local card naming is distinct from the public label reviewed before upload.
- Highlight the matching panel card and bring it into view only if needed. Preserve keyboard focus and text selections. No persistent label or controls over webpage content.
- If a later "Show editor" action is added, it must route to the exact live editor without changing its text selection. Closed editors need an honest unavailable state, not a guessed replacement.

## Text-check language

Normal publication computes the text check. Do not show an opt-out checkbox or a lengthy explanation in the publishing panel.

Show the actual target separately: **"Selected text"** or **"Whole field"**. Keep this generic across websites and editor types. The owner explicitly removed the spacing/punctuation/capitalisation sentence from the main interface; do not reintroduce it elsewhere in the primary flow. Do not make the reader mentally execute a conditional sentence. If scope changes before confirmation, update or reconfirm it; the displayed scope must agree with the text bound at finish. Share only selection presence/numeric scope across contexts, never selected plaintext.

Keep the limitations in the public documentation: comparison uses letters and numbers, does not establish exact equality, ignores number formatting too, and does not establish that these recorded edits produced that text or identify its author. Explain that a public check permits guessed text to be tested; short/predictable text may be guessed. The publishing panel must not imply encryption.

Saved-state copy can say "Text check included" and link to the explanation. Avoid "wording commitment", "candidate wording", "process-only", and "local reference" in primary controls. When the text-check scope is unavailable or computation fails, explain the consequence directly: readers can inspect the editing activity but cannot compare a copy of the text.

## History after 200 write-ups

Required policy, replacing the earlier expiry model:

- Saved links and unfinished writing sessions must not expire automatically. Separate the live session, its preserved editing history, and any immutable published records. Clean up redundant/transient state without deleting the information required to continue the session or retrieve its published links.
- Keep lightweight saved history locally until the user removes it. Retain only what retrieval needs: record link/identifier, saved time, site, a non-content-derived display label and minimal status. Never retain document text, excerpts, event arrays or private checkpoint credentials in history.
- Show a bounded recent page of compact rows, with search over stored labels/site/date/link and a clear route to older entries. Do not render or transfer all historical event logs to browse links.
- Offer export of links and explicit removal/clear-history controls. Explain that local removal does not delete public records. State that local history is device/browser-specific and can be lost on uninstall or browser-data removal; no account or sync is implied.
- No time-based or count-based automatic eviction. Handle storage limits and failed writes visibly, preserving existing data and offering export or deliberate deletion rather than deleting older entries.
- Persist currently available uploaded anchors into history successfully before their session cleanup can remove them. A failed history write must preserve the source link for recovery. Already expired links cannot be recovered from the current local state; do not promise to restore them.

## Returning after months

A writer can explicitly start a session in a field, leave, and return two months later to continue that same session. Preserve the original session identity, numeric event history, custom name and timeline origin. Closing a tab or restarting the browser detaches the live editor; it must not expire or finalize the writing session.

- The gap is elapsed time in the signed editing timeline. Do not reset the clock or compress it to active typing time. Distinguish a pause from evidence of continuous observation: edits made elsewhere while the extension was absent are not retroactively captured.
- New fields still require explicit activation. Reattach a previously authorized session automatically only with reliable document/field identity. Generic URL, field label, or DOM position alone is not enough when a site reuses an editor for many documents. For ambiguous cases, let the writer choose the existing named session; never silently attach someone else's draft or start a replacement session.
- New sessions, resumed sessions and explicit continuations may target a non-empty field. Starting records only later edits; earlier text is not imported, and total document length remains unknown when there is no observed empty baseline. The website supplies the text; PMBAH does not store or restore the words.
- Numeric length checks cannot prove that restored text is unchanged. If edits may have been missed, preserve the gap and represent measurement uncertainty honestly rather than claiming an uninterrupted exact length curve. Do not introduce background plaintext snapshots or per-edit content hashes to solve reattachment.
- An existing published signature remains immutable. Further publication must create another immutable record/link, with the relationship to prior records explicit. Retaining a working session and retaining a published snapshot are different responsibilities. The candidate uses linked continuation sessions containing only new mutations, as defined above.
- Clarify lifecycle controls: leaving an editor is detachment, pausing is resumable, publishing creates a snapshot, and deletion is explicit. Stop retains an unfinished draft; finishing freezes a published segment, and Continue creates a new linked session.

### Historical blockers and their resolution

1. The earlier three-day expiry is disabled for extension drafts and saved anchors. Cleanup removes uploaded event logs/tokens only after retaining the link; failed durable writes must preserve recoverable state.
2. Migration 003 widened duration/delay/active/idle columns to PostgreSQL `bigint`. Safe-integer JSON decoding supports months without rounding. Counts and positions retain their existing limits; historical hashes remain unchanged.
3. Unsigned server observation metadata no longer expires after seven days. Old checkpoints remain useful across long absences, without fake idle heartbeats or claims of continuous observation.
4. Durable attachment remains an explicit user choice. Exact live tab/frame/document routing does not become a cross-month identity guess based on URL or labels.
5. Format 0.3 adds a final seal over elapsed finish time, optional parent hash and optional text binding. The 0.2 event-chain domain is reused to preserve draft checkpoints. Existing 0.1/0.2 records retain their original hash semantics.
6. Publication remains immutable. Continued writing uses a new linked session and new mutations, preserving the prior saved link without retaining its full event log indefinitely.

## Implementation slices and acceptance

1. Focus-aware current-editor model and distinct draft identity. Verify two identical Gmail-like bodies in one frame, other tabs/frames, untracked recipient/subject fields, keyboard navigation and a confirmation pinned during focus changes.
2. Finish/text-check copy and truthful scope display. Verify selected versus whole-field wording, changed selection before confirmation, unavailable binding, and explicit editing-activity-only fallback.
3. Durable drafts and saved-link history. Verify migration before cleanup, restart, no automatic expiry, explicit removal/export and failed writes. Keep failed uploads recoverable outside the saved archive.
4. Long-session format/storage/observation support and safe reattachment. Simulate at least 60 days away, close/restart the browser, resume a non-empty field, add edits, sign and verify the full pause survives upload and visualization. Test ambiguous same-site editors and off-device changes without inventing coverage.
5. Compact panel layout and scale. Test 0, 1, 20 and 200 saved records; narrow panel, keyboard/screen-reader use, stable focus, search/older entries and no interference with current writing. Opening/copying an old record must never alter which draft will finish.

Each implementation slice needs review by an agent that did not implement it. Automated fixtures cover the generic editor/panel behavior; they are not authenticated Gmail acceptance. Validate the assembled experience on authenticated target sites before claiming those sites are accepted. See `docs/long-sessions-handoff-2026-09-23.md` for the historical 0.2.1 foundation, and the current release handoff for final test/deployment evidence.

## Independent design review

An independent UX reviewer agreed with the current-work/history separation and requested window/tab scoping, migration-before-cleanup and sufficient history metadata. The owner subsequently overrode the proposed main-flow comparison sentence and mail-specific scope wording, and required editable names and non-expiring resumable sessions. A separate architecture reviewer confirmed the 24.86-day time limit, seven-day observation expiry, currently disabled non-empty resumption, and the distinction between last-edit duration and publication time. These are included in the implementation requirements. The 0.2.1 foundation addressed duration/storage/retention and explicit unsigned-draft resumption. The 0.3.0 candidate implements the broader panel and signed-finish design described at the top; independent review and release evidence must refer to that candidate rather than the earlier screenshots.
