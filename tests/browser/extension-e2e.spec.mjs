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
    await expect(session.locator(".session-state")).toHaveText("Saved");
    const recordUrl = await session.getByLabel("Complete record link").inputValue();
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
    await expect(popup.locator("article.session")).toHaveCount(1);
    await expect(session.getByLabel("Complete record link")).toHaveValue(recordUrl);
    await expect(session.getByRole("link", { name: "Open record" })).toHaveAttribute("href", recordUrl);
    await expect(session.getByRole("button", { name: "Copy link" })).toBeEnabled();

    expect(await popup.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await popup.screenshot({ path: testInfo.outputPath("extension-panel-saved.png"), fullPage: true });
    await recordPage.screenshot({ path: testInfo.outputPath("record-viewer.png"), fullPage: true });
    expect(pageErrors).toEqual([]);
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
    const saved = panel.locator("article.selected");
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
    await panel.getByRole("button", { name: "Publish process only" }).click();
    const saved = panel.locator("article.selected");
    await expect(saved.getByRole("heading", { name: "Record saved" })).toBeVisible();
    await panel.evaluate(() => Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => { throw new Error("permission denied"); } } }));
    await saved.getByRole("button", { name: "Copy link" }).click();
    await expect(saved.getByRole("status")).toContainText("your record is saved");
    const url = await saved.getByLabel("Complete record link").inputValue();
    await panel.reload();
    await expect(panel.locator("article.selected").getByLabel("Complete record link")).toHaveValue(url);
    const record = await (await fetch(`${localBaseUrl}/api/records/${new URL(url).pathname.slice(1)}`)).json();
    expect(record.manifest.text_binding).toBeUndefined();
    await page.close();
    await panel.close();
  });

});
