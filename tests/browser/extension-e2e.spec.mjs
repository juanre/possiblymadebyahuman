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

  test("records a real page, signs from the popup, uploads a content-blind record, and continues after signing", async ({ baseURL }) => {
    const typed = "Quill pen ravens";
    const canaries = [typed, "Quill", "raven", "pen ravens"];
    const pageErrors = [];

    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`${baseURL}/extension-page`);
    const field = page.getByLabel("plain field");
    await field.focus();
    await expect(page.locator("[data-pmbah-state='recording']")).toHaveCount(1);
    await page.keyboard.type(typed);
    await page.keyboard.press("Backspace");
    const expectedEventCount = typed.length + 1;

    // Exercise the real action popup, not only a tab loaded at popup.html.
    // The control must keep the text selection intact for optional binding.
    await field.evaluate(field => field.setSelectionRange(0, 5));
    await page.getByRole("button", { name: /PMBAH: writing record/ }).click();
    const cdp = await context.newCDPSession(page);
    let actionTarget;
    await expect.poll(async () => {
      const { targetInfos } = await cdp.send("Target.getTargets");
      actionTarget = targetInfos.find(target => target.url === `chrome-extension://${extensionId}/popup.html`);
      return Boolean(actionTarget);
    }).toBe(true);
    expect(await field.evaluate(field => [field.selectionStart, field.selectionEnd])).toEqual([0, 5]);
    await cdp.send("Target.closeTarget", { targetId: actionTarget.targetId });
    await cdp.detach();
    await field.evaluate(field => field.setSelectionRange(field.value.length, field.value.length));

    const popup = await context.newPage();
    popup.on("pageerror", (error) => pageErrors.push(error.message));
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const session = popup.locator("article.session", { hasText: "plain field" });
    await expect(session).toHaveCount(1);
    await expect(session.locator(".session-state")).toHaveText("active");
    await expect(session).toContainText(`${expectedEventCount} events`);

    await session.getByRole("button", { name: "Sign & upload" }).click();
    const confirm = popup.locator(".sign-confirm");
    await expect(confirm).toBeVisible();
    await expect(confirm.locator(".sign-bind")).toBeChecked();
    await confirm.locator(".sign-confirm-go").click();

    const toast = popup.locator("#toast");
    await expect(toast).toContainText("record saved", { timeout: 30_000 });
    await expect(toast).not.toHaveClass(/error/);
    await expect(session.locator(".session-state")).toHaveText("uploaded");
    const shortSignature = (await session.locator("a").innerText()).trim();
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

    // Editing the signed field must not error; it starts a continuation session
    // linked to the uploaded record.
    await field.focus();
    await page.keyboard.type(" x");
    await expect(page.locator("[data-pmbah-state='error']")).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveText("PMBAH · writing record (continues a signed record) ↗");
    await popup.reload();
    const sessions = popup.locator("article.session", { hasText: "plain field" });
    await expect(sessions).toHaveCount(2);
    const continuation = sessions.filter({ hasText: "continues a record you already signed in this field" });
    await expect(continuation).toHaveCount(1);
    await expect(continuation.locator(".session-state")).toHaveText("active");
    await expect(continuation).toContainText("2 events");
    await expect(sessions.filter({ hasText: shortSignature }).locator(".session-state")).toHaveText("uploaded");

    expect(pageErrors).toEqual([]);
  });
});
