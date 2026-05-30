# browser extension

Chrome/Chromium Manifest V3 producer for `possiblymadebyahuman` content-blind writing records.

The extension captures the **shape** of editing in any textarea or plain text input on any page — codepoint-anchored insert/delete/replace events with wall-clock timestamps and source attribution — and uploads a signed, content-blind writing record to the configured ingest service when the user clicks **Sign & upload** in the popup. No document text is ever stored, hashed, logged, or transmitted.

## Responsibility

- Passive per-field session identity, mutation capture (`beforeinput` / `input` with codepoint maths), and a wall-clock event timeline that preserves idle gaps.
- Multiple independent per-field sessions running in parallel — two textareas on site A and one on site B all record independently; signing one freezes and uploads only that field's session.
- Capture-context redaction at sign time (URL stripped of query/hash, title editable/omittable).
- Server-observed checkpoints via the producer-core `CheckpointAdapter` (see `packages/producer-core` for cadence/backoff semantics).
- Chrome/Chromium MV3 package output, deterministic zip artifact for sideload and store submission.

## Non-responsibility

- Backend storage, ingestion, or record page presentation.
- Plaintext upload, document hashing, or replay payloads.
- Snapshotting existing non-empty fields. See the **Eligibility** section below.
- Human/AI verdicts, scores, badges, or certificates.
- Store submission or real install URL publication (owned by a separate task).

## Architecture

The kernel lives in `packages/producer-core`. The extension wires that kernel to Chrome runtime primitives via thin adapters and a message dispatcher:

```
content/capture.ts     ← DOM observer; reads field state transiently to compute
                         codepoint-anchored PendingMutation values; renders a
                         small floating per-field badge.
       │
       ▼  chrome.runtime.sendMessage
background/service-worker.ts
       │  hosts the SessionRegistry; routes messages through
       │  lib/dispatcher.ts; runs a daily TTL sweep on chrome.alarms.
       ▼
lib/adapters.ts        ← chrome.storage.local, fetch upload, fetch checkpoint,
                         Date clock, crypto.randomUUID, navigator.clipboard.
       │
       ▼
popup/popup.ts         ← lists sessions across all open tabs, signs one, copies
                         the returned short URL.
```

The trust boundary is the service worker: it is the only place that talks to the network. The content script never sees a network call, and the popup only sends user-initiated control messages. The service worker bundle is statically audited to contain no DOM/text-reading symbols.

### Content-script vs popup response shape

The two contexts that send messages to the service worker have different trust profiles, and the response shapes returned to them differ accordingly:

- **Content script** (runs inside every page, including untrusted ones). It forwards only `register_field` and `append_mutation` messages and is allowed to observe only three response kinds: `register_field_result` (carries `session_id` and identity `certainty` only — never observation state), `append_mutation_result` (a pure ack with no payload), and the generic `error` (kind + reason). The full `SessionRecord` — including the bearer `observation.last_observed_token` used to authenticate server-observed checkpoints — never crosses the message boundary into a content-script context. A recursive regression test (`tests/browser-extension-canary.test.mjs`) walks the responses for the content-script message kinds and asserts no `last_observed_token` field and no token-equal string ever appears.
- **Popup** (extension-privileged page, signed by the extension manifest, not reachable from page JavaScript). It forwards `list_sessions`, `sign_session`, `retry_failed_upload`, and `discard_session`. The popup may retain full `SessionRecord` state in v0 because it is extension-privileged. If a future v0.1 surface exposes that state to less-privileged code, the same regression test should be extended to cover those kinds.

## Eligibility (the per-field invariant)

A new producer scope rule applies: **the extension does not snapshot existing non-empty fields**. When the user focuses an eligible field for the first time, the producer-core registry checks for a resumable session matching the field's descriptor under the current `(origin, path, field_kind)` slice. The outcomes:

- **Empty field, no resumable session** → fresh session, badge reads `recording`.
- **Empty field, resumable session matches** → the existing session is resumed, badge reads `recording (resumed)`.
- **Non-empty field, resumable session matches** → resumed, mutations continue.
- **Non-empty field, no resumable session** → INELIGIBLE. Badge reads `not recording (existing content)`. To start a session in this field the user must either clear the field or open a fresh one.

This is deliberate: silently snapshotting pre-existing draft text would be a content-blindness violation, and silently merging an unrelated session into the field would be misleading.

## Sign / upload flow

1. Focus a textarea or plain text input. The badge appears: `recording`, `recording (resumed)`, or `not recording (existing content)`.
2. Type. Each `beforeinput`/`input` cycle synthesises a codepoint-anchored mutation that is forwarded to the service-worker registry. The producer-core cadence engine commits a server-observed checkpoint on the first mutation, then every 50 events or every 60 seconds with at least one new event (no idle heartbeats).
3. Open the popup. The session for the focused field appears under its origin group.
4. Click **Sign & upload**. The service worker calls `registry.flushObservation` to cover the tail of uncheckpointed events, signs the session, and POSTs `{manifest, events, observation: {observed_session_id, token}}` to the configured ingest endpoint.
5. On success the popup shows the returned `short_signature` (the record URL), copies it to the clipboard, and removes the session.
6. On failure the session moves to `failed_upload` with the reason visible in the popup. **Retry semantics in v0**: producer-core does not memoise the signed draft between attempts, so a true in-place retry would require re-signing a session that is no longer `active`. The popup labels this explicitly: **Discard** the failed session and continue typing to start a fresh one, then sign again. This avoids pretending a one-click retry works when the kernel does not support it. A follow-up task may add draft memoisation if real usage shows the workflow matters.

