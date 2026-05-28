# Chrome Web Store prep for v0 browser extension

Status: draft preparation material for `default-aaaa.27`. This document does **not**
mean the extension is listed, approved, or installable. Do not publish an install
link until `default-aaaa.26` records the real Chrome Web Store URL and human
approval.

This checklist is intentionally human/store-facing. It prepares the Chrome Web
Store publication path without touching browser-extension implementation details.
Final text, permissions, screenshots, and privacy answers must be reconciled with
the completed extension from `default-aaaa.7` and the packaging/release plan in
`docs/browser-extension-release.md` from `default-aaaa.17`.

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

Create content-blind records of selected browser writing sessions and share a
hash-addressed editing-process replay.

### Draft detailed description

PossiblyMadeByAHuman records the shape of a writing process without uploading the
words you wrote.

When you enable the extension for a supported editable field, it observes local
buffer mutations such as insertions, deletions, replacements, timing, and coarse
source information when the browser makes that available. Nothing is uploaded
while you write.

When you choose to sign and upload a session, the extension builds a public
content-blind writing record: event positions and lengths, timing, metadata you
review, final text length, and cryptographic hashes. The public service stores
that record and returns a short URL you can share.

Public records do not contain your document plaintext or per-event inserted text.
Capture context such as page title or URL is shown before upload so you can omit
or redact identifying metadata.

This is not a human/AI detector. It does not decide who wrote something, assign a
confidence score, or certify authorship. It gives readers a replayable record of
an editing session's structure and makes large pastes or atomic insertions
visible as process facts.

### Draft support text

For setup, privacy model, and troubleshooting, see the public PMBAH docs at the
approved support URL. Report extension issues through the repository issue
tracker or the support contact selected by the human publisher.

## Draft privacy and data-use disclosure answers

These answers must be reviewed against the final Chrome Web Store privacy form
and final extension behavior.

### Data observed locally

- Text-field or contenteditable buffer contents while capture is enabled or while
  the selected supported editable surface is being recorded.
- Buffer mutation structure: positions, inserted/deleted lengths, operation type,
  timestamps, and source attribution when available.
- Page metadata selected for capture context, such as URL, page title, field kind,
  and extension/session identifiers.

### Data stored or processed locally before upload

- Unsigned session event logs and local replay material needed to compute final
  hashes and preview the record.
- Document plaintext exists in the browser's editable field and may be processed
  transiently in memory for hashing/reconstruction before upload. Persistent
  unsigned extension storage should remain content-blind unless `default-aaaa.7`
  explicitly documents and justifies a different local-only behavior.
- Local retention/TTL: `TBD by default-aaaa.7`; expected intent is short-lived
  unsigned capture storage with user-visible discard/clear behavior.

### Data transmitted on explicit sign/upload

- Content-blind PMBAH record manifest and event log.
- Final text hash and final text length.
- Record hash-chain data derived from mutation events.
- Capture context that the user reviews and accepts, for example sanitized page
  URL/title or field kind.
- No account identity is required by the PMBAH v0 public service.

### Data not transmitted by the public/default extension

- Document plaintext.
- Per-event inserted plaintext.
- Absolute local file paths.
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

## Draft permission-justification template

Final permissions are `TBD by default-aaaa.7`. Do not paste this into the store
unchanged; remove permissions not present in the final manifest and replace all
TBDs with exact behavior.

| Permission or host access | Status | Draft justification |
| --- | --- | --- |
| `storage` | TBD by `.7` | Used to keep local unsigned capture session state, user settings, and short-lived records until the user signs/uploads or discards them. Plaintext is not uploaded. Local retention behavior must match the final TTL. |
| `activeTab` | TBD by `.7` | If used, limits capture/setup actions to the current user-invoked tab instead of broad always-on access. Replace with exact UI trigger and access duration. |
| `scripting` | TBD by `.7` | If used, injects the content capturer into user-selected pages or supported editable surfaces. Explain why static content scripts are insufficient if this remains. |
| Content scripts / `host_permissions` | TBD by `.7` | Needed only on pages where the extension can observe supported editable fields/contenteditable surfaces. Use the narrowest feasible match pattern and describe user controls. |
| `clipboardWrite` | TBD by `.7` | If used, copies the returned PMBAH short URL after explicit sign/upload. Do not request if the implementation uses another copy flow. |
| Network access to PMBAH API | TBD by `.7` | Used only when the user explicitly signs/uploads a content-blind record to the configured ingest API. Document the exact endpoint/origin. |
| `alarms` or background scheduling | TBD by `.7` | If used, enforces local unsigned-capture TTL or cleanup. State retention interval and user-visible behavior. |
| `tabs` | TBD by `.7` | Avoid unless final implementation needs tab URL/title beyond what narrower APIs provide. If used, explain capture-context preview/redaction. |

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

## Unresolved human inputs for `default-aaaa.26`

- Chrome Web Store publisher account owner and access path.
- Public vs unlisted v0 listing decision.
- Approved extension name and branding.
- Approved icon/source artwork and screenshot plan.
- Support contact and support URL.
- Privacy policy URL to use in the listing.
- Final listing copy approval.
- Final data-use answers after `.7` defines exact behavior.
- Final permission justifications after `.7` defines the manifest.
- Store-ready zip from `.17` and final artifact review.
- Human approval to submit the listing.
- Approved extension ID and real Chrome Web Store URL after listing creation.

## Dependencies to reconcile before submission

- `default-aaaa.7`: final browser extension behavior, permissions, manifest,
  local retention/TTL, capture UI, and upload flow.
- `default-aaaa.17`: deterministic store zip, package command, versioning, and
  release artifact wiring.
- `default-aaaa.26`: human account/listing approval, submission, review outcome,
  extension ID, and real install URL.
