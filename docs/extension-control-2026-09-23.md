# Extension control follow-up — 23 September 2026

The installed 0.1.1 extension displayed a non-interactive “recording” label that
was positioned once against the page. Moving or minimizing a Gmail compose
window could leave the label behind.

Version 0.1.2 replaces it with the agreed “PMBAH · writing record ↗” control.
It follows field geometry, hides when the editor is hidden or scrolled out of
view, and is removed when the field leaves the DOM. Restoring the same field
restores the control without creating another session. Geometry tracking stops
when no controls remain; it does not inspect document text.

Clicking the control opens Chrome's existing extension popup. It neither signs
nor uploads the record. Mouse activation preserves the editor's text selection
for optional binding; keyboard activation is also supported. Opening the popup
uses `chrome.action.openPopup` (Chrome 127+ for ordinary installations), with a
visible toolbar-menu instruction if the API is unavailable or rejects. The
worker returns only an acknowledgement, never session data, to this request.
No new permissions are requested.

The panel explains edit metadata and checkpoint traffic, and its empty state
explains that tabs open before installation need reloading. The capture policy,
shared-document session identity, and content-blind record format are unchanged.

Validation: 282 checks passed with no failures or skips. Browser coverage includes
ancestor movement, resizing, minimize/restore, removal/reinsertion, nested scroll
clipping, mouse and keyboard activation, fallback instructions, and opening the
actual installed extension popup with a text selection. All 60 browser cases passed with no skips against the production container.
The container gate also exercises sign/upload and continuation against disposable Postgres.
This reproduces the layout behavior in controlled browser fixtures; it is not a
claim of testing inside the user's authenticated Gmail session.

To update a sideloaded copy, extract `possiblymadebyahuman-extension-0.1.2.zip`
into the same directory previously loaded in Chrome. Use Reload on that
extension's card at `chrome://extensions`, confirm version 0.1.2, then reload
Gmail or other already-open pages. Updating the original directory retains the
extension identity and its local sessions.
