# Browser extension

The extension creates content-blind writing records **only for editors you explicitly start**. Opening a page, focusing a field, typing, or opening the side panel does not start capture. No controls are placed over webpage content.

## Use it

1. Install the reviewed ZIP by extracting it, opening `chrome://extensions`, enabling Developer mode, and choosing **Load unpacked** on the extracted directory. Pin PMBAH for convenient access. Reload already-open pages after installing or updating.
   To update an existing unpacked installation, replace the files in its existing directory and click **Reload** on its card at `chrome://extensions`. Keep only one enabled PMBAH installation: loading another directory as a second extension can leave the old passive-capture version running.
2. Right-click an **empty editor** and choose **Start writing record**. Alternatively, focus it and press **Alt+Shift+W**, or open PMBAH's toolbar side panel and choose **Start in focused editor**. Chrome extension shortcuts can be changed at `chrome://extensions/shortcuts`.
3. Write in that editor. Other fields remain inactive. The side panel shows the active draft and event count. The extension records edit times, positions, lengths, and sources where measurable; it does not retain your words.
4. Choose **Finish & get link**, review the page URL, title and label, and choose whether to include a wording commitment. Confirm to stop capture and publish. Finishing freezes the chosen draft before computing its binding and uploading it.
5. The saved result shows the complete URL, **Open record**, and **Copy link**. Copying is an explicit action. If clipboard access fails, the selectable URL remains available. Further edits are not captured automatically.

**Stop** keeps the local draft available to finish; it does not upload it or compute a wording commitment. Finishing that stopped draft can publish its editing activity only. **Discard local draft** removes its local events. A stopped editor must be cleared before a new independent record can start. Reloading or navigating to a new page document stops capture; saved local drafts remain available for review. Old drafts from the passive-capture version never activate a page by themselves.

For the same document in another tab, select its active draft in the panel and explicitly choose **Share its writing record** before starting in the other editor. The extension does not infer that unrelated fields belong together. Shared sessions can publish editing activity only; they do not silently choose one editor’s wording for a binding. Both editors must represent the same document; independent copies that drift apart do not establish a single reliable document-length history.

If a wording commitment cannot be obtained, no upload occurs. The panel offers cancel or a separate choice to publish a process-only record. It does not read later edits to manufacture a replacement binding. Failed uploads retain the frozen record for retry. Canceling after capture has stopped leaves the draft stopped; it does not resume capture invisibly.

## Measurements and privacy

Plain inputs and supported rich-text editors use Unicode codepoint positions and lengths. Rich-text paragraph boundaries and line breaks are included in the local logical text model. Browser operations that cannot be measured reliably use explicit unknown values; they do not invent a length. Equal-size programmatic rewrites without browser input events cannot be detected from numeric snapshots alone. Older records remain unchanged and the viewer can show their editing activity even without a length curve.

Text may be read transiently inside a measurement or at binding time. Only numeric state survives between events. Binding computes a salted commitment to canonical letters and digits locally; it uploads no plaintext, but permits candidate-wording checks. Capture context can identify a document: review or omit it before publishing. See [the privacy model](../site/content/docs/privacy.md).

Checkpoints begin with edits in an explicitly active draft. They transmit chain tips and event counts, not words. Full records upload only on confirmation. Local sessions expire after three days without editing and are swept hourly; uploaded event logs are cleared after a short grace period while a small local reference retains the result URL until expiry. Removing a local reference does not delete a public record.

## Architecture and permissions

- `content/capture.ts` is dormant until a worker-authorized user action. It measures only enrolled editors and computes optional bindings locally. It has no network adapter.
- `background/service-worker.ts` owns authorization, exact tab/frame/document routes, sessions, checkpoints and uploads. Content scripts cannot invoke privileged panel controls or obtain checkpoint bearer tokens.
- `popup/popup.html` and `popup.ts` implement the browser side panel (the historical filename is retained). The toolbar opens that panel; it is not an overlay or a transient action popup.
- `packages/producer-core` supplies the numeric event kernel, storage and signing. Explicit starts bypass heuristic matching without changing other producers' matching behavior.

The manifest requests `storage`, `clipboardWrite`, `alarms`, `contextMenus`, `sidePanel`, and `webNavigation`. The latter enumerates frames to locate the focused editor and tracks navigation to retire capture routes. Broad host access and dormant content scripts in all frames retain the exact right-click target, including embedded editors. **Permission is not activation**: no field measurements, sessions, or checkpoints occur before an explicit start. Narrower `activeTab` injection would need a different cross-origin frame/target design; it is not claimed by this release. Permission justifications are in [store preparation](../../docs/chrome-web-store-prep.md).

## Build and test

```sh
make extension-build
make extension-package
npm run check
npm run build:web
npm run test:web-browser
make test-release-container
```

Build output is `apps/browser-extension/dist/`; the deterministic artifact is `possiblymadebyahuman-extension-<version>.zip`. Version comes from this package's `package.json`. `EXT_BASE_URL=http://localhost:8787 make extension-package` targets a local service; production is the default.

The production-container gate builds a disposable local service and database, loads the actual extension into Chromium, and checks explicit start → edit → bind → upload → open record. Never point automated test uploads at production. Focused tests cover activation authorization, numeric rich-text capture, panel errors, clipboard denial, event flushing, privacy boundaries, and deterministic packaging.

## Support and remaining manual acceptance

Chrome 120 or newer is the acceptance target (matching the bundled JavaScript target and side-panel APIs); other Chromium browsers are not independently verified. Firefox and Safari are not supported by this package. No Chrome Web Store approval or install URL is claimed.

Authenticated Gmail needs a human acceptance pass with the packaged version: start in an empty message body, leave recipient and subject fields inactive, type/edit/paste and use IME if relevant, finish with a selected-text binding, open/copy the result, and check the timeline. Repeat with a pop-out compose window, navigation, another tab, and a failed upload. Browser tests use controlled rich-text fixtures and do not establish Gmail compatibility by themselves.

See [release packaging](../../docs/browser-extension-release.md) and [UX-reset acceptance](../../docs/extension-ux-reset-handoff.md).
