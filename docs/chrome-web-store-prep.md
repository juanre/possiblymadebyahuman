# Chrome Web Store preparation

Status: the extension is published in the Chrome Web Store, where the store
shows version 0.3.3. The source is at **0.4.1** (tag `v0.4.1`); upload that
release's ZIP to the listing as an update.

This document holds the technical facts a store submission depends on: what the
package contains, its single purpose, the permission justifications, and what
data leaves the browser. Paste-ready listing copy, privacy-tab answers and the
step-by-step submission checklist are in
[`docs/chrome-web-store-listing.md`](chrome-web-store-listing.md). Every claim
below was checked against `apps/browser-extension/manifest.template.json`, the
built `dist/manifest.json`, `src/content/capture.ts`,
`src/background/service-worker.ts` and `src/lib/adapters.ts`. If any of those
change, recheck this document before the next upload.

## Release policy summary

- Chrome/Chromium through the Chrome Web Store is the public distribution
  target. Acceptable listing visibility: public or unlisted install link, chosen
  by Juan.
- No fake, placeholder, or "coming soon" install URL should appear on the
  homepage, docs or README. Link the store only after approval produces a real
  listing URL.
- Brave and Edge can be documented after testing. Firefox is not supported by
  this package. Safari is out of scope.
- Never commit Chrome Web Store credentials, publisher account details, OAuth
  tokens or refresh tokens.

## Listing identity

The published listing:

- Extension ID: `akodlnlfkdoiobdcghmbhhoafokmldoh`.
- Chrome Web Store listing URL: <https://chromewebstore.google.com/detail/possiblymadebyahuman/akodlnlfkdoiobdcghmbhhoafokmldoh>.
- Listing visibility: **TBD by Juan (public or unlisted)**.
- Publisher account holder: **TBD by Juan**.

## Package facts

Built from tag `v0.4.1` with the default `EXT_BASE_URL`
(`https://possiblymadebyahuman.com`) by `make extension-package`:

| Field | Value |
| --- | --- |
| File | `apps/browser-extension/dist/possiblymadebyahuman-extension-0.4.1.zip` |
| Size | 159398 bytes |
| SHA-256 | `fd9b9f177a14d947fb7251107977d6a52d7a316ddfea2f2657c58aeb6086e1c5` |
| Manifest | MV3, `name` `possiblymadebyahuman`, `version` `0.4.1`, `minimum_chrome_version` `120` |
| Store summary | The store takes it from the manifest `description`: "Content-blind writing records for text fields." |
| Bundling | esbuild, minified, no source maps, no legal comments. All code ships in the package; nothing is fetched and executed at runtime. |

The zip contains exactly these nine entries (enforced by
`tests/browser-extension-package.test.mjs`):

```text
content.js
favicon.svg
icons/128.png
icons/16.png
icons/48.png
manifest.json
popup.html
popup.js
service-worker.js
```

Compare the SHA-256 of the GitHub release asset with the value above before
uploading. The build is deterministic, so a mismatch means the asset was built
from a different commit or `EXT_BASE_URL`.

## Single purpose

Paste into the dashboard's single-purpose field:

> possiblymadebyahuman records how a piece of writing was edited in one text
> field the user explicitly chooses, as timings, positions and lengths of edits
> without the words, and publishes that record at a shareable link when the
> user confirms.

## Permission justifications

The manifest requests six API permissions, host access to `<all_urls>`, and a
content script matching `<all_urls>` in all frames. Chrome shows the install
warnings "Read and change all your data on all websites" and "Read your
browsing history" (from `webNavigation`).

Not requested: `activeTab`, `scripting`, `tabs`, `cookies`, `webRequest`,
`downloads`, `notifications`, `nativeMessaging`, `management`, `identity`,
`bookmarks` or `history`.

Paste each justification into the matching dashboard field.

**`storage`**

> Keeps the user's unfinished drafts and saved record links in
> chrome.storage.local: numeric edit events (time, position, length, input
> source), the site and page path of each draft so it can be resumed in the
> same field, private draft names, and the token that authenticates the draft's checkpoints
> with our service. Document text is never stored. Drafts and links stay until
> the user removes them.

**`clipboardWrite`**

> Copies a published record's link to the clipboard when the user clicks Copy
> link in the side panel. The extension never reads the clipboard.

**`alarms`**

> Runs an hourly cleanup that deletes the local edit events and checkpoint
> tokens of records that have already been published, keeping only the saved
> link.

**`contextMenus`**

> Adds a "Start writing record" item to the right-click menu of editable fields.
> This is one of the three ways the user starts recording a specific field.

**`sidePanel`**

> The extension's whole interface lives in Chrome's side panel: starting,
> stopping and finishing drafts, reviewing what will be published, and the saved
> links. Nothing is drawn over the web page.

**`webNavigation`**

> Used for two things. When the user starts from the keyboard shortcut or the
> side panel, getAllFrames lists the frames of the active tab so the extension
> can find the one frame whose editor has focus, including editors inside
> iframes. onCommitted tells the extension that a tab navigated, so recording in
> the old page stops. No browsing history is stored or sent.

**Host permission `<all_urls>` and the content script on `<all_urls>` with `all_frames: true`**

