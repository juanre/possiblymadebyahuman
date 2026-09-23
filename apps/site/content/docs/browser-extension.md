---
title: "Use the browser extension"
summary: "Choose one editor, start a writing record, and finish with a shareable link."
group: "Write a record"
weight: 3
---

These instructions apply to extension **0.2.1**. Versions before 0.2.0 captured fields automatically; 0.2.0 lacks the durable-draft and Resume behavior below. Replace older packages before following this guide. Chrome Web Store availability is not yet confirmed. Reviewed developer-mode ZIP packages are distributed through [GitHub releases](https://github.com/juanre/possiblymadebyahuman/releases); check the package version before installing.

## Start only where you choose

Use Chrome 120 or newer. Extract the ZIP. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked** on the extracted directory. Pin PMBAH in Chrome's toolbar, then reload any page that was already open.

To update an existing unpacked installation, replace its files in the same directory and choose **Reload** on its `chrome://extensions` card. Keep only one enabled PMBAH installation; adding a second extension does not stop the old version. Reload Gmail and other already-open pages after the update.

Right-click an **empty editor** and choose **Start writing record**. You can also focus the editor and use **Alt+Shift+W**, or open PMBAH from the toolbar and choose **Start in focused editor**. Shortcuts are configurable at `chrome://extensions/shortcuts`.

Opening the panel does not start anything. Other fields remain inactive. In an email, start in the message body; the recipient and subject fields are separate. The panel shows your active draft and editing-event count. Nothing is placed over your writing.

Write normally. Supported rich-text editors measure Unicode characters, including line breaks; ambiguous browser edits are reported as unknown measurements. Checkpoints send event counts and chain commitments while an explicitly chosen draft is active. Your words are not stored or uploaded. See [privacy details](/docs/privacy/).

## Finish and share

Choose **Finish & get link** in the panel. Review the page URL, title, and label, removing identifying metadata if appropriate. Choose **Let readers check a copy of this text** to include a check of selected text, or the whole field if nothing is selected. A commitment lets readers check candidate wording; it is not encryption or proof of authorship.

Confirm to stop capture and publish. The result shows a complete link, **Open record**, and **Copy link**. Copying happens only when you choose it. If copying fails, select the visible URL and copy it yourself.

If binding fails, the panel does not silently publish without it. Cancel or separately choose a process-only record. The stopped editor is not read again to create a different commitment. A failed upload can retry the frozen record. Canceling after capture has stopped leaves the draft stopped.

## Stop, switch tabs, or reload

**Stop** pauses capture and keeps the unfinished draft. It does not upload or compute a text commitment. To return later—even after months—click its field, select the draft in the panel and choose **Resume in chosen field**. The field may already contain text; resumption is restricted to the same site. The extension keeps the original session and timeline instead of guessing which document a similar-looking field belongs to.

The next captured edit includes the time away. Edits made while capture was stopped are not added retroactively, so the record may no longer support a document-length curve. Returning only to publish does not extend the timeline past its last captured edit. If you finish immediately after resuming without another captured edit, you can publish the earlier editing activity, but cannot attach a check of the current field text. To include it, resume again and make an edit before finishing.

Drafts and saved links have no automatic expiry. **Discard local draft** removes local events; removing a saved reference does not delete the public record. Browser-data clearing or uninstall can remove local history. The website must preserve your text: PMBAH stores only editing measurements. Published records stay immutable and cannot be resumed in place.

Reloading, navigating to a new page document, and finishing end capture authorization. Typing afterward does not start a new session. To start a new independent record, use an empty editor.

If two editors show the same document, select its active draft in the panel and explicitly choose to **share its writing record** before starting in the second editor. Use this only for the same document. A session spanning several editors can publish editing activity only, without choosing one editor’s wording for a commitment. The extension does not guess that similar fields are related.

Authenticated Gmail and other complex sites still need acceptance testing with this version. Report a problem through [GitHub issues](https://github.com/juanre/possiblymadebyahuman/issues), including the extension version and the action that failed; do not post private writing.
