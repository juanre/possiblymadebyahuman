import { expect, test } from "@playwright/test";

const slug = process.env.PMBAH_FIXTURE_SLUG ?? "smoke";

const plaintextFixtures = ["Hi there!", "Hi ther!", " there", "\"Hi\""];

test.describe("public record page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`/${slug}`);
    await page.getByRole("heading", { name: "Writing record" }).waitFor();
  });

  test("renders the standing disclaimer as a signed-record statement", async ({ page }) => {
    const banner = page.getByRole("region", { name: "What this record means" });
    await expect(banner).toContainText("This is a signed writing record.");
    await expect(banner).not.toContainText("This is a writing record, not a verdict.");
    await expect(banner).toContainText("not a human/AI score");
  });

  test("shows browser.title and emacs.major_mode in capture context", async ({ page }) => {
    const card = page.locator("section.card", { hasText: "Capture context" });
    await expect(card).toContainText("Page title");
    await expect(card).toContainText("Smoke Test Page Title");
    await expect(card).toContainText("Major mode");
    await expect(card).toContainText("markdown-mode");
  });

  test("renders the edit timeline without document text", async ({ page }) => {
    const timeline = page.locator("section.card", { hasText: "Edit timeline" });
    await expect(timeline).toContainText("Operation shape only");
    await expect(timeline).toContainText("No text is stored");
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

  test("observation status line shows public state copy without overclaim", async ({ page }) => {
    const status = page.getByRole("region", { name: "Observation status" });
    await expect(status).toContainText("Server observed checkpoints.");
    await expect(status).toContainText("2026-05-28 14:02 UTC");
    await expect(status).toContainText("2026-05-28 14:34 UTC");
    await expect(status).toContainText("The last commitment covered the final 4 events.");
    await expect(status).toContainText("Server-observed span: 33 minutes.");
    const text = (await status.innerText()).toLowerCase();
    for (const term of ["proof of authorship", "proves who", "active writing time", "continuous typing", "humanness"]) {
      expect(text.includes(term), `observation status leaked overclaim: ${term}`).toBe(false);
    }
  });

  test("server-observed commitments list discloses every chain tip via title attribute", async ({ page }) => {
    const verification = page.locator("section.card", { hasText: "Verification" });
    await expect(verification).toContainText("Server metadata");
    await expect(verification).not.toContainText("Attestations");
    const details = verification.locator("details.observation-commitments");
    await details.locator("summary").click();
    await expect(details).toContainText("4 server-observed commitments");
    const items = details.locator(".observation-commitment");
    await expect(items).toHaveCount(4);
    await expect(items.first()).toContainText("1 event");
    await expect(items.last()).toContainText("4 events");
    // Truncated chain-tip display + full hash discoverable on hover via title attr.
    const fullHash = "b3:7c4a000000000000000000000000000000000000000000000000000000000abc";
    const titles = await items.locator(".commitment-chain").evaluateAll((els) => els.map((el) => el.getAttribute("title")));
    expect(titles).toContain(fullHash);
    // ISO instant must remain on the <time> element so screen readers and machine
    // consumers get the canonical timestamp without relying on the truncated label.
    const datetimes = await items.locator("time.utc-instant").evaluateAll((els) => els.map((el) => el.getAttribute("datetime")));
    expect(datetimes).toContain("2026-05-28T14:34:55.000Z");
  });
});
