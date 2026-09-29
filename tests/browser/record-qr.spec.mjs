import { readFile } from "node:fs/promises";
import jsQR from "jsqr";
import { expect, test } from "./csp-guard.mjs";

const slug = process.env.PMBAH_FIXTURE_SLUG ?? "smoke";

// Draws the page's own QR path onto a canvas and returns its pixels.
async function shownCodePixels(page) {
  return page.locator(".record-qr svg").evaluate((svg) => {
    const size = svg.viewBox.baseVal.width, scale = 4;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size * scale;
    const context = canvas.getContext("2d");
    context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height);
    context.scale(scale, scale); context.fillStyle = "#000";
    context.fill(new Path2D(svg.querySelector("path").getAttribute("d")));
    return { size: canvas.width, data: Array.from(context.getImageData(0, 0, canvas.width, canvas.width).data) };
  });
}

test("the record page offers a QR code that opens this record", async ({ page, baseURL }) => {
  await page.goto(`/${slug}`);
  const address = `${baseURL}/${slug}`;
  const panel = page.locator("details.record-qr");
  await expect(panel.locator("svg")).toBeHidden();
  await panel.getByText("QR code for this record").click();
  await expect(panel.getByRole("img", { name: `QR code for ${address}` })).toBeVisible();
  await expect(panel.locator(".record-qr-url")).toHaveText(address);
  const { size, data } = await shownCodePixels(page);
  expect(jsQR(new Uint8ClampedArray(data), size, size)?.data).toBe(address);

  const [svgDownload] = await Promise.all([page.waitForEvent("download"), panel.getByRole("button", { name: "Download SVG" }).click()]);
  expect(svgDownload.suggestedFilename()).toBe(`possiblymadebyahuman-${slug}.svg`);
  expect(await readFile(await svgDownload.path(), "utf8")).toContain(`<title>${address}</title>`);
  const [pngDownload] = await Promise.all([page.waitForEvent("download"), panel.getByRole("button", { name: "Download PNG" }).click()]);
  expect(pngDownload.suggestedFilename()).toBe(`possiblymadebyahuman-${slug}.png`);
  const png = await readFile(await pngDownload.path());
  expect(png.subarray(1, 4).toString()).toBe("PNG");
});

test("the QR code addresses the record, not the query or fragment the reader arrived with", async ({ page, baseURL }) => {
  await page.goto(`/${slug}/?utm_source=mail#check-a-document`);
  await page.locator("details.record-qr").getByText("QR code for this record").click();
  await expect(page.locator(".record-qr-url")).toHaveText(`${baseURL}/${slug}`);
});
