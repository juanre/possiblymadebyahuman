import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/extension-harness");
  await page.evaluate(() => {
    const compose = document.createElement("div");
    compose.id = "compose";
    compose.style.cssText = "position:fixed;top:140px;left:60px;width:500px";
    const field = document.querySelector("textarea");
    field.style.cssText = "display:block;width:100%;height:160px;box-sizing:border-box";
    compose.append(field);
    document.body.append(compose);
  });
  await page.getByLabel("plain field").focus();
  await expect(page.getByRole("button", { name: /PMBAH: writing record/ })).toBeVisible();
});

async function placement(page) {
  return page.evaluate(() => {
    const field = document.querySelector("textarea").getBoundingClientRect();
    const control = document.querySelector("[data-pmbah-indicator]").getBoundingClientRect();
    return { top: Math.round(control.top - field.top), right: Math.round(field.right - control.right) };
  });
}

test("control follows compose movement and resizing, hides on minimize, and is removed on close", async ({ page }) => {
  const control = page.getByRole("button", { name: /PMBAH: writing record/ });
  await expect.poll(() => placement(page)).toEqual({ top: 4, right: 4 });
  // No typing/resize/scroll event: movement is entirely an ancestor transform.
  await page.evaluate(() => { document.querySelector("#compose").style.transform = "translate(240px, 170px)"; });
  await expect.poll(() => placement(page)).toEqual({ top: 4, right: 4 });
  await page.evaluate(() => { document.querySelector("#compose").style.width = "700px"; });
  await expect.poll(() => placement(page)).toEqual({ top: 4, right: 4 });
  await page.evaluate(() => { document.querySelector("#compose").style.display = "none"; });
  await expect(control).toBeHidden();
  await page.evaluate(() => { document.querySelector("#compose").style.display = "block"; });
  await expect(control).toBeVisible();
  await expect.poll(() => placement(page)).toEqual({ top: 4, right: 4 });
  await page.evaluate(() => {
    window.__savedCompose = document.querySelector("#compose");
    window.__savedCompose.remove();
  });
  await expect(page.locator("[data-pmbah-indicator]")).toHaveCount(0);
  // Restoring the same DOM node must restore its control without registering
  // another session or duplicating listeners.
  await page.evaluate(() => { document.body.append(window.__savedCompose); });
  await page.getByLabel("plain field").focus();
  await expect(control).toBeVisible();
  expect(await page.evaluate(() => window.__pmbah.messages.filter(m => m.kind === "register_field").length)).toBe(1);
});

test("control disappears when its editor is scrolled out of a nested container", async ({ page }) => {
  const control = page.getByRole("button", { name: /PMBAH: writing record/ });
  await page.evaluate(() => {
    const compose = document.querySelector("#compose");
    compose.style.height = "180px";
    compose.style.overflow = "auto";
    const spacer = document.createElement("div");
    spacer.style.height = "1000px";
    compose.append(spacer);
    compose.scrollTop = 250;
  });
  await expect(control).toBeHidden();
  await page.evaluate(() => { document.querySelector("#compose").scrollTop = 0; });
  await expect(control).toBeVisible();
});

test("click opens controls without losing selected wording or signing anything; keyboard activation works", async ({ page }) => {
  const field = page.getByLabel("plain field");
  await field.fill("Some selected wording");
  await field.evaluate(field => field.setSelectionRange(5, 13));
  const control = page.getByRole("button", { name: /PMBAH: writing record/ });
  await control.click();
  await expect.poll(() => page.evaluate(() => window.__pmbah.messages.filter(m => m.kind === "open_controls").length)).toBe(1);
  expect(await field.evaluate(field => [field.selectionStart, field.selectionEnd, document.activeElement === field])).toEqual([5, 13, true]);
  await control.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => window.__pmbah.messages.filter(m => m.kind === "open_controls").length)).toBe(2);
  expect(await page.evaluate(() => window.__pmbah.messages.some(m => m.kind === "sign_session"))).toBe(false);
  await expect(control).not.toContainText(/recording/i);
});

test("unsupported popup opening gives visible instructions without changing capture state", async ({ page }) => {
  await page.evaluate(() => { window.__pmbah.popupUnavailable = true; });
  await page.getByRole("button", { name: /PMBAH: writing record/ }).click();
  await expect(page.getByRole("status")).toHaveText("Open PMBAH from Chrome’s extensions menu");
  await page.getByLabel("plain field").pressSequentially("a");
  await expect(page.getByLabel("plain field")).toHaveAttribute("data-pmbah-state", "recording");
  expect(await page.evaluate(() => window.__pmbah.messages.some(m => m.kind === "append_mutation"))).toBe(true);
});
