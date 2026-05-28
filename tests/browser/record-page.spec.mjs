import { expect, test } from "@playwright/test";

const slug = process.env.PMBAH_FIXTURE_SLUG ?? "smoke";

const plaintextFixtures = ["Hi there!", "Hi ther!", " there", "\"Hi\""];

test.describe("public record page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`/${slug}`);
    await page.getByRole("heading", { name: "Writing record" }).waitFor();
  });

  test("renders the standing disclaimer as a non-verdict statement", async ({ page }) => {
    const banner = page.getByRole("region", { name: "What this record means" });
    await expect(banner).toContainText("This is a writing record, not a verdict.");
    await expect(banner).toContainText("not a human/AI score");
  });

  test("shows browser.title and emacs.major_mode in capture context", async ({ page }) => {
    const card = page.locator("section.card", { hasText: "Capture context" });
    await expect(card).toContainText("Page title");
    await expect(card).toContainText("Smoke Test Page Title");
    await expect(card).toContainText("Major mode");
    await expect(card).toContainText("markdown-mode");
  });

  test("renders content-blind replay without document plaintext", async ({ page }) => {
    const replay = page.locator("section.card", { hasText: "Content-blind replay" });
    await expect(replay).toContainText("Structure only");
    await expect(replay).toContainText("No text is rendered.");
    await expect(page.locator(".timeline .timeline-row")).toHaveCount(4);
    const html = await page.content();
    for (const plaintext of plaintextFixtures) {
      expect(html.includes(plaintext), `record page leaked plaintext: ${plaintext}`).toBe(false);
    }
  });

  test("renders analyzer signals as facts, not verdicts", async ({ page }) => {
    const signals = page.locator("section.card", { hasText: "Analyzer signals as facts" });
    await expect(signals).toContainText("timing-distribution");
    await expect(signals).toContainText("Measured 3 inter-event intervals");
    await expect(signals).toContainText("edit-topology");
    await expect(signals).toContainText("revision/dead-end indicator, not a verdict");
    const text = (await signals.innerText()).toLowerCase();
    for (const term of ["humanness score", "certificate of humanity", "percentage human", "ai-written verdict"]) {
      expect(text.includes(term), `analyzer signals leaked verdict-style term: ${term}`).toBe(false);
    }
  });

  test("verification panel reaches success state after Re-verify chain", async ({ page }) => {
    const verification = page.locator("section.card", { hasText: "Verification" });
    await expect(verification).toContainText("Hash chain verified against the full record hash.");
    const button = verification.getByRole("button", { name: "Re-verify chain" });
    await button.click();
    await expect(verification).toContainText("Hash chain verified against the full record hash.");
    await expect(verification).toContainText("Full record hash");
    await expect(verification).toContainText("Computed hash");
  });
});
