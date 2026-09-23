import { chromium, expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalizeTextForBinding, verifyRecord } from "../../packages/format/src/index.ts";

// End-to-end: the packaged extension in a real Chromium, recording a real page,
// signing from its popup, and uploading to a locally running service. Gated on
// PMBAH_LOCAL_BASE_URL so the default browser suite stays offline.
const localBaseUrl = process.env.PMBAH_LOCAL_BASE_URL?.trim().replace(/\/+$/, "") ?? "";
const rootDir = fileURLToPath(new URL("../..", import.meta.url));
const SKIP_REASON = "PMBAH_LOCAL_BASE_URL is not set. Start the local stack (make local-container) and run: PMBAH_LOCAL_BASE_URL=http://localhost:8000 npm run test:extension-e2e";
// The list reporter shows skips without their reason, so say it once here.
if (!localBaseUrl) console.warn(`Skipping extension e2e: ${SKIP_REASON}`);

test.describe("browser extension against the local service", () => {
  test.skip(!localBaseUrl, SKIP_REASON);
  test.setTimeout(120_000);

  let distDir;
  let userDataDir;
  let context;
  let extensionId;

  test.beforeAll(async () => {
    distDir = await mkdtemp(join(tmpdir(), "pmbah-extension-dist-"));
    execFileSync(process.execPath, [join(rootDir, "apps/browser-extension/scripts/build.mjs")], {
      cwd: rootDir,
      stdio: "pipe",
      env: { ...process.env, EXT_BASE_URL: localBaseUrl, EXT_DIST_DIR: distDir },
    });
    userDataDir = await mkdtemp(join(tmpdir(), "pmbah-extension-profile-"));
    // Extensions need a persistent context and the full Chromium build; the
    // headless shell does not load them.
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${distDir}`, `--load-extension=${distDir}`],
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 15_000 });
    extensionId = new URL(worker.url()).host;
  });

  test.afterAll(async () => {
    await context?.close();
    for (const dir of [distDir, userDataDir]) {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });

  test("explicitly captures only the chosen rich editor, publishes and restores its result, and stops after finishing", async ({ baseURL }, testInfo) => {
    const typed = "Quill pen ravens";
    const canaries = [typed, "Quill", "raven", "pen ravens"];
    const pageErrors = [];

    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`${baseURL}/extension-page`);
    const field = page.getByLabel("rich field");
    // Merely visiting or typing elsewhere must create no writing session.
    await page.getByLabel("plain field").fill("unselected field");
    await expect(page.locator("[data-pmbah-state]")).toHaveCount(0);

    const popup = await context.newPage();
    await popup.setViewportSize({ width: 380, height: 900 });
    popup.on("pageerror", (error) => pageErrors.push(error.message));
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(popup.locator("article.session")).toHaveCount(0);
    await page.bringToFront();
    await field.focus();
    // The side-panel document is opened in a test tab because headless Chrome
    // does not expose its chrome UI. Keep the editor tab active while invoking
    // the same panel button handler; the installed worker chooses its frame.
    await popup.evaluate(() => document.getElementById("start").click());
    await expect(popup.locator("#toast")).toContainText("Writing record started");
    await page.keyboard.type(typed);
    await page.keyboard.press("Backspace");
    const expectedEventCount = typed.length + 1;
    await popup.reload();
    const session = popup.locator("article.session", { hasText: "rich field" });
    await expect(session).toHaveCount(1);
    await expect(session.locator(".session-state")).toHaveText("Active draft");
    await expect(session).toContainText(`${expectedEventCount} editing events`);

    await session.getByRole("button", { name: "Finish & get link" }).click();
    const confirm = popup.locator(".sign-confirm");
    await expect(confirm).toBeVisible();
    await expect(confirm.locator(".sign-bind")).toBeChecked();
    await confirm.locator(".sign-confirm-go").click();

    const toast = popup.locator("#toast");
    await expect(toast).toContainText("Record saved", { timeout: 30_000 });
    await expect(toast).not.toHaveClass(/error/);
    const result = popup.locator("#latest");
    await expect(result.getByRole("heading", { name: "Record saved" })).toBeVisible();
    const recordUrl = await result.getByLabel("Complete record link").inputValue();
    const shortSignature = new URL(recordUrl).pathname.slice(1);
    expect(shortSignature).toMatch(/^[A-Za-z0-9_-]{6,}$/);

    const response = await fetch(`${localBaseUrl}/api/records/${shortSignature}`);
    expect(response.status).toBe(200);
    const record = await response.json();
    expect(verifyRecord({ manifest: record.manifest, events: record.events }).valid).toBe(true);
    expect(record.manifest.event_count).toBe(expectedEventCount);
    expect(record.events).toHaveLength(expectedEventCount);
    expect(record.events.filter((event) => event.op === "delete")).toHaveLength(1);
    expect(record.manifest.producer.id).toBe("browser-extension");
    expect(record.manifest.text_binding).toBeTruthy();
    expect(record.manifest.text_binding.canonical_length).toBe(canonicalizeTextForBinding(typed.slice(0, -1)).length);
    expect(record.observation.state).toBe("observed");
    const serialized = JSON.stringify(record);
    for (const canary of canaries) {
      expect(serialized.includes(canary), `public record leaked typed text: ${canary}`).toBe(false);
    }

    const recordPage = await context.newPage();
    recordPage.on("pageerror", (error) => pageErrors.push(error.message));
    await recordPage.goto(`${localBaseUrl}/${shortSignature}`);
    await expect(recordPage.getByRole("heading", { name: "Signed writing record" })).toBeVisible();
    await expect(recordPage.locator("section.card", { hasText: "Signature & details" })).toContainText(record.manifest.record_hash);

    // Finishing revokes capture; later edits cannot silently continue or be
    // included in the saved record. Reopening controls restores a usable URL.
    await field.focus();
    await page.keyboard.type(" x");
    await expect(page.locator("[data-pmbah-state]")).toHaveCount(0);
    await popup.reload();
    await expect(popup.locator("article.session")).toHaveCount(0);
    await popup.locator("#history-title").click();
    const savedRow = popup.locator(".saved-row", { hasText: "rich field" });
    await savedRow.locator("summary").click();
    await expect(savedRow.getByLabel("Complete record link")).toHaveValue(recordUrl);
    await expect(savedRow.getByRole("link", { name: "Open record" })).toHaveAttribute("href", recordUrl);
    await expect(savedRow.getByRole("button", { name: "Copy link" })).toBeEnabled();

    expect(await popup.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await popup.screenshot({ path: testInfo.outputPath("extension-panel-saved.png"), fullPage: true });
    await recordPage.screenshot({ path: testInfo.outputPath("record-viewer.png"), fullPage: true });
    expect(pageErrors).toEqual([]);
  });

  test("stopped drafts resume in an explicitly chosen nonempty field and finish with a fresh binding", async ({ baseURL }) => {
    const page = await context.newPage();
    await page.goto(`${baseURL}/extension-page`);
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/popup.html`);
    const field = page.getByLabel("plain field");
    await page.bringToFront();
    await field.focus();
    await panel.evaluate(() => document.getElementById("start").click());
    await expect(panel.locator("#toast")).toContainText("Writing record started");
    await page.keyboard.type("before");
    await panel.reload();
    const draft = panel.locator("article.selected");
    const sessionId = await draft.getAttribute("data-session-id");
    await draft.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(draft.getByRole("button", { name: "Resume in chosen field" })).toBeEnabled();
    // A restored page can contain edits from elsewhere; no text import or
    // inferred replacement is allowed during explicit reattachment.
    await page.reload();
    await field.fill("offline text");
    await page.bringToFront();
    await field.focus();
    await draft.getByRole("button", { name: "Resume in chosen field" }).evaluate(button => button.click());
    await expect(panel.locator("#toast")).toContainText("Draft resumed");
    await expect(draft).toContainText("6 editing events");
    await page.keyboard.press("End");
    await page.keyboard.type(" after");
    await panel.reload();
    await expect(draft).toHaveAttribute("data-session-id", sessionId);
    await expect(draft).toContainText("12 editing events");
    // Stop/resume again in the same DOM node: stale entry WeakRefs and cached
    // frozen snapshots must not supply an earlier pass's binding.
    await draft.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(draft.getByRole("button", { name: "Resume in chosen field" })).toBeEnabled();
    await page.bringToFront();
    await field.focus();
    await draft.getByRole("button", { name: "Resume in chosen field" }).evaluate(button => button.click());
    await expect(panel.locator("#toast")).toContainText("Draft resumed");
    await page.keyboard.type("!");
    await panel.reload();
    await draft.getByRole("button", { name: "Finish & get link" }).click();
    await panel.locator(".sign-confirm-go").click();
    await expect(panel.locator("#latest").getByRole("heading", { name: "Record saved" })).toBeVisible();
    const url = await panel.locator("#latest").getByLabel("Complete record link").inputValue();
    const record = await (await fetch(`${localBaseUrl}/api/records/${new URL(url).pathname.slice(1)}`)).json();
    expect(record.manifest.session_id).toBe(sessionId);
    expect(record.manifest.event_count).toBe(13);
    expect(record.events[6].pos).toBeNull();
    expect(record.events[12].pos).toBeNull();
    expect(record.stats.observed_final_length).toBeNull();
    expect(record.manifest.text_binding.canonical_length).toBe(canonicalizeTextForBinding("offline text after!").length);
    expect(verifyRecord({ manifest: record.manifest, events: record.events }).valid).toBe(true);
    expect(JSON.stringify(record)).not.toContain("offline text");
    await page.close();
    await panel.close();
  });

  for (const crossOrigin of [false, true]) {
  test(`freezes selected wording in the chosen ${crossOrigin ? "cross-origin" : "same-origin"} iframe, without binding the parent editor`, async ({ baseURL }) => {
    const page = await context.newPage();
    await page.goto(`${baseURL}/extension-page`);
    await page.getByLabel("rich field").fill("UNSELECTED PARENT WORDS");
    const frameUrl = new URL("/extension-page", baseURL);
    if (crossOrigin) frameUrl.hostname = "localhost";
    expect(frameUrl.origin === new URL(baseURL).origin).toBe(!crossOrigin);
    await page.evaluate(src => {
      const frame = document.createElement("iframe");
      frame.src = src;
      frame.title = "Chosen document frame";
      frame.style.height = "500px";
      document.body.append(frame);
    }, frameUrl.href);
    const field = page.frameLocator("iframe").getByLabel("rich field");
    await field.waitFor();
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.bringToFront();
    await field.focus();
    await panel.evaluate(() => document.getElementById("start").click());
    await expect(panel.locator("#toast")).toContainText("Writing record started");
    await page.keyboard.type("hello chosen wording");
    await field.evaluate(element => {
      const range = element.ownerDocument.createRange();
      range.setStart(element.firstChild, 6);
      range.setEnd(element.firstChild, 12);
      const selection = element.ownerDocument.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await panel.reload();
    await panel.locator("article.selected").getByRole("button", { name: "Finish & get link" }).click();
    await panel.locator(".sign-confirm-go").click();
    const saved = panel.locator("#latest");
    await expect(saved.getByRole("heading", { name: "Record saved" })).toBeVisible();
    const url = await saved.getByLabel("Complete record link").inputValue();
    const record = await (await fetch(`${localBaseUrl}/api/records/${new URL(url).pathname.slice(1)}`)).json();
    expect(record.manifest.text_binding.canonical_length).toBe(6);
    expect(record.manifest.event_count).toBe(20);
    expect(record.stats.observed_final_length).toBe(20);
    expect(JSON.stringify(record)).not.toContain("UNSELECTED PARENT WORDS");
    await page.close();
    await panel.close();
  });

  }

  test("empty canonical wording cannot silently downgrade, and clipboard denial keeps a saved link", async ({ baseURL }) => {
    const page = await context.newPage();
    await page.goto(`${baseURL}/extension-page`);
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.bringToFront();
    await page.getByLabel("rich field").focus();
    await panel.evaluate(() => document.getElementById("start").click());
    await expect(panel.locator("#toast")).toContainText("Writing record started");
    await page.keyboard.type("!!!");
    await panel.reload();
    await panel.locator("article.selected").getByRole("button", { name: "Finish & get link" }).click();
    await panel.locator(".sign-confirm-go").click();
    await expect(panel.getByRole("alert")).toContainText("No record was published");
    await expect(panel.locator("article.selected .saved-result")).toHaveCount(0);
    await panel.getByRole("button", { name: "Publish editing activity only" }).click();
    const saved = panel.locator("#latest");
    await expect(saved.getByRole("heading", { name: "Record saved" })).toBeVisible();
    await panel.evaluate(() => Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => { throw new Error("permission denied"); } } }));
    await saved.getByRole("button", { name: "Copy link" }).click();
    await expect(saved.getByRole("status")).toContainText("your record is saved");
    const url = await saved.getByLabel("Complete record link").inputValue();
    await panel.reload();
    await panel.locator("#history-title").click();
    const savedRow = panel.locator(".saved-row").filter({ has: panel.locator(`a[href="${url}"]`) });
    await savedRow.locator("summary").click();
    await expect(savedRow.getByLabel("Complete record link")).toHaveValue(url);
    const record = await (await fetch(`${localBaseUrl}/api/records/${new URL(url).pathname.slice(1)}`)).json();
    expect(record.manifest.text_binding).toBeUndefined();
    await page.close();
    await panel.close();
  });

  test("exact editor focus follows identical fields and leaves an untracked field uncovered", async ({ baseURL }) => {
    const page = await context.newPage();
    await page.goto(`${baseURL}/extension-page`);
    await page.evaluate(() => {
      document.querySelector("#plain").setAttribute("aria-label", "Document");
      document.querySelector("#rich").setAttribute("aria-label", "Document");
      const unrelated = document.createElement("input"); unrelated.setAttribute("aria-label", "Untracked field"); document.body.append(unrelated);
    });
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/popup.html`);
    const fields = page.getByLabel("Document", { exact: true });
    await page.bringToFront(); await fields.nth(0).focus();
    await expect(panel.locator("#start")).toBeEnabled();
    await panel.locator("#start").evaluate(button => button.click());
    await expect(panel.locator("#toast")).toContainText("Writing record started");
    await page.keyboard.type("first");
    await expect(panel.locator("article.current")).toContainText("5 editing events");
    const firstId = await panel.locator("article.current").getAttribute("data-session-id");
    await fields.nth(1).focus();
    await expect(panel.locator("#current")).toContainText("No writing record is active for this field");
    await panel.locator("#start").evaluate(button => button.click());
    await expect(panel.locator("article.current")).not.toHaveAttribute("data-session-id", firstId);
    await page.keyboard.type("second");
    const secondId = await panel.locator("article.current").getAttribute("data-session-id");
    expect(secondId).not.toBe(firstId);
    await fields.nth(0).focus();
    await expect(panel.locator("article.current")).toHaveAttribute("data-session-id", firstId);
    await fields.nth(1).focus();
    await expect(panel.locator("article.current")).toHaveAttribute("data-session-id", secondId);
    await page.getByLabel("Untracked field").focus();
    await page.keyboard.type("not included");
    await expect(panel.locator("article.current")).toHaveCount(0);
    await expect(panel.locator("#current")).toContainText("No writing record is active for this field");
    await expect(panel.locator("article.session")).toHaveCount(2);
    const summaries = await panel.evaluate(async () => chrome.runtime.sendMessage({ kind: "list_panel_sessions", window_id: (await chrome.windows.getCurrent()).id }));
    expect(summaries.drafts.map(session => session.event_count).sort()).toEqual([5, 6]);
    expect(summaries.drafts.every(session => !("events" in session) && !("observation" in session))).toBe(true);
    await panel.evaluate(async ids => { for (const session_id of ids) await chrome.runtime.sendMessage({ kind: "discard_session", session_id }); }, [firstId, secondId]);
    await page.close(); await panel.close();
  });

  test("changed text scope requires reconfirmation and a saved record continues as a new immutable segment", async ({ baseURL }) => {
    const page = await context.newPage();
    await page.goto(`${baseURL}/extension-page`);
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/popup.html`);
    const field = page.getByLabel("plain field");
    await page.bringToFront(); await field.focus();
    await expect(panel.locator("#start")).toBeEnabled();
    await panel.locator("#start").evaluate(button => button.click());
    await expect(panel.locator("#toast")).toContainText("Writing record started");
    await page.keyboard.type("alpha beta");
    await field.evaluate(element => element.setSelectionRange(0, 5));
    await expect(panel.locator("article.current")).toContainText("10 editing events");
    await panel.locator("article.current").getByRole("button", { name: "Finish & get link" }).click();
    await expect(panel.locator(".binding-scope")).toHaveText("Selected text");
    await field.evaluate(element => element.setSelectionRange(10, 10));
    await panel.locator(".sign-confirm-go").click();
    await expect(panel.getByRole("alert")).toContainText("confirm again");
    await expect(panel.locator(".binding-scope")).toHaveText("Whole field");
    await expect(panel.locator("#latest .saved-result")).toHaveCount(0);
    await panel.locator(".sign-confirm-go").click();
    await expect(panel.locator("#latest").getByRole("heading", { name: "Record saved" })).toBeVisible();
    const originalUrl = await panel.locator("#latest").getByLabel("Complete record link").inputValue();
    const original = await (await fetch(`${localBaseUrl}/api/records/${new URL(originalUrl).pathname.slice(1)}`)).json();
    expect(original.manifest.text_binding.canonical_length).toBe(9);
    await panel.locator("#history-title").click();
    const originalRow = panel.locator(".saved-row").filter({ has: panel.locator(`a[href="${originalUrl}"]`) });
    await originalRow.locator("summary").click();
    await page.bringToFront(); await field.focus();
    await originalRow.getByRole("button", { name: "Continue in chosen field" }).evaluate(button => button.click());
    await expect(panel.locator("#toast")).toContainText("A new draft continues");
    await page.keyboard.press("End"); await page.keyboard.type("!");
    await expect(panel.locator("article.current")).toContainText("1 editing event");
    const nextSession = await panel.locator("article.current").getAttribute("data-session-id");
    expect(nextSession).not.toBe(original.manifest.session_id);
    await panel.locator("article.current").getByRole("button", { name: "Finish & get link" }).click();
    await panel.locator(".sign-confirm-go").click();
    await expect(panel.locator("#latest").getByRole("heading", { name: "Record saved" })).toBeVisible();
    const nextUrl = await panel.locator("#latest").getByLabel("Complete record link").inputValue();
    expect(nextUrl).not.toBe(originalUrl);
    const continuation = await (await fetch(`${localBaseUrl}/api/records/${new URL(nextUrl).pathname.slice(1)}`)).json();
    expect(continuation.manifest.parent_record).toBe(original.manifest.record_hash);
    expect(continuation.manifest.event_count).toBe(1);
    expect(continuation.events[0].pos).toBeNull();
    expect(verifyRecord(continuation).valid).toBe(true);
    const unchanged = await (await fetch(`${localBaseUrl}/api/records/${new URL(originalUrl).pathname.slice(1)}`)).json();
    expect(unchanged).toEqual(original);
    await expect(panel.locator(`.saved-row a[href="${originalUrl}"]`)).toBeVisible();
    await expect(panel.locator(`.saved-row a[href="${nextUrl}"]`)).toBeVisible();
    await page.close(); await panel.close();
  });

});
