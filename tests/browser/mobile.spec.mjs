import { mockRecordUpload } from "./journal-fixtures.mjs";
import { expect, test } from "./csp-guard.mjs";

async function widths(page) {
  return page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
}

test.describe("phone viewport", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  for (const path of ["/smoke", "/bound", "/tampered", "/unknownlength"]) {
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
    await expect(page.getByRole("textbox", { name: "Writing canvas" })).toBeFocused();
    let measured = await widths(page);
    expect(measured.scroll).toBeLessThanOrEqual(measured.inner);

    await page.keyboard.type("Written on a phone.");
    await page.getByRole("button", { name: "Sign", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Sign and publish this draft?" })).toBeVisible();
    measured = await widths(page);
    expect(measured.scroll).toBeLessThanOrEqual(measured.inner);

    await page.getByRole("button", { name: "Sign & publish" }).click();
    await expect(page.getByRole("textbox", { name: "Record link" })).toHaveValue("http://127.0.0.1:4173/phonetest1");
    measured = await widths(page);
    expect(measured.scroll).toBeLessThanOrEqual(measured.inner);
  });

  test("record page uses 16px gutters, stacks detail values full-width and keeps chart labels legible", async ({ page }) => {
    await page.goto("/bound");
    await page.getByRole("heading", { name: "Signed writing record" }).waitFor();

    const gutter = await page.locator("main.page-shell").evaluate((element) => getComputedStyle(element).paddingLeft);
    expect(gutter).toBe("16px");

    // Header facts sit in two columns.
    const facts = page.locator(".record-fact");
    const first = await facts.nth(0).boundingBox();
    const second = await facts.nth(1).boundingBox();
    expect(second.y).toBe(first.y);
    expect(second.x).toBeGreaterThan(first.x);

    // The edit timeline spans the column between the 16px gutters.
    const chart = await page.locator("svg.timeline-chart").boundingBox();
    expect(chart.x).toBeCloseTo(16, 0);
    expect(chart.width).toBeCloseTo(375 - 32, 0);

    // SVG axis labels render at a readable size instead of shrinking with the viewBox.
    const tickLabel = await page.locator("svg.timeline-chart text").first().boundingBox();
    expect(tickLabel.height).toBeGreaterThanOrEqual(9);

    await page.locator("details.technical-details > summary").click();
    // The full record hash gets the column's width, not a squeezed second column.
    const hashValue = page.locator("dl.manifest-details dd").first();
    const hashBox = await hashValue.boundingBox();
    expect(hashBox.width).toBeGreaterThanOrEqual(250);
    // The chart re-measures its width once the disclosure opens.
    await expect.poll(async () => (await page.locator("svg.fingerprint-chart text").first().boundingBox()).height).toBeGreaterThanOrEqual(8);
    const measured = await widths(page);
    expect(measured.scroll).toBeLessThanOrEqual(measured.inner);
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
  expect(focused.className).toContain("record-home");
  expect(focused.outlineStyle).not.toBe("none");
  expect(focused.outlineWidth).toBeGreaterThan(0);
});

for (const path of ["/docs/browser-extension/", "/docs/privacy/", "/docs/checking-a-document/", "/docs/server-observed-commitments/", "/docs/verification/"]) {
  test(`Hugo ${path} fits a phone viewport`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(path);
    await expect(page.locator("h1")).toBeVisible();
    const measured = await widths(page);
    expect(measured.scroll).toBeLessThanOrEqual(measured.inner);
  });
}

test.describe("analyzer measures on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("long measure names wrap instead of running into their values", async ({ page, request }) => {
    const record = await (await request.get("/api/records/smoke")).json();
    record.signals[1].measures.push(
      { key: "unknown_process_measurement_count", value: 0 },
      { key: "large_atomic_insert_threshold_codepoints", value: 50, unit: "codepoints" },
      { key: "revision_deleted_codepoint_ratio", value: 0.3144 },
    );
    await page.route("**/api/records/smoke", route => route.fulfill({ json: record }));
    await page.goto("/smoke");
    await page.locator("details.technical-details > summary").click();
    const rows = await page.locator("dl.measure-grid dt").evaluateAll(terms => terms.map(term => {
      const value = term.nextElementSibling;
      const name = term.getBoundingClientRect();
      const box = value.getBoundingClientRect();
      return { text: term.textContent, nameRight: name.right, scrollWidth: term.scrollWidth, clientWidth: term.clientWidth, valueLeft: box.left };
    }));
    expect(rows.length).toBeGreaterThan(8);
    for (const row of rows) {
      expect(row.scrollWidth, `${row.text} overflows its column`).toBeLessThanOrEqual(row.clientWidth);
      expect(row.nameRight, `${row.text} runs into its value`).toBeLessThanOrEqual(row.valueLeft);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
