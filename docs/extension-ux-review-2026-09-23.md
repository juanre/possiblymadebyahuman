# Writing-record UX review — 23 September 2026

The Gmail walkthrough exposes a failure of the complete author-to-reader flow.
The product asks people to understand field discovery, identity matching,
observation states and measurement limitations before it helps them make a
writing record. Automated checks passed because several of these compromises
were encoded as expected behavior.

The owner's direction is now explicit: starting capture requires a deliberate
action on the chosen editor; PMBAH must not cover page content with labels or
controls. This supersedes the passive/capture-all extension design. The
content-blind architecture and accepted same-document sharing across tabs remain.

Tracking: [UX-reset epic #3](https://github.com/juanre/possiblymadebyahuman/issues/3).
The aweb connectors were unavailable (not connected/reauthentication required),
so the actionable tasks are in the repository's GitHub issue tracker.

## What is established

Review baseline: extension 0.1.2 at `997ffb5`, supplied for local testing in
PR #2; production source is the merged review at `6809773`. PR #2 is now draft
and its floating-control direction is superseded. This review does not publish
another patch or change runtime behavior.

1. **Starting is implicit and too broad.** `attachListeners` registers a field
   on focus. The eligible input list includes email, search, URL and telephone
   inputs. Registration creates session metadata; the first mutation can send
   a server checkpoint. The recipient/subject behavior is a direct consequence
   of that policy, not a Gmail-specific accident. The earlier positioning patch
   preserved this wrong interaction model.
2. **“Degraded” describes identity matching.** `resolveSession` returns a new
   session with `identity_certainty: degraded` when a descriptor partially
   matches an existing field but its DOM signature differs. A controlled plain
   input example reproduces it. It does not establish that the writing is bad,
   text is lost, server observation failed, or rich-text measurements are absent.
   The code separately calls rich-text fallback “degraded”; those two meanings
   must not be conflated in product copy.
3. **The overlay is the wrong place for controls.** Its position can be made
   accurate, but PMBAH cannot know which host-page content it obscures. Showing
   one control per discovered field compounds the problem. Browser-owned UI
   should contain status, actions and explanations.
4. **The red-then-success path can silently change the signed result.**
   `performSign` shows an error if requested text binding cannot be obtained,
   then uploads without it. `reportUploadOutcome` replaces that warning with
   success. A controlled missing-binding response reproduced precisely this
   sequence. `requestBinding` addresses a tab without the stored frame ID, and
   its failure cases collapse into `undefined`. Wrong-frame/stale-editor routing
   and concurrent confirmation clicks need coverage. The exact user's Gmail
   failure remains unconfirmed pending the public record URL; the reproduction
   is not proof of which failure occurred there.
5. **Success is too transient.** Link delivery is a three-second toast plus a
   short-signature link inside a refreshed session list. There is no persistent
   focused result with the complete URL and a dedicated copy action. Clipboard
   success is correctly checked in code, but upload, binding and clipboard
   outcomes are not presented as a coherent result.
6. **The public page swaps shells.** `App` first renders a generic “Writing
   record” heading and loading paragraph, then replaces it with `RecordPage`.
   This explains a loading flash without establishing a network redirect.
7. **An empty rich-text field already loses length information.** In a real
   Chromium fixture, starting in an empty contenteditable and typing `hello`
   produced five inserts with `ins_len: 1`, `pos: null`, and `del_len: null`.
   Both the format helper and viewer return unknown length from the first event.
   That fallback is deliberate in the producer. Keeping text private does not
   prevent measuring codepoint counts or edit positions transiently.
8. **The viewer then hides the available activity.** Without a known length,
   `EditTimeline` draws no curve. Its separate marker filter keeps only notable
   operations. The five ordinary typing events above produce zero markers,
   giving an empty plot despite real recorded activity. The explanatory copy
   speculates about pre-existing text; this reproduction began empty.

Source entry points at the reviewed revision:

- `apps/browser-extension/src/content/capture.ts`: registration, rich-text
  beforeinput/input/composition paths, binding requests.
- `apps/browser-extension/src/lib/descriptor.ts` and
  `packages/producer-core/src/session-id.ts`: eligible fields and identity.
- `apps/browser-extension/src/popup/popup.ts`: signing, binding, clipboard and
  toast lifecycle.
- `packages/format/src/index.ts`: `computeObservedLength`.
- `apps/web/src/main.tsx`, `record-utils.ts`, `components.tsx`: loading and
  timeline rendering.

Local reproduction evidence: `/tmp/pmbah-ux-reset-reproduction.json` and
`/tmp/pmbah-signing-review-reproduction.json`. These use synthetic local fixtures;
no public record or checkpoint was created for this review.

## Proposed interaction

1. The author chooses the body/editor: right-click → **PMBAH → Start writing
   record**. Provide an equivalent keyboard/toolbar path. Merely focusing fields
   or opening PMBAH does not activate capture.
2. The author writes normally. A toolbar status indicates an active writing
   session. Recipient, subject and unrelated fields remain untouched.
3. Clicking the toolbar opens a browser side panel for the explicitly selected
   session. It identifies the editor and offers **Finish & get link**, stop and
   discard actions. Define stop/continuation coverage before coding; edits made
   while stopped cannot later be represented as captured.
4. Finish reviews context and selected-wording/whole-field binding. If a requested
   binding cannot be made, pause for Retry, Cancel or an explicit process-only
   choice. No automatic downgrade and no competing submissions.
5. Completion remains visible: **Record saved**, complete URL, **Open record**,
   **Copy link**, binding outcome and meaningful observation limitations.
6. The reader sees a stable page with useful edit activity. Show a document-length
   curve only when supported; an activity view must work independently of it.

The exact browser-owned surface is a recommendation; explicit activation and
removing persistent page overlays are owner requirements. Chrome supports
[editable context menus](https://developer.chrome.com/docs/extensions/reference/api/contextMenus)
and a [browser side panel](https://developer.chrome.com/docs/extensions/reference/api/sidePanel).
[activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)
can grant access after a gesture, but reliable target selection and cross-origin
frames must be tested before promising removal of all broad host permissions.
The menu API identifies a frame, not the exact DOM editor: do not guess from
focus after the menu closes or accidentally pass selection text onward.

## Tasks and order

| Task | Priority | Dependency / outcome |
| --- | --- | --- |
| [#4 Explicit per-editor start](https://github.com/juanre/possiblymadebyahuman/issues/4) | P1 | First: consent, activation lifecycle, field/frame targeting, permissions and legacy-draft behavior. |
| [#5 Browser-owned controls](https://github.com/juanre/possiblymadebyahuman/issues/5) | P1 | With #4: no webpage overlays, discoverable controls, accessible panel and preserved selection. |
| [#6 Identity and limitation language](https://github.com/juanre/possiblymadebyahuman/issues/6) | P1 | After #4: distinguish field matching, measurements and observation; preserve legitimate cross-tab sharing. |
| [#7 Rich-text measurements](https://github.com/juanre/possiblymadebyahuman/issues/7) | P1 | After activation contract: define numeric text model and accurate capture from an empty editor. |
| [#8 Activity when length is unknown](https://github.com/juanre/possiblymadebyahuman/issues/8) | P1 | Independent viewer fix; improves existing immutable records immediately on deployment. |
| [#9 Binding, signing and persistent result](https://github.com/juanre/possiblymadebyahuman/issues/9) | P1 | The no-silent-downgrade guard can land early; full integration uses #4–#6. |
| [#10 Stable record loading](https://github.com/juanre/possiblymadebyahuman/issues/10) | P2 | Independent shell/loading correction. |
| [#11 Complete journey acceptance and copy](https://github.com/juanre/possiblymadebyahuman/issues/11) | P1 | Release gate across all preceding tasks, including real Gmail walkthrough. |

First implement the smallest complete explicit-start/body-only/browser-controls
prototype (#4–#6), not another overlay patch. Fix the legacy viewer (#8), loading
(#10) and immediate binding guard (#9) independently. Then finish rich-text
measurement and the durable signing flow, and validate the entire journey.

## Boundaries and evidence required

- Define one consistent Unicode codepoint model for rich text: paragraph/BR
  handling, selections, emoji, replacement, undo, IME and programmatic edits.
  Numeric length and exact edit position are different measurements. Preserve
  what is known; never fabricate what is not.
- Current records do not encode all the measurements needed to recover historical
  document length. The viewer can display their event activity now; it cannot
  honestly manufacture their missing length. New measurements must use correct
  existing events or an explicitly versioned format/conformance change.
- The complete scenario must start with a clean browser profile and verify zero
  unsolicited session/checkpoint activity before activation. Include recipients,
  subject, multiple compose windows, same-document tabs, reload, worker restart,
  frame routing, selected binding, denied clipboard, failed upload and slow API.
- Existing E2E sign/upload coverage used a textarea. Rich-text tests explicitly
  expected unknown positions, and timeline tests expected only notable markers.
  Replace those acceptance gaps with assertions about the complete user task.
- Test fixture fidelity and product acceptability are different. Finish with an
  authenticated Gmail walkthrough and truthful screenshot evidence; synthetic
  tests do not establish that manual result.
- Update SOT, architecture, privacy, onboarding, permission explanations and store
  copy together. Include social-preview metadata: `apps/web/index.html` still
  describes the record as how the text was written. The selected wording and
  recorded editing process must not be asserted to have the same provenance.
- No plaintext crosses into public records or background messages. No authorship
  verdict, confidence score or certification is added. Old records stay immutable.
- Do not use PR #2 / version 0.1.2 as the final store submission for this flow.
  Package and publish one identified successor after the acceptance task passes.