> Users write in text fields on any site: comment boxes, forums, webmail,
> document editors, often inside iframes from a different origin than the page.
> The extension cannot know in advance which site the user will write on, so
> its content script is present on every page and frame, and it stays dormant
> until the user starts a recording.
>
> While dormant, the script only remembers which editable element was last
> focused or right-clicked (a weak reference kept in memory, never sent
> anywhere) and answers the side panel's question "is an editor focused in this
> frame?" with yes or no, plus the draft id when that editor is already
> recording. It reads no text, creates no session and makes no network request.
>
> Recording starts only through an explicit user action on one field: the
> "Start writing record" context-menu item, the Alt+Shift+W shortcut, or the
> "Start in focused editor" button in the side panel. The service worker then
> issues a one-time grant bound to that tab, frame and document, and refuses to
> register a field without one. From then on the script measures edits in that
> single field only: numbers for timing, position and length. Other fields stay
> inactive. Reloading, navigating, Stop or Finish ends recording.
>
> activeTab is not sufficient. (1) activeTab grants access to the tab's
> top-level origin, while many editors live in cross-origin iframes. (2) The
> side-panel button, the side panel's view of the focused editor, and Resume in
> a field days later are not activeTab gestures, so none of them would have
> access. (3) The context-menu target must be the exact element the user
> right-clicked; a script injected after the click cannot tell which element
> that was, so a listener has to be present before the menu opens.
>
> The host permission also lets the service worker send checkpoints and the
> finished record to our own service at https://possiblymadebyahuman.com. The
> extension sends nothing to any other site.

If the dashboard field limits length, use this shorter version (under 1,000
characters):

> Users write in text fields on any site, often inside cross-origin iframes, so
> a dormant content script runs on every page and frame. Until the user starts
> a recording it only tracks which editable element was last focused or
> right-clicked, in memory; it reads no text and sends nothing. Recording
> starts only when the user picks one field via the context menu, Alt+Shift+W,
> or the side panel's Start button, and then measures only timing, positions
> and lengths of edits in that field. activeTab cannot cover cross-origin
> iframes, the side-panel start and resume actions, or identifying the exact
> right-clicked element. The host permission also lets the service worker send
> checkpoints and the finished record to https://possiblymadebyahuman.com, the
> only site it contacts.

## Remote code

Answer **No, I am not using remote code.** Every script is bundled in the zip.
The bundles contain no `eval` or `new Function`, and the only network calls are
`fetch` POSTs of JSON to the configured service.

## What leaves the browser

Verified against `src/lib/adapters.ts` and the service worker. The only
destination is the service origin compiled into the build
(`https://possiblymadebyahuman.com` for store packages).

1. **Checkpoints, while a chosen draft is recording.**
   `POST /api/observed-sessions/<observed_session_id>/checkpoints` with
   `{event_count, chain_tip, token?}`: a count of edits and a BLAKE3 hash of the
   numeric event sequence. The first edit triggers one immediately; after that,
   every 50 edits or every 60 seconds with new edits, never while idle. The
   service returns a bearer token that the extension keeps for the next
   checkpoint.
2. **The record, only after the user confirms Finish.**
   `POST /api/records`, or the chunked `/api/record-uploads` path for long
   records, carrying:
   - the numeric event log: per edit `seq`, `t`, `op`, `pos`, `del_len`,
     `ins_len`, `source`;
   - a manifest with the record hash, session id, producer
     (`browser-extension` and its version), event count, duration and signed
     finish time;
   - a text-binding commitment (`scheme`, `canonical_length`, salted
     `commitment`) over the selected text, or the whole field when nothing is
     selected. It is computed locally at finish. When the scope is unavailable
     the user can explicitly publish editing activity only, without it;
   - the checkpoint session id and token, so the service can attach its
     checkpoints to the record.

Never sent: document text, per-edit inserted text, per-edit hashes, the page
address or title, the site, field names, ids or labels from the page's markup,
private draft names, cookies, browsing history, or any identifier of the user
or device. Records carry no capture context. Extension versions up to 0.4.0
sent the page address, title, field kind and a public label; the service
discards those on arrival and has removed them from stored records.

Read locally: the content script reads the chosen field's text inside each
input event to measure it and discards it when the handler returns. At finish
it reads the selected text (or whole field) once to compute the commitment.
Only numbers and the commitment leave the content script.

Stored locally: drafts in `chrome.storage.local` and an IndexedDB event journal
in the extension's own origin; see the `storage` justification above.

## Review risks

- **Broad host access.** Expect an in-depth review and a longer queue. The
  justification above is written for it. A rejection for excessive permissions
  most likely cites this item.
- **Host permission scope.** `<all_urls>` in `host_permissions` is used for the
  content script and for the service worker's requests to our service, which
  sends no CORS headers. Narrowing `host_permissions` to
  `https://possiblymadebyahuman.com/*` while keeping the content-script match
  would not change the install warning, but it would read as less broad to a
  reviewer. That is a manifest change and needs a new release;
  `tests/browser-extension-package.test.mjs` and
  `tests/browser-extension-canary.test.mjs` pin the current value.
- **Name and summary come from the manifest.** The listing title is
  `possiblymadebyahuman` and the summary is the manifest description. Changing
  either means editing `manifest.template.json` and shipping a new version.
- **Privacy policy consistency.** The reviewer compares the privacy tab, the
  listing and the privacy page. The page at
  `https://possiblymadebyahuman.com/docs/privacy/` must be deployed with the
  current text before submitting.

## Optional future automation

Manual submission is the default. Automation needs Juan's approval and a
documented credential owner. Possible GitHub secrets, subject to the current
Chrome Web Store API: `CHROME_EXTENSION_ID`, `CHROME_CLIENT_ID`,
`CHROME_CLIENT_SECRET`, `CHROME_REFRESH_TOKEN`. Prefer upload-only automation,
keep publishing a separate human step, and document token rotation and
revocation first. Never commit token values.
