# Chrome Web Store prep for v0 browser extension

Status: release-readiness reference for `default-aaaa.26`. The browser extension
(`default-aaaa.7`) and the deterministic packaging pipeline (`default-aaaa.17`)
have landed; what remains is human-owned: developer account, listing visibility
choice, real icons, screenshots, listing copy approval, and submission to the
Chrome Web Store. This document does **not** mean the extension is listed,
approved, or installable. Do not publish an install link until `.26` records
the real Chrome Web Store URL and human approval.

This document is human/store-facing. It records the reconciled final values
from the implemented extension (frontend tip `35799f3` at this writing) and
enumerates the exact human inputs still required.

## Release policy summary

- Required for public v0: a Chrome/Chromium Manifest V3 extension installable
  through the Chrome Web Store.
- Acceptable listing visibility: public or unlisted install link, after human
  approval.
- No fake, placeholder, or "coming soon" install URL should appear on the
  homepage or release docs.
- Brave/Edge compatibility can be documented after testing. Firefox can be
  assessed and documented. Safari is out of scope for v0.
- Do not commit Chrome Web Store credentials, publisher account details, OAuth
  tokens, refresh tokens, or real store secrets.

## Human publisher checklist

The human owner must prepare or approve these items before `default-aaaa.26` can
close:

1. **Chrome Web Store Developer account**
   - Create or confirm access to the publisher account that will own the PMBAH
     extension.
   - Complete any one-time developer registration payment, identity verification,
     tax/profile, or organization checks currently required by Google.
   - Decide which human(s) can administer the listing.

2. **Listing visibility decision**
   - Choose **public** if discovery/search listing is desired at v0.
   - Choose **unlisted** if v0 should launch via direct install link only.
   - Record the decision in the release handoff for `default-aaaa.26`.

3. **Listing identity capture after creation**
   - Extension ID: `TBD after Chrome Web Store draft/listing is created`.
   - Chrome Web Store listing URL: `TBD after listing exists`.
   - Do not add either to site/homepage docs until they are real.

4. **Required assets**
   - Extension icon assets generated from approved PMBAH art, including the sizes
     required by the final MV3 manifest and Chrome Web Store listing.
   - At least the Chrome Web Store-required screenshot set for the current store
     policy. Use screenshots of the final extension UI, not mockups, unless the
     store explicitly permits promotional images.
   - Short description, detailed description, category, language, and support
     contact.
   - Privacy policy URL and support URL on the public site.
   - Any promotional tile or media assets Google requires at submission time.

5. **Manual upload flow for v0**
   - Build the store-ready zip from the committed command produced by
     `default-aaaa.17`: `make extension-package`.
   - Human signs in to the Chrome Web Store Developer Dashboard.
   - Create or update the extension item.
   - Upload the generated zip.
   - Fill listing, privacy, data-use, and permission-justification fields from
     the final reviewed drafts.
   - Submit for review only after human approval.
   - Track review status, rejection details, and approved listing URL in
     `default-aaaa.26`.

6. **Expected review timing and risk**
   - Chrome Web Store review can take hours to days and may take longer when
     permissions, host access, privacy disclosures, or remote-code concerns need
     manual review.
   - Any rejection is release-blocking until fixed or the human explicitly changes
     release policy.
   - Permission copy must exactly match the final manifest and extension behavior.

## Optional future automation

Manual submission is the v0 default. Future automation can be considered only
after human approval and a documented credential owner.

Possible future GitHub secrets, names subject to the current Chrome Web Store API
requirements:

- `CHROME_EXTENSION_ID`
- `CHROME_CLIENT_ID`
- `CHROME_CLIENT_SECRET`
- `CHROME_REFRESH_TOKEN` or the current equivalent upload credential

Rules for future automation:

- Never commit token values or publisher account details.
- Prefer upload-only automation; keep publish/release-to-users as a separate
  human-approved step unless the human explicitly approves auto-publish.
- Document token rotation and revocation before enabling CI submission.

## Draft Chrome Web Store listing copy

All copy below is draft. Reconcile it with the final extension UI and permissions
before submission.

### Draft name

PossiblyMadeByAHuman Writing Records

### Draft short description

Records the shape of your editing as a content-blind writing record. Sign and
share a short URL. Not a human/AI detector.

### Draft detailed description

possiblymadebyahuman records the shape of a writing process without uploading the
words you wrote.

