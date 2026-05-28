# Browser extension release packaging and store plan

Status: packaging/release scaffold for `default-aaaa.17`. Shared browser
producer core is owned by `default-aaaa.29`; extension behavior is owned by
`default-aaaa.7`; final store submission and the real Chrome Web Store URL are
owned by `default-aaaa.26`.

Do not publish install links until Chrome Web Store approval produces a real URL.
Do not commit store credentials, OAuth tokens, refresh tokens, real publisher
account details, `.env*` files, source maps, or local build outputs.

## Artifact contract

The provisional v0 Chrome/Chromium artifact contract is:

| Field | Value |
| --- | --- |
| Build command | `npm --workspace @possiblymadebyahuman/browser-extension run build` or `make extension-build` |
| Package command | `npm --workspace @possiblymadebyahuman/browser-extension run package` or `make extension-package` |
| Build output directory | `apps/browser-extension/dist/` |
| Package output | `apps/browser-extension/dist/possiblymadebyahuman-extension-<version>.zip` |
| Version source | `apps/browser-extension/package.json` `version` |
| Manifest source | `apps/browser-extension/manifest.template.json`, with version injected at build time |
| Bundler | `esbuild` |
| Upload base URL | `EXT_BASE_URL`, defaulting to `https://possiblymadebyahuman.com`, normalized before appending `/api/records` |

The package command rebuilds the extension and writes a deterministic ZIP with
fixed ZIP entry timestamps. The v0 package must not include source maps,
TypeScript source files, local env files, secrets, or remote executable code.

Current scaffold entries are intentionally minimal until `default-aaaa.7` lands:

```text
manifest.json
service-worker.js
content.js
popup.html
popup.js
icons/16.png
icons/48.png
icons/128.png
```

The icon files are generated build placeholders for package-shape validation.
Human-approved pencil-figure-derived icons must replace or supersede them before
Chrome Web Store submission.

## Local build and package

From the repository root:

```bash
npm install
make extension-package
unzip -l apps/browser-extension/dist/possiblymadebyahuman-extension-0.1.0.zip
```

To point a local/staging package at a different API origin:

```bash
EXT_BASE_URL=http://localhost:8787 make extension-package
```

`EXT_BASE_URL` is a build-time value. The builder strips query strings and
fragments and removes a trailing slash before the extension appends
`/api/records`.

## Release workflow

`.github/workflows/release-image.yml` now includes an `extension-package` job for
pushed `v*` tags. It:

1. checks out the repository;
2. installs npm dependencies with `npm ci`;
3. runs `make extension-package`;
4. uploads `apps/browser-extension/dist/possiblymadebyahuman-extension-*.zip` as
   a GitHub Actions artifact.

The job does not submit to any browser store. Store publication remains a manual
or separately approved process because it requires human-owned accounts,
listing approval, privacy disclosures, and credentials.

## Versioning

For the scaffold, the extension version comes from
`apps/browser-extension/package.json`. Before release, reconcile it with the
human-approved repository tag:

- release tag `v0.1.0` should correspond to extension package version `0.1.0`;
- the build injects that package version into `manifest.json`;
- Chrome Web Store uploads must use a version greater than any previously
  uploaded package for the same extension ID.

A future release-hardening step may add an explicit tag/version check before
`ship-tag` if the extension begins versioning independently.

## Chrome Web Store manual publishing path

Chrome/Chromium through the Chrome Web Store is required for public v0.

Manual v0 flow:

1. Human confirms the Chrome Web Store Developer account and publisher access.
2. Human approves public vs unlisted listing visibility.
3. Run `make extension-package` from the reviewed release commit/tag.
4. Human opens the Chrome Web Store Developer Dashboard.
5. Create or update the PMBAH extension item.
6. Upload the generated zip.
7. Fill listing, support, privacy, data-use, and permission-justification fields
   using `docs/chrome-web-store-prep.md`, reconciled with the final manifest and
   final `default-aaaa.7` behavior.
8. Add required screenshots/icons/promotional assets approved by the human.
9. Submit for review after explicit human approval.
10. Record the assigned extension ID and real Chrome Web Store listing URL in the
    release handoff and site/docs only after the listing exists.

Do not use a fake Chrome Web Store URL, a placeholder install page, or "coming
soon" install copy for release.

## Optional Chrome Web Store API automation

Automation is future/optional and must not be enabled without human approval.
Likely secrets, subject to the current Chrome Web Store API requirements:

- `CHROME_EXTENSION_ID`
- `CHROME_CLIENT_ID`
- `CHROME_CLIENT_SECRET`
- `CHROME_REFRESH_TOKEN` or current equivalent

If automation is added later, prefer upload-only automation first. Publishing to
users should remain a separate human-approved step unless the human explicitly
approves auto-publish.

## Edge Add-ons path

Edge is not the v0 gate. After Chrome support works, assess whether the same MV3
zip can be submitted to Edge Add-ons.

Human/account needs if pursued:

- Microsoft Partner Center / Edge Add-ons developer access;
- listing assets and privacy answers adapted from the Chrome listing;
- Edge-specific extension ID and listing URL;
- optional API credentials only if automation is approved.

If the Chrome Web Store extension installs and behaves correctly in Edge via the
Chrome Web Store compatibility path, document that as compatibility evidence; a
separate Edge Add-ons listing can remain a follow-up.

## Firefox AMO path

Firefox is not the v0 gate. After `default-aaaa.7`, test whether the MV3 package
and `chrome.*` APIs are compatible with current Firefox extension support.

Possible outcomes:

- If the package works by sideloading with no material changes, document the
  evidence and consider a follow-up AMO package using `web-ext`.
- If APIs or MV3 behavior diverge materially, document the blocker and create a
  follow-up rather than blocking Chrome v0.

AMO automation, if ever approved, would require human-owned AMO access plus
`web-ext` signing credentials such as `WEB_EXT_API_KEY` and
`WEB_EXT_API_SECRET`. Do not commit those values.

## Safari

Safari/App Store distribution is out of scope for v0 unless explicitly approved
later.

## Reconciliation required after `default-aaaa.7`

Before store submission or release blessing, revisit this document and the
package scripts against the final shared browser producer core and browser
extension implementation:

- final shared producer-core package/module entry points from `default-aaaa.29`;
- final manifest permissions and host permissions;
- final ZIP contents and entry names;
- final local retention/TTL behavior;
- final source-attribution and capability claims;
- final icons/screenshots and listing assets;
- final support matrix for Chrome, Brave, Edge, and Firefox;
- final privacy/data-use answers.