## Build, package, install

```bash
npm --workspace @possiblymadebyahuman/browser-extension run build
npm --workspace @possiblymadebyahuman/browser-extension run package
# or
make extension-build
make extension-package
```

Outputs:

- build directory: `apps/browser-extension/dist/`
- deterministic zip: `apps/browser-extension/dist/possiblymadebyahuman-extension-<version>.zip`

The version comes from this package's `version` field and is injected into the built `manifest.json`. `EXT_BASE_URL` overrides the production API origin at build time:

```bash
EXT_BASE_URL=http://localhost:8787 make extension-package
```

### Sideloading in Chrome / Chromium

1. Build the extension (or download the zip artifact).
2. Open `chrome://extensions`.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select `apps/browser-extension/dist/`. (To install the deterministic zip on a clean profile, click **Pack extension** with the `dist/` directory, or use **Load unpacked** directly on an unzipped copy.)
5. Pin the extension to the toolbar for easier popup access.
6. Open any page with a textarea and start typing. The badge should appear in the top right of the field.

### Support matrix

| Browser | v0 status |
|---|---|
| Google Chrome (MV3) | **Required.** Acceptance target. |
| Chromium (Brave, Edge, Vivaldi, Arc, Opera) | **Best-effort.** Same MV3 + `chrome.*` APIs; sideload steps identical. No known incompatibilities. Not gated. |
| Mozilla Firefox | **Documented incompat.** Firefox 121+ supports MV3 but uses a different `browser.*` namespace and ships its own polyfill story. v0 does not target Firefox; a follow-up task will evaluate the `webextension-polyfill` shim. |
| Safari | **Out of scope for v0** unless explicitly re-scoped. Safari's MV3 surface differs enough that a separate target would warrant its own task. |

### Manual testing

The agent that wrote this code cannot load a real browser. The following manual checks are the responsibility of the human or reviewer who installs the unpacked extension. Each check corresponds to an acceptance criterion in the task.

- **Textarea capture and binding (Chrome).** Open `chrome://newtab`, navigate to any page with a `<textarea>`, focus it, type a few characters, select a subset of the field text, observe the `recording` badge, open the popup, click **Sign & upload**, confirm the sign panel says it will bind selected text or all field content, and confirm upload returns a `short_signature` copied to the clipboard. Repeat without a selection to confirm it binds all field content.
- **Contenteditable degraded capture and binding (Chrome/Gmail-like surface).** Open a contenteditable surface (e.g. any rich-text reply box that is fundamentally a contenteditable div), focus it, type. The badge should read `recording`. Select only the reply/body text you intend to sign, leaving surrounding quoted/header/footer material unselected if present. Open the popup — the event count grows as you type. Sign and confirm the upload succeeds. Note: positions are labelled `unknown` for contenteditable in v0; the badge surfaces this explicitly via the source-attribution column.
- **Multi-field, multi-site session isolation.** Open two textareas on site A in one tab and one textarea on site B in another tab; interleave edits; confirm three independent sessions appear in the popup grouped by origin; sign one; confirm the other two remain `active` with their event counts unchanged.
- **Pre-existing content INELIGIBLE.** Open a page where a textarea already has some text (e.g. a draft restored by the site itself). Focus it. The badge should read `not recording (existing content)`. Clear the field; the badge should switch to `recording`.
- **Idle gap preserved.** Type into a textarea, switch to another tab for several minutes, come back, type one more character. Sign and inspect the record: the last event's `t` should reflect the wall-clock gap, not a compressed value.
- **TTL sweep.** Leave a session untouched. After 3 days plus an hour the `chrome.alarms` job should sweep it. Easier to verify in tests than by waiting: see `tests/producer-core.test.mjs`.
- **Failed upload.** Block the configured ingest endpoint (e.g. via DevTools network throttling or by pointing `EXT_BASE_URL` at a closed port). Sign; the popup should show the failure reason and offer **Discard**. Discarding clears the session.

## Content-blindness guarantees

The package's static + runtime safeguards:

- `tests/browser-extension-canary.test.mjs` builds the production bundle and asserts the service-worker bundle contains no `.innerText`, `.textContent`, `event.data`, or `plaintext` references; the popup bundle contains no DOM-text reads; all bundles contain no producer-core plaintext kernel symbols (`b3HashText`, `getInsertedText`, `replayEvents`, `replayEventsWithText`, `ReplayTextProvider`); and the source files outside the content script never touch DOM text or the banned `final_text_*`/`ins_hash`/`ins_text` symbols.
- `tests/browser-extension-package.test.mjs` re-asserts the deterministic zip shape: same SHA-256 across rebuilds, only the eight expected entries, no source maps, no `.ts`, no `.env*`, no `.dev*`.
- `tests/browser-extension.test.mjs` covers the descriptor extractor, codepoint maths, eligibility policy, and the full register → append → sign → upload flow against in-memory fakes; one test runs the signed manifest through `packages/format.verifyRecord` to confirm the produced record is conformant.
- `packages/producer-core/tests/producer-core-audit.test.mjs` is the kernel-side static audit; this is its consumer-side mirror.

## Store/release docs

- `docs/browser-extension-release.md` — build/package commands, release workflow, Chrome manual publication, Edge/Firefox status, and versioning.
- `docs/chrome-web-store-prep.md` — human publisher checklist plus draft listing, privacy, and permission text.

Do not publish a placeholder install URL. The real Chrome Web Store URL is recorded only after the store listing task lands.