When you focus an empty textarea or plain text input on any page, the extension
starts recording the shape of your editing as a content-blind event log:
insert/delete/replace positions and lengths in Unicode codepoints, timing, and
source attribution (typing, paste, drop, cut, IME, autocomplete) when the browser
reports it. Existing non-empty fields are not recorded — the badge labels them
"not recording (existing content)" so the extension never silently snapshots a
draft you started elsewhere. Nothing leaves your device while you write.

When you click Sign & upload in the popup, the extension builds a public
content-blind writing record from the events: codepoint-anchored process
metadata plus a BLAKE3 hash chain over the event sequence. The public service
stores that record and returns a short URL you can share. The returned URL is
copied to your clipboard.

Public records do not contain your document plaintext, do not include
per-event inserted text, and do not carry any text-derived hash. The capture context (page URL stripped of query and
fragment, page title, field kind) is shown for review before upload and can be
edited or removed.

This is not an AI detector. It does not decide who wrote something, assign a
confidence score, or certify authorship. It gives readers a content-blind
view of an editing session's structure and makes large pastes or atomic
insertions visible as process facts.

### Draft support text

For setup, privacy model, and troubleshooting, see the public PMBAH docs at the
approved support URL. Report extension issues through the repository issue
tracker or the support contact selected by the human publisher.

## Draft privacy and data-use disclosure answers

These answers must be reviewed against the final Chrome Web Store privacy form
and final extension behavior.

### Data observed locally

- Textarea or plain text input contents are inspected transiently inside the
  `beforeinput` event handler scope only, to compute numeric process metadata
  (codepoint offsets, insertion length, deletion length, source attribution).
  The text reference is discarded when the handler returns. No text crosses
  event boundaries; no text is retained in extension state.
- Per-event mutation structure: codepoint position, inserted codepoint count,
  deleted codepoint count, operation type, wall-clock timestamp, source
  attribution (typing / paste / drop / cut / IME / autocomplete / unknown).
- Field descriptor used for stable per-field session identity: tag name, field
  kind, name/id/aria-label attributes, nearest form id, structural DOM
  signature, and sibling index. Read once at field registration time from
  attributes only — never includes text.
- Page metadata selected for capture context: page origin, page path with
  query/hash stripped, page title, field kind. Shown for review before upload.

### Data stored or processed locally before upload

- Unsigned session event logs containing process metadata only — the public
  `BufferMutation` shape (seq, t, op, pos, del_len, ins_len, source). No text,
  no text-derived hash, no fingerprint of text.
- Per-session observation state: server-observed checkpoint commitments
  (`observed_session_id`, `event_count`, `chain_tip`, `observed_at`) and the
  current bearer `token` for the server-observed session. The bearer token
  lives only inside `SessionRecord.observation.last_observed_token` and is
  never logged, never sent to content scripts, never published.
- Local retention/TTL: **3 days from the last edit** (producer-core
  `DEFAULT_TTL_MS`). The service worker runs an hourly `chrome.alarms` job
  that sweeps expired sessions. Users can also discard a specific draft from
  the popup at any time; discard is immediate.

### Data transmitted on explicit sign/upload

- Content-blind PMBAH record manifest and event log:
  - `manifest`: format version, BLAKE3 record hash, session id, producer
    identity (`browser-extension` v0.1.0 with capabilities `timing` and
    `source_attribution`), capture context, event count, duration, and
    a server-applied ingestion timestamp.
  - `events`: the ordered list of `BufferMutation` records described above.
  - `observation`: `{observed_session_id, token}` when at least one server-
    observed checkpoint has succeeded for this session, otherwise omitted.
- Server-observed checkpoint POSTs sent during the session:
  `{event_count, chain_tip, token?}` to
  `POST /api/observed-sessions/<observed_session_id>/checkpoints`. Cadence is
  activity-gated: first mutation immediate; otherwise every 50 events or every
  60s with at least one new event since the last attempt. No idle heartbeats.
- No account identity is required by the v0 public service.

### Data not transmitted by the public/default extension

- Document text.
- Per-event inserted text.
- Text-derived hashes or fingerprints such as final-text hashes or insertion
  hashes.
- Absolute local file paths.
- Operating system, browser fingerprint, or hardware identifiers.
- A human/AI verdict, confidence score, or authorship certification.

### Chrome privacy form notes

