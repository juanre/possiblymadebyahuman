# browser extension

Chrome/Chromium Manifest V3 producer for PMBAH content-opaque writing records.

Implementation of capture behavior is owned by `default-aaaa.7`. The current
scaffold provides the release/package contract used by `default-aaaa.17` so the
store artifact shape can be reviewed before the full producer lands.

## Responsibility

- Passive local capture for text fields and contenteditable surfaces.
- Per-field session identity, field badge, popup, sign modal, local unsigned
  capture TTL, sign/freeze/upload/copy-link flow, local clear after upload, and
  capture-context review/redaction.
- Honest degraded-capture states when source attribution is uncertain.
- Chrome/Chromium MV3 package output for v0 distribution.

## Non-responsibility

- Backend storage.
- Record page presentation.
- Plaintext upload in the public deployment.
- Claiming typing when source attribution is unknown.
- Human/AI verdicts, scores, or badges.
- Store submission or real install URL publication.

## Build and package

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

The extension version comes from this package's `version` field and is injected
into the built `manifest.json`. `EXT_BASE_URL` can override the production API
origin at build time:

```bash
EXT_BASE_URL=http://localhost:8787 make extension-package
```

The package must not include source maps, TypeScript sources, `.env*` files,
secrets, or local dev artifacts.

## Store/release docs

- `docs/browser-extension-release.md` — build/package commands, release workflow,
  Chrome manual publication, Edge/Firefox status, and versioning.
- `docs/chrome-web-store-prep.md` — human publisher checklist plus draft listing,
  privacy, and permission text.

Do not publish a fake or placeholder install URL. The real Chrome Web Store URL
is recorded only after `default-aaaa.26` creates/approves an installable listing.
