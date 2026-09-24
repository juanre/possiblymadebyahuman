---
title: "Use the browser extension"
summary: "Choose an editor, keep a draft, and publish a writing record with a shareable link."
group: "Write a record"
weight: 3
---

This guide describes extension source **0.3.3**, which supports starting in fields that already contain text. It requires the matching **0.3.3 API and viewer**, including database migration **005**, for resumable publication. Developer-mode ZIP packages are distributed through [GitHub releases](https://github.com/juanre/possiblymadebyahuman/releases); Chrome Web Store availability is not confirmed. Check the package version before installing.

## Install or update

Use Chrome 120 or newer. Extract the ZIP. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked** on the extracted directory. Pin PMBAH in Chrome's toolbar, then reload any page that was already open.

To update an unpacked installation, replace its files in the same directory and choose **Reload** on its `chrome://extensions` card. Keep only one enabled PMBAH installation; adding a second extension does not stop the old version. Reload already-open pages after the update.

## Start only where you choose

Right-click an **editor** and choose **Start writing record**. You can also focus the editor and use **Alt+Shift+W**, or open PMBAH from the toolbar and choose **Start in focused editor**. Shortcuts are configurable at `chrome://extensions/shortcuts`.

You can start with text already in the field. The record captures edits from that point onward; it does not import earlier text or reconstruct how it was written. The editing timeline still shows later activity, but the total document length is unknown when capture starts partway through.

Opening the panel or focusing a field does not start capture. Other fields remain inactive. Editors can be text fields or supported rich-text areas on different sites; this is not limited to email. In an email, the body, recipient and subject fields are separate: choose the one you intend to work in.

The panel's **This editor** section follows the focused editor in the active tab of that browser window. It shows the matching draft or tells you that the field has no active writing record. **Other drafts** remain below. No label or controls cover the webpage.

Each draft gets a name based on its site, available field label and a distinguishing number. Choose **Rename** to give it a private name. This name stays in your browser and is separate from the **Public label** reviewed before publication. Field contents are not read to invent a name.

Write normally. Supported rich-text editors measure Unicode characters, including line breaks; ambiguous edits are reported as unknown measurements. Checkpoints send event counts and chain commitments while a chosen draft is active. The extension does not save or upload your document's words. See [privacy details](/docs/privacy/).

## Finish and share

Choose **Finish & get link**. The review identifies the draft being finished; moving focus elsewhere does not change that target. Under **Public context**, review the page URL, title and public label, removing identifying details if appropriate.

Publishing includes a text check. The scope appears separately as **Selected text** or **Whole field**. It checks the text present when you finish, which may include text written before capture started; it does not claim that earlier writing was captured. If the selection changes before confirmation, review the updated scope and confirm again. A match does not establish exact text equality, authorship, or that these edits produced that text. The check is public and permits wording guesses; it is not encryption.

Choose **Confirm & publish** to stop capture and publish. For a new 0.3 record, signed duration includes elapsed time up to this finish action, including time away before finishing. It is a client claim, not evidence that the server watched the whole interval. The viewer separately shows server-observed span and intervals with no captured edits.

The result shows the complete URL, **Open record** and **Copy link**. Copying happens only when you choose it. If copying fails, select the visible URL and copy it yourself. Choose **Done** to dismiss the result; its link remains in saved history.

If the text-check scope is unavailable or its hash cannot be computed, nothing is silently published without it. Only then does the panel offer cancel or **Publish editing activity only**. The stopped editor is not read again to create a different commitment. Canceling after capture has stopped leaves the draft stopped. A failed upload retries the same frozen record, including its finish time.

## Stop and return later

**Stop** pauses capture and keeps the unfinished draft. It does not publish or compute a text check. To return later—even after months—click its field, select the draft in the panel and choose **Resume in chosen field**. The field may already contain text; resumption is restricted to the same site origin. You choose which draft belongs there; PMBAH does not infer document identity from similar fields.

Resume keeps the original session and clock. The next captured edit includes the time away, and a 0.3 finish includes the pause even if you return only to publish. Edits made while capture was stopped are not recovered. The document-length curve stops where measurements no longer establish it; the extension does not pretend the text was unchanged during the pause.

If you finish immediately after resuming without another captured edit, you can publish the earlier editing activity, but cannot attach a check of the current field text. To include that check, resume again and make an edit before finishing. Older format 0.1 drafts retain their last-edit timing; failed uploads of older records also keep their original format and hash. The new signed-finish behavior does not change existing records, `/write`, or the Emacs producer.

Reloading or navigating to a new page document ends capture authorization. Typing afterward does not automatically start or resume a session. The website must preserve your text: PMBAH does not store or restore your words.

## Continue a saved record

A published record and its link never change when you continue writing. In **Saved records**, open the record's **Details**, focus the intended field on the same site, and choose **Continue in chosen field**. This explicitly starts a new draft linked to the earlier record. It contains new edits only; the previous link stays in history.

The new clock begins at the earlier record's signed finish, so the pause before continuing is included. For an older saved record without a signed finish, the retained local upload time is used as an approximate boundary. Neither case claims that edits made while capture was stopped were observed.

To start an independent record, choose **Start writing record** in the intended editor. If two editors show the same document, select its active draft and explicitly choose to **share its writing record** before starting in the second editor. Use this only for the same document. A session spanning several editors can publish editing activity without a text check.

## Keep and find your links

**Saved records** is last and collapsed by default. Expand it to search by private name, site, date or link, and page through older entries. Each row has Open/Copy actions and expandable details. **Export all links** downloads the complete saved-link list as JSON, including private names and site information; it does not export document text or unfinished drafts.

Drafts and saved links have no automatic expiry or age-based eviction. **Discard draft**, **Remove saved link** and **Remove all saved links** are explicit local removals. Removing a saved link does not delete the public record. Export a backup before uninstalling or clearing browser data; history belongs to this browser and is not account-synced. Previously expired links cannot be restored from missing local data.

Authenticated Gmail and other complex sites still need acceptance testing with this candidate. Report a problem through [GitHub issues](https://github.com/juanre/possiblymadebyahuman/issues), including the extension version and the action that failed; do not post private writing.