- If the final extension reads editable page content, the Chrome disclosure may
  require acknowledging local access to website content even though plaintext is
  not transmitted. Do not answer "no access" if the implementation observes text
  locally.
- If the final extension transmits capture context URLs/titles, disclose that
  reviewed metadata can be transmitted on explicit upload.
- If optional diagnostics/telemetry are added later, update this document and the
  privacy disclosure before release. v0 should avoid extra telemetry unless
  explicitly approved.
- Any host permissions or content-script matches must be justified by the capture
  behavior and minimized where feasible.

## Permission-justification template (final, reconciled with the shipped manifest)

The final shipped manifest declares exactly three API permissions plus the
`<all_urls>` host match for the content-script-based capture-all behaviour.
Other Chrome extension APIs (`activeTab`, `scripting`, `tabs`, `cookies`,
`webRequest`, `downloads`) are deliberately not requested. Paste these
justifications into the Chrome Web Store privacy form verbatim.

| Permission / host access | Manifest field | Justification |
| --- | --- | --- |
| `storage` | `permissions: ["storage", ...]` | The service worker stores unsigned per-field session event logs in `chrome.storage.local` (`pmbah:sessions:v1`) until the user signs and uploads them, discards them, or the 3-day TTL sweeps them. Storage holds only content-blind numeric event records and observation state (`observed_session_id`, bearer `token`, commitments — never text). |
| `clipboardWrite` | `permissions: [..., "clipboardWrite", ...]` | After a successful sign+upload, the popup copies the returned short record URL to the user's clipboard so they can paste it where they want to share it. No other clipboard write occurs. |
| `alarms` | `permissions: [..., "alarms"]` | The service worker registers a single repeating alarm (`pmbah-ttl-sweep`, every 60 minutes) that runs the local 3-day TTL sweep over unsigned sessions. No other alarm is registered. |
| `host_permissions: ["<all_urls>"]` | top-level | Required for the content script to attach to textarea and plain text input fields on any page the user visits. This is the capture-all writer producer scope. The content script reads only what is needed transiently inside the `beforeinput` handler to compute codepoint-anchored numeric metadata and never retains text across event boundaries. Non-empty pre-existing fields are marked "not recording (existing content)" and produce no events. |
| `content_scripts.matches: ["<all_urls>"]`, `all_frames: true` | top-level | Same rationale as `host_permissions`. `all_frames: true` is required because composition surfaces (forum reply boxes, embedded editors) are frequently iframed; the content script must run inside the writer's actual frame. |
| Network access to the ingest service | implied by upload URL | Outbound HTTPS only to the configured `EXT_BASE_URL` (default `https://possiblymadebyahuman.com`), and only for two endpoints: `POST /api/records` at sign-time and `POST /api/observed-sessions/<id>/checkpoints` during a session. No other network access occurs. The extension does not request `webRequest`. |

Permissions intentionally **not** requested: `activeTab`, `scripting`, `tabs`,
`cookies`, `webRequest`, `downloads`, `notifications`, `nativeMessaging`,
`management`, `identity`, `bookmarks`, `history`. If a Chrome Web Store review
asks why broader access is not needed, the answer is that the capture-all
producer reads only what the content script needs inside a single
`beforeinput` handler scope and posts the resulting numeric event records over
`fetch` to one fixed origin.

## Draft store review notes

Use these notes to keep the submission aligned with PMBAH's product promise:

- The extension is a writing-record producer, not an AI detector.
- The extension must not claim to verify, certify, or score human authorship.
- The privacy policy and listing must state that public uploads are
  content-blind by default.
- The final listing must describe when capture is active and what user action
  triggers upload.
- Permission justifications must be concrete and match the final manifest.
- The submitted zip must not contain source maps, secrets, real `.env` files, or
  development-only artifacts unless deliberately approved for review.

## Release-readiness summary at frontend tip `35799f3`

Code-side work is complete. The remaining steps are all human-owned account /
listing / artwork / submission actions.

**Implementation done** (verified at frontend `35799f3`):

- `.7` browser extension landed (`fe6edf8` + amendment `2a44c93`): per-field
  session identity via producer-core, beforeinput-driven content-blind
  capture with no retained text snapshots, INELIGIBLE policy for non-empty
  pre-existing fields, server-observed checkpoint integration via the `.40`
  `CheckpointAdapter`, sign+upload flow with clipboard copy, per-session
  discard, 3-day TTL sweep via `chrome.alarms`.
