# Chrome Web Store listing

Paste-ready text for each Developer Dashboard tab, followed by the submission
checklist. Quoted blocks are the text to paste, without the leading `>`. Technical backing (package checksum, single purpose, permission
justifications, what leaves the browser) is in
[`docs/chrome-web-store-prep.md`](chrome-web-store-prep.md).

## Store listing tab

### Name

`possiblymadebyahuman`

The dashboard takes the name from the manifest `name` and does not let you edit
it there.

### Summary

The dashboard takes the summary from the manifest `description` (132 characters
at most). The 0.4.0 package says:

> Content-blind writing records for text fields.

Suggested for the next version, if you want a clearer one (115 characters):

> Records how you edit a text field you choose, never the words, and gives you a signed link to the writing process.

Changing it means editing `apps/browser-extension/manifest.template.json` and
releasing a new version.

### Description

> You wrote something. Actually wrote it. Then someone decided a machine did.
>
> Nobody can prove that a person wrote a piece of text, and this extension does
> not try. What it can do is record the writing process while it happens, sign
> it, and give you a link anyone can open to see how the text came together:
> the typing, the pauses, the places you went back and changed things, and
> anything pasted in. Think of it as a reverse Turing test.
>
> Your words stay with you. Each edit is measured as numbers: when it happened,
> where in the text, how many characters went in or out, and whether it was
> typed, pasted, cut, dropped or composed with an input method. The text itself
> is never saved or sent.
>
> HOW IT WORKS
>
> 1. Click into a text field on any site and start a writing record: right-click
> and choose "Start writing record", press Alt+Shift+W, or use the button in the
> side panel. Nothing is recorded until you do, and only that field is
> recorded.
> 2. Write as usual. The field can already contain text; the record covers the
> edits you make from then on.
> 3. Choose "Finish & get link". Review the page address, title and label that
> will be published with the record, and remove anything you would rather keep
> private.
> 4. Confirm. You get a link to a public record page with a writing-rhythm
> chart, an edit timeline and the signature details.
>
> While you write, the extension sends the service a small checkpoint now and
> then: a count of edits and a hash of the edit history so far. The service
> timestamps each one, so a record that took twenty minutes to write shows
> twenty minutes of server-observed time.
>
> When you publish, the record includes a salted fingerprint of the text in the
> field, or of your selection. Anyone with a copy of the text can check it
> against the record in their own browser. The fingerprint is not encryption:
> short or predictable text can be guessed.
>
> The record shows measurements and leaves the judgment to the reader. It cannot
> tell anyone who wrote something, and the record page says so.
>
> Stop pauses a draft, and you can resume it later in the same field. Drafts
> and saved links stay in your browser until you remove them. Published records
> are permanent, so review the public details before you confirm.
>
> No account needed. Open source under the MIT license.
>
> Privacy details: https://possiblymadebyahuman.com/docs/privacy/
> Source and issues: https://github.com/juanre/possiblymadebyahuman

### Category and language

- Category: **Productivity › Tools**. **Productivity › Communication** also
  fits if you prefer to present it as a writing aid for messages.
- Language: **English**.

### Graphic assets

| Slot | File |
| --- | --- |
| Store icon (128x128) | `apps/browser-extension/store-assets/chrome-web-store-icon-128.png` |
| Screenshot 1 | `apps/browser-extension/store-assets/screenshots/1-recording.png`: a reply being recorded, panel beside the page |
| Screenshot 2 | `apps/browser-extension/store-assets/screenshots/2-review.png`: the finish review with the public context |
| Screenshot 3 | `apps/browser-extension/store-assets/screenshots/3-published.png`: the saved record with its link |
| Screenshot 4 | `apps/browser-extension/store-assets/screenshots/4-record.png`: the public record page |
| Screenshot 5 | `apps/browser-extension/store-assets/screenshots/5-timeline.png`: quick facts and the edit timeline |
| Small promo tile (440x280) | `apps/browser-extension/store-assets/promo-tile-440x280.png` |
| Marquee promo tile (1400x560) | Optional; none prepared |

All screenshots are 1280x800 and come from the real extension and viewer; see
`docs/browser-extension-release.md#store-screenshots` to regenerate them. The
blog in the screenshots is fictional and served locally.

### Additional fields

- Official URL / homepage: `https://possiblymadebyahuman.com`
- Support URL: `https://github.com/juanre/possiblymadebyahuman/issues`
- Mature content: **No**.

## Privacy practices tab

### Single purpose

