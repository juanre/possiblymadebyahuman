import { expect, test } from "@playwright/test";

import { BOUND_TEXT } from "./bound-fixture-text.mjs";

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
    await expect(timeline).toContainText("Document length and event activity over time");
    await expect(timeline).toContainText("Bars above the curve are events colored by source");
    const chart = timeline.locator("svg.timeline-chart");
    await expect(chart).toHaveCount(1);
    await expect(chart).toHaveAttribute("role", "img");
    // One <rect> tick per timeline event (the fixture commits 4 events).
    // Pause bands are drawn first and would also count as <rect>, so filter
    // by <title> children which only the per-event ticks carry.
    const eventTicks = chart.locator("rect:has(title)");
    await expect(eventTicks).toHaveCount(4);
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

  test("a record with no binding shows the no-binding state", async ({ page }) => {
    const card = page.locator("section.card", { hasText: "Document binding" });
    await expect(card).toContainText("No document was bound to this record.");
  });
});

test.describe("text binding — bound record", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/bound");
    await page.getByRole("heading", { name: "Writing record" }).waitFor();
  });

  test("exact paste of the signed text matches as same wording", async ({ page }) => {
    const card = page.locator("section.card", { hasText: "Check a document" });
    await card.getByLabel("document to check").fill(BOUND_TEXT);
    await card.getByRole("button", { name: "Check" }).click();
    const result = card.locator(".binding-result");
    await expect(result).toHaveClass(/ok/);
    await expect(result).toContainText("Same wording as the signed text.");
    await expect(result).toContainText("not a check of exact text");
  });

  test("appended text reports a prefix match with extra characters", async ({ page }) => {
    const card = page.locator("section.card", { hasText: "Check a document" });
    await card.getByLabel("document to check").fill(`${BOUND_TEXT}\n\n— recorded at possiblymadebyahuman.com/bound`);
    await card.getByRole("button", { name: "Check" }).click();
    const result = card.locator(".binding-result");
    await expect(result).toHaveClass(/ok/);
    await expect(result).toContainText("Same wording as the signed text");
    await expect(result).toContainText(/\d+ more characters? after it/);
  });

  test("leading over-selection still matches with material before the signed text", async ({ page }) => {
    const card = page.locator("section.card", { hasText: "Check a document" });
    await card.getByLabel("document to check").fill(`On Tuesday, someone wrote:\n\n${BOUND_TEXT}`);
    await card.getByRole("button", { name: "Check" }).click();
    const result = card.locator(".binding-result");
    await expect(result).toHaveClass(/ok/);
    await expect(result).toContainText(/\d+ more characters? before it/);
    await expect(result).toContainText("not a check of exact text");
  });

  test("different text does not match", async ({ page }) => {
    const card = page.locator("section.card", { hasText: "Check a document" });
    await card.getByLabel("document to check").fill("Something else entirely, written by another author at another time.");
    await card.getByRole("button", { name: "Check" }).click();
    const result = card.locator(".binding-result");
    await expect(result).toHaveClass(/error/);
    await expect(result).toContainText("don't match");
    await expect(result).toContainText("not a check of exact text");
  });

  test("commensurability is a separate card with facts, not a verdict", async ({ page }) => {
    const card = page.locator("section.card", { hasText: "How this was written" });
    await expect(card).toContainText("Signed text");
    await expect(card).toContainText("Writing process");
    await expect(card).toContainText("yours to read");
    const text = (await card.innerText()).toLowerCase();
    for (const term of ["verified", "humanness", "score", "authentic"]) {
      expect(text.includes(term), `commensurability card leaked verdict term: ${term}`).toBe(false);
    }
  });

  test("the document being checked is never sent to the server", async ({ page }) => {
    const marker = "ZZUNIQUECANARYMARKER42";
    const requestLog = [];
    page.on("request", (request) => {
      requestLog.push(`${request.url()} ${request.postData() ?? ""}`);
    });
    const card = page.locator("section.card", { hasText: "Check a document" });
    await card.getByLabel("document to check").fill(`${BOUND_TEXT} ${marker}`);
    await card.getByRole("button", { name: "Check" }).click();
    await expect(card.locator(".binding-result")).toBeVisible();
    for (const entry of requestLog) {
      expect(entry.includes(marker), `candidate text was sent to the server: ${entry}`).toBe(false);
    }
  });
});