- `.17` packaging contract holds: `make extension-build` and
  `make extension-package` produce a deterministic zip; `EXT_BASE_URL`
  overrides the ingest origin at build time.
- Static + runtime safeguards: producer-core source audit, service-worker
  bundle DOM/text-read canary, popup bundle DOM-read canary, all-bundles
  kernel-symbol canary, retained-text identifier canary on
  `apps/browser-extension/src/content/capture.ts`, FieldEntry struct canary.
  Copy audit walks `apps/browser-extension/README.md` and the popup HTML/TS.
- Manifest fields match the justification table above exactly. MV3,
  `permissions: ["storage", "clipboardWrite", "alarms"]`,
  `host_permissions: ["<all_urls>"]`, content scripts at `document_idle`
  with `all_frames: true`.

**Artifact metrics** (frontend `35799f3`, default `EXT_BASE_URL`,
`extension-package`):

| Field | Value |
| --- | --- |
| Path | `apps/browser-extension/dist/possiblymadebyahuman-extension-0.1.0.zip` |
| Size | 47169 bytes (~46 KB) — far below the Chrome Web Store 50 MB per-package limit |
| Entries | 8 — `manifest.json`, `service-worker.js`, `content.js`, `popup.html`, `popup.js`, `icons/16.png`, `icons/48.png`, `icons/128.png` |
| SHA-256 | `475e2b78966659d763bfc1649ee2da2dc6d4783290174cd8bb85fd223452c743` (stable across rebuilds with the same `EXT_BASE_URL`) |
| Bundle sizes (uncompressed) | service-worker.js 32227 B, content.js 6615 B, popup.js 3297 B, popup.html 3015 B, manifest.json 688 B |
| Icons (placeholders, see human input below) | 16.png 82 B, 48.png 125 B, 128.png 300 B — solid-colour PNGs generated by `scripts/build.mjs`; must be replaced with approved artwork before submission |
| Forbidden entries | none — no source maps, no `.ts`, no `.env*`, no `.dev*` (enforced by `scripts/package.mjs` and `tests/browser-extension-package.test.mjs`) |
| Determinism | confirmed by `tests/browser-extension-package.test.mjs` and by manual hash comparison across two rebuilds |

**Bundles cannot be reached at this frontend tip from a real Chrome instance
because no Chrome/Chromium is available in this environment.** The agent
producing this gate cannot itself sideload, take screenshots, or submit. The
manual checklist already in `apps/browser-extension/README.md#manual-testing`
remains the authoritative walk-through for the human or reviewer once an
install path exists.

## Human-input blocker packet for `.26`

Each item below is a precise input required before the Chrome Web Store
listing can be created, submitted, or approved. Items are ordered so that
each unlocks the next.

1. **Chrome Web Store Developer account access (Juan).**
   - Confirm or create the publisher account that will own the extension.
   - Complete the one-time developer registration payment (currently a flat
     fee paid to Google) and any identity / tax / organization verification
     Google currently requires.
   - Record the publisher account holder (one human is sufficient; multi-admin
     is optional) here once chosen:
     > Publisher account holder: **TBD by Juan**.

2. **Listing visibility decision (Juan).**
   - Public listing (discoverable in store search) vs. unlisted (install only
     via direct link). The release policy in `docs/browser-extension-release.md`
     allows either for v0.
   - Record the decision here once made:
     > Listing visibility: **TBD by Juan — public or unlisted**.

3. **Approved icon artwork (Juan + reviewer).**
   - The placeholder icons in the package (`icons/16.png`, `icons/48.png`,
     `icons/128.png`) are solid-colour PNGs generated by the build script for
     package-shape validation. They must be replaced with approved artwork —
     the obvious source is the pencil figure from the home page
     (`apps/site/static/images/pmbah-figure-1200.jpg`) cropped tight around
     the figure's head and sheet.
   - Required sizes per current Chrome Web Store policy: 128 (listing tile),
     and the in-product 16 / 48 / 128 set already in the manifest.
   - Drop the approved PNGs into `apps/browser-extension/icons/` (or replace
     the build script's `makePng` placeholder generator with reads from a
     real source set). After replacement, rebuild and confirm the SHA-256
     above changes — this is expected and indicates the new icons shipped.
   - Record the icon source-of-truth path here once provided:
     > Icon source: **TBD by Juan**.