Paste from
[`chrome-web-store-prep.md#single-purpose`](chrome-web-store-prep.md#single-purpose).

### Permission justifications

Paste each one from
[`chrome-web-store-prep.md#permission-justifications`](chrome-web-store-prep.md#permission-justifications):
`storage`, `clipboardWrite`, `alarms`, `contextMenus`, `sidePanel`,
`webNavigation`, and the host permission.

### Remote code

**No, I am not using remote code.**

### Data usage

The form asks which kinds of user data the extension collects, meaning data
that leaves the browser. Tick these three:

- **User activity.** The extension logs keystroke-level edit events in the
  chosen field (time, position, length, input source) and sends them as
  checkpoints and in the published record. No keys or characters are recorded.
- **Web history.** A published record includes the address (without query or
  fragment) and title of the page the user wrote on. The user reviews both and
  can remove either before publishing. No other browsing history is collected.
- **Website content.** A published record includes a salted fingerprint of the
  text the user chose (selection or whole field), computed locally. The text
  itself is never sent. This is ticked to be conservative, because the
  fingerprint is derived from page content.

Leave the others unticked: personally identifiable information, health,
financial and payment information, authentication information (the checkpoint
token is issued by our service, not a user credential), personal
communications, and location.

Tick all three certifications:

- I do not sell or transfer user data to third parties, outside of the approved
  use cases.
- I do not use or transfer user data for purposes that are unrelated to my
  item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for
  lending purposes.

Published records are public because the user chooses to publish them; that is
the single purpose, not a transfer to a third party.

### Privacy policy URL

`https://possiblymadebyahuman.com/docs/privacy/`

## Test instructions for the reviewer

The dashboard offers a field for reviewer instructions. Paste:

> No account or login is needed.
> 1. Open any page with a text field, for example a comment form.
> 2. Click inside the field, then right-click and choose "Start writing record"
> (or press Alt+Shift+W). The side panel opens and shows an active draft.
> 3. Type a few sentences. The draft's edit count rises. Other fields on the
> page are not recorded.
> 4. Click "Finish & get link", review the page address and title under Public
> context, and click "Confirm & publish".
> 5. Click "Open record" to see the public record page. It shows timing and
> edit measurements; the typed text does not appear anywhere in it or in the
> network requests.

## Distribution tab

- Visibility: **public** or **unlisted**, Juan's decision. Unlisted keeps the
  item out of search while the direct link works.
- Regions: all regions.
- Pricing: free.

## Submission checklist

Do these in order.

1. **Settle the open decisions** listed in
   [Before you start](#before-you-start).
2. **Deploy the privacy page** so that
   `https://possiblymadebyahuman.com/docs/privacy/` serves the current text.
   The reviewer reads it against the privacy tab.
3. **Prepare the Google account.** Use the account that should own the listing
   and turn on 2-Step Verification; the dashboard requires it to publish.
4. **Register as a developer** at
   `https://chrome.google.com/webstore/devconsole`. Accept the developer
   agreement and pay the one-time US$5 registration fee.
5. **Fill the Account page.** Publisher display name, a contact email (verify
   it from the email Google sends), and the trader or non-trader declaration
   for the EU. Keep a public email off the listing unless you want one there.
6. **Download the package** `possiblymadebyahuman-extension-0.4.0.zip` from the
   GitHub release for tag `v0.4.0`, or the release you are submitting. Run
   `shasum -a 256` on it and compare with the value in
   [`chrome-web-store-prep.md#package-facts`](chrome-web-store-prep.md#package-facts).
   Upload only a matching file.
7. **Create the item.** In the dashboard choose "New item" and upload the zip.
8. **Store listing tab.** Paste the description, choose category and language,
   upload the icon, the five screenshots and the small promo tile, and fill the
   homepage and support URLs. Check that the name and summary shown match the
   manifest.
9. **Privacy practices tab.** Paste the single purpose and the seven
   justifications, answer remote code, tick the data types and the three
   certifications, and enter the privacy policy URL.
10. **Test instructions.** Paste the reviewer instructions above.
11. **Distribution tab.** Choose visibility, regions and free pricing.
12. **Submit for review.** Choose to publish manually after approval (the
    submit dialog offers this), so you can check the approved listing before it
    goes live.
13. **Wait for review.** Google says most reviews finish within a few days.
    Broad host permissions usually mean an in-depth review, which can take
    longer. The dashboard shows the status, and a rejection arrives by email
    naming the policy.
14. **After approval**, record the extension ID, listing URL and visibility in
    [`chrome-web-store-prep.md#listing-identity`](chrome-web-store-prep.md#listing-identity),
    then publish. Only then link the listing from the site and README.

### Common rejection reasons with broad host access

- **Excessive permissions** (Google's "Purple Potassium" family). The
  reviewer decides that `<all_urls>` or another permission is broader than the
  described function. Answer with the host justification, point to explicit
  activation, or narrow `host_permissions` to the service origin in a new
  version (see the review risks in the prep doc).
- **Justification does not match behavior.** The justification must describe
  what the code does. Keep it identical to the prep doc, which was checked
  against the source.
- **Privacy disclosure mismatch.** The data-usage answers, the description and
  the privacy page must agree. Under-ticking data types is a common cause.
- **Missing or unreachable privacy policy.** The URL must load and cover the
  extension.
- **Description or screenshots that do not show the function.** The
  screenshots show the actual flow, which helps here.

If a rejection needs a code change, fix it, bump the version, tag a release and
upload the new zip. If you disagree with a rejection, reply through the link in
the rejection email.

## Before you start

These are Juan's decisions; nothing in this repository settles them.

1. **Summary text.** Keep "Content-blind writing records for text fields." for
   0.4.0, or ship a version with the suggested summary before submitting.
2. **Host permission scope.** Submit with `host_permissions: ["<all_urls>"]`,
   or first narrow it to `https://possiblymadebyahuman.com/*` in a new version
   (the content script keeps `<all_urls>`; two tests pin the current value).
3. **Visibility.** Public or unlisted.
4. **Category.** Tools or Communication.
5. **Data types.** Whether to tick Website content as well as User activity and
   Web history.
