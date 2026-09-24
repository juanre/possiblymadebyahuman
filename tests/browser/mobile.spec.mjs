import { mockRecordUpload } from "./journal-fixtures.mjs";
import { expect, test } from "@playwright/test";

async function widths(page) {
  return page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
}

test.describe("phone viewport", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  for (const path of ["/smoke", "/bound"]) {
    test(`record page ${path} fits a 375px screen without horizontal scroll`, async ({ page }) => {
      await page.goto(path);
      await page.getByRole("heading", { name: "Signed writing record" }).waitFor();
      const measured = await widths(page);
      expect(measured.scroll).toBeLessThanOrEqual(measured.inner);
    });
  }

  test("/write fits a 375px screen without horizontal scroll, before and after signing", async ({ page }) => {
    await page.route("**/api/observed-sessions/*/checkpoints", async (route) => {
      const body = route.request().postDataJSON();
      const observedSessionId = new URL(route.request().url()).pathname.split("/").at(-2);
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ observed_session_id: observedSessionId, token: "p".repeat(32), checkpoint_id: "phone-cp", event_count: body.event_count, chain_tip: body.chain_tip, server_t: "2026-05-28T00:00:00.000Z", created: true }),
      });
    });
    await mockRecordUpload(page, async (route) => {
      const payload = route.request().postDataJSON();
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ record_hash: payload.manifest.record_hash, short_signature: "phonetest1", url: "http://127.0.0.1:4173/phonetest1", created: true }) });
    });
    await page.goto("/write");
    await expect(page.locator(".write-modeline")).toContainText("idle");
    let measured = await widths(page);
    expect(measured.scroll).toBeLessThanOrEqual(measured.inner);

    await page.keyboard.type("Written on a phone.");
    await page.getByRole("button", { name: "sign", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Sign this record" })).toBeVisible();
    measured = await widths(page);
    expect(measured.scroll).toBeLessThanOrEqual(measured.inner);

    await page.getByRole("button", { name: "sign & upload" }).click();
    await expect(page.getByRole("link", { name: "http://127.0.0.1:4173/phonetest1" })).toBeVisible();
    measured = await widths(page);
    expect(measured.scroll).toBeLessThanOrEqual(measured.inner);
  });

  test("record page uses 16px gutters, stacks detail values full-width and keeps chart labels legible", async ({ page }) => {
    await page.goto("/bound");
    await page.getByRole("heading", { name: "Signed writing record" }).waitFor();

    const gutter = await page.locator("main.page-shell").evaluate((element) => getComputedStyle(element).paddingLeft);
    expect(gutter).toBe("16px");

    // The full record hash gets the card's width, not a squeezed second column.
    const hashValue = page.locator("dl.details.mono dd").first();
    const hashBox = await hashValue.boundingBox();
    expect(hashBox.width).toBeGreaterThanOrEqual(250);

    // Quick facts sit in two columns.
    const stats = page.locator(".stats-grid .stat");
    const first = await stats.nth(0).boundingBox();
    const second = await stats.nth(1).boundingBox();
    expect(second.y).toBe(first.y);
    expect(second.x).toBeGreaterThan(first.x);

    // SVG axis labels render at a readable size instead of shrinking with the viewBox.
    const tickLabel = await page.locator("svg.timeline-chart text").first().boundingBox();
    expect(tickLabel.height).toBeGreaterThanOrEqual(9);
    const rhythmLabel = await page.locator("svg.fingerprint-chart text").first().boundingBox();
    expect(rhythmLabel.height).toBeGreaterThanOrEqual(8);
  });
});

test("keyboard focus draws a visible ring on record page links", async ({ page }) => {
  await page.goto("/smoke");
  await page.getByRole("heading", { name: "Signed writing record" }).waitFor();
  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => {
    const element = document.activeElement;
    const style = getComputedStyle(element);
    return { className: element.className, outlineStyle: style.outlineStyle, outlineWidth: parseFloat(style.outlineWidth) };
  });
  expect(focused.className).toContain("eyebrow-home");
  expect(focused.outlineStyle).not.toBe("none");
  expect(focused.outlineWidth).toBeGreaterThan(0);
});

for (const path of ["/docs/privacy/", "/docs/checking-a-document/", "/docs/server-observed-commitments/", "/docs/verification/"]) {
  test(`Hugo ${path} fits a phone viewport`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(path);
    await expect(page.locator("h1")).toBeVisible();
    const measured = await widths(page);
    expect(measured.scroll).toBeLessThanOrEqual(measured.inner);
  });
}