4. **Screenshots for the listing (Juan after sideload).**
   - Chrome Web Store currently requires at least one 1280×800 or 640×400
     screenshot. Recommended: three or four.
   - Suggested set (all using real extension UI, no mockups):
     - The per-field `recording` badge on a textarea on a familiar site.
     - The popup with two sessions across two origins (multi-session shot).
     - The popup right after a successful sign+upload, showing the
       `short_signature` link.
     - The badge reading `not recording (existing content)` on a textarea
       that already had a draft, to illustrate the eligibility rule.
   - Record the screenshot bundle location here once captured:
     > Screenshots: **TBD by Juan**.

5. **Support contact + support URL (Juan).**
   - The Chrome Web Store listing requires a support contact. The obvious
     choice for v0 is the GitHub repo's issues page; record the canonical
     URL once decided:
     > Support URL: **TBD by Juan** (recommended: GitHub issues on the
     > `juanre/possiblymadebyahuman` repo).

6. **Privacy policy URL (Juan).**
   - Chrome Web Store requires a hosted privacy policy URL. The docs site
     already explains the content-blind guarantees at `/docs/privacy/`. The
     simplest v0 answer is to use that URL once the site domain is live.
   - Record the privacy policy URL here once approved:
     > Privacy policy URL: **TBD by Juan** (recommended:
     > `https://possiblymadebyahuman.com/docs/privacy/`).

7. **Listing copy approval (Juan).**
   - The "Draft short description", "Draft detailed description", and the
     privacy/data-use answers in this document are reconciled with the
     shipped extension. Juan should read them and either approve verbatim or
     edit before paste into the Chrome Web Store form.
   - Record approval here once given:
     > Listing copy approval: **TBD by Juan**.

8. **Sideload manual walkthrough (Juan or human reviewer).**
   - Load `apps/browser-extension/dist/` as an unpacked extension in Chrome
     (Developer mode → Load unpacked), then walk through every item in the
     "Manual testing" section of `apps/browser-extension/README.md`. The
     checklist is enumerated there: textarea capture, contenteditable
     degraded capture, multi-field multi-site session isolation, INELIGIBLE
     pre-existing content, idle-gap preservation, failed-upload Discard
     path, and content-blind network-payload inspection in DevTools.
   - Record sideload evidence (screenshots, brief notes per item) and any
     blockers found before submission. Sideload outcome:
     > Sideload checklist outcome: **TBD by Juan / human reviewer**.

9. **Listing submission (Juan).**
   - After items 1–8 are green, Juan signs in to the Chrome Web Store
     Developer Dashboard, creates the extension item, uploads
     `apps/browser-extension/dist/possiblymadebyahuman-extension-<version>.zip`
     (or the equivalent zip from a CI artifact at the release tag), pastes
     the reconciled listing copy and privacy/data-use answers from this
     document, attaches the approved icons and screenshots, and submits for
     review.
   - Record submission timestamp + assigned extension ID here once the
     dashboard accepts the upload:
     > Submission timestamp: **TBD**. Extension ID: `TBD until the
     > Chrome Web Store dashboard assigns one`.

10. **Review outcome + real install URL (Juan).**
    - Chrome Web Store review currently takes hours to days. Any rejection
      details should be tracked here for amendment. On approval:
      > Chrome Web Store listing URL: `TBD until the listing is published`.
    - Only after the listing URL is real and approved should the site
      home/docs/README link to it. The current home page is deliberately
      silent on installation — leave it silent until a real URL exists.

## What this document is NOT

- It is not a script or automation that can be run by a tool. Every item
  above either requires a Google account session or human judgement.
- It is not a substitute for reading
  `apps/browser-extension/README.md#manual-testing`. The README is the
  authoritative sideload walkthrough.
- It does not record any Chrome Web Store credentials, OAuth tokens, or
  publisher account secrets. None should ever be committed to this
  repository. Automation, if introduced later, must follow the
  `docs/browser-extension-release.md` policy on token rotation and
  upload-only credentials.

## Dependencies already resolved

- `default-aaaa.7` browser extension behaviour, permissions, manifest, local
  retention/TTL, capture UI, sign+upload flow — landed and reviewed.
- `default-aaaa.17` deterministic store zip, package command, versioning,
  release artifact wiring — landed and reviewed.

## Dependencies still open

- `.26` items 1–10 above (this list).
- `.9` end-to-end ship gate consumes the outcome of `.26` and is the next
  milestone after Juan submits and the listing is approved.
