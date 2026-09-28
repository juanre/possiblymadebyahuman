# Browser extension release packaging and store plan

This document covers how the extension is built, packaged and released. Store
submission facts (permissions, data use, package checksum) are in
[`docs/chrome-web-store-prep.md`](chrome-web-store-prep.md); paste-ready listing
copy and the submission checklist are in
[`docs/chrome-web-store-listing.md`](chrome-web-store-listing.md).

The extension is published at <https://chromewebstore.google.com/detail/possiblymadebyahuman/akodlnlfkdoiobdcghmbhhoafokmldoh>; link that listing for installation.
Do not commit store credentials, OAuth tokens, refresh tokens, real publisher
account details, `.env*` files, source maps, or local build outputs.

## Artifact contract

| Field | Value |
| --- | --- |
| Build command | `npm --workspace @possiblymadebyahuman/browser-extension run build` or `make extension-build` |
| Package command | `npm --workspace @possiblymadebyahuman/browser-extension run package` or `make extension-package` |
| Build output directory | `apps/browser-extension/dist/` |
| Package output | `apps/browser-extension/dist/possiblymadebyahuman-extension-<version>.zip` |
| Version source | `apps/browser-extension/package.json` `version` (currently `0.4.0`) |
| Manifest source | `apps/browser-extension/manifest.template.json`, with version injected at build time |
| Bundler | `esbuild`, minified, targeting Chrome 120 |
| Upload base URL | `EXT_BASE_URL`, defaulting to `https://possiblymadebyahuman.com`, normalized before appending `/api/records` |

The package command rebuilds the extension and writes a deterministic ZIP with
fixed entry timestamps. The package must not include source maps, TypeScript
source files, local env files, secrets, or remote executable code.

The zip contains exactly these entries (enforced by
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

`scripts/build.mjs` copies the icons from `apps/browser-extension/icons/`
(the PMBAH infinity mark, generated from `apps/site/static/icon-512.png`) and
`favicon.svg` from the site's static files.

## Local build and package

From the repository root:

```bash
npm ci
make extension-package
unzip -l apps/browser-extension/dist/possiblymadebyahuman-extension-<version>.zip
shasum -a 256 apps/browser-extension/dist/possiblymadebyahuman-extension-<version>.zip
```

To point a local or staging package at a different API origin:

```bash
EXT_BASE_URL=http://localhost:8787 make extension-package
```

`EXT_BASE_URL` is a build-time value. The builder strips query strings and
fragments and removes a trailing slash before the extension appends
`/api/records`. Store uploads must use the default.

## Release workflow

`.github/workflows/release-image.yml` runs for pushed `v*` tags. After the
reusable checks pass (including the installed extension against a disposable
production image and Postgres), its `extension-package` job runs
`make extension-package`, and the `release-downloads` job attaches the zip to
the GitHub Release for that tag. Tags with a suffix such as `v0.3.3-rc.1` create
prereleases.

The workflow never submits to a browser store. The attached zip is the file to
upload to the Chrome Web Store; compare its SHA-256 with a local
`make extension-package` of the same tag first.

## Versioning

- A release tag `vX.Y.Z` corresponds to the extension package version it ships.
- The build injects that version into `manifest.json`.
- Every Chrome Web Store upload for the same extension ID must carry a higher
  version than the previous upload.
- The store listing's title and summary come from the manifest `name` and
  `description`, so changing them requires a new version.

## Store screenshots

`apps/browser-extension/store-assets/` holds the listing icon
(`chrome-web-store-icon-128.png`), the small promo tile
(`promo-tile-440x280.png`) and five 1280x800 screenshots under `screenshots/`.
Regenerate them with:

```bash
npm ci
npx playwright install chromium
node scripts/store-screenshots.mjs
```

The script builds the extension against a local ingest service backed by an
in-memory store on port 4730 (`PMBAH_SCREENSHOT_PORT` changes it), records a
reply on a fictional blog page, publishes it, and captures the side panel next
to the page plus the resulting record page. Headless Chromium cannot draw
Chrome's side panel, so each of the first three images places a screenshot of
the page and one of the real panel document side by side. Nothing is sent to
production. Review every image after regenerating.

## Chrome Web Store manual publishing path

Chrome/Chromium through the Chrome Web Store is the public distribution target.
Follow the checklist in
[`docs/chrome-web-store-listing.md`](chrome-web-store-listing.md#submission-checklist).
In short: a human publisher uploads the release zip in the Developer Dashboard,
fills the listing and privacy tabs from the prepared text, and submits for
review. Record the assigned extension ID and listing URL in
`docs/chrome-web-store-prep.md`, and link the store from the site only after the
listing is live.

Do not use a fake Chrome Web Store URL, a placeholder install page, or "coming
soon" install copy.

## Optional Chrome Web Store API automation

Automation must not be enabled without Juan's approval. Likely secrets, subject
to the current Chrome Web Store API requirements:

- `CHROME_EXTENSION_ID`
- `CHROME_CLIENT_ID`
- `CHROME_CLIENT_SECRET`
- `CHROME_REFRESH_TOKEN` or current equivalent

Prefer upload-only automation first. Publishing to users should remain a
separate human-approved step unless auto-publish is explicitly approved.

## Edge Add-ons path

Edge is not a release gate. Edge can install extensions from the Chrome Web
Store, so test the store build there first and document the result. A separate
Edge Add-ons listing would need Microsoft Partner Center access, listing assets
and privacy answers adapted from the Chrome listing, and its own extension ID.

## Firefox AMO path

Firefox is not supported by this package: it relies on `chrome.sidePanel` and a
module service worker. Supporting Firefox would need a sidebar-based variant and
testing with `web-ext`. AMO signing credentials such as `WEB_EXT_API_KEY` and
`WEB_EXT_API_SECRET` would be human-owned and never committed.

## Safari

Safari/App Store distribution is out of scope unless explicitly approved later.
