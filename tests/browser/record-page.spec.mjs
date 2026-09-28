import { expect, test } from "./csp-guard.mjs";

import { BOUND_TEXT } from "./bound-fixture-text.mjs";

const slug = process.env.PMBAH_FIXTURE_SLUG ?? "smoke";

const plaintextFixtures = ["Hi there!", "Hi ther!", " there", "\"Hi\""];

async function openTechnicalDetails(page) {
  await page.locator("details.technical-details > summary").click();
  await expect(page.locator("details.technical-details")).toHaveAttribute("open", "");
}

const region = (page, name) => page.getByRole("region", { name, exact: true });

test.describe("public record page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`/${slug}`);
    await page.getByRole("heading", { name: "Signed writing record" }).waitFor();
  });

  test("header summarizes the process in one descriptive sentence and states its limit once", async ({ page }) => {
    const header = page.locator("header.record-header");
    await expect(header.locator(".record-summary")).toHaveText(
      "Written in under a second (estimated) and published 28 May 2026.",
    );
    await expect(header.locator(".record-limit")).toHaveText("This record shows how the text was edited. How records work");
    const text = (await page.locator("main").innerText()).toLowerCase();
    for (const term of ["human/ai score", "verdict", "humanness", "suspicious", "certificate"]) {
      expect(text.includes(term), `record page leaked evaluative term: ${term}`).toBe(false);
    }
  });

  test("header facts state each measurement once, in plain words", async ({ page }) => {
    const facts = page.locator("header.record-header .record-fact");
    const pairs = await facts.evaluateAll((items) => items.map((item) => [item.querySelector("dt").textContent, item.querySelector("dd").textContent]));
    expect(pairs).toEqual([
      ["Writing time", "under a second"],
      ["Edits", "4"],
      ["Deleted", "1 character"],
      ["Pastes", "1"],
      ["Largest insertion", "6 characters"],
      ["Length", "8 characters"],
    ]);
    await expect(page.getByRole("heading", { name: "Quick facts" })).toHaveCount(0);
    await expect(page.locator(".fingerprint-stats")).toHaveCount(0);
    for (const section of ["header.record-header", "section.edit-timeline"]) await expect(page.locator(section)).not.toContainText("codepoints");
  });

  test("the header says the hash chain was checked here and what the server saw", async ({ page }) => {
    const check = page.locator("header.record-header .record-check");
    await expect(check).toContainText("Hash chain checked in your browser.");
    await expect(check).toContainText("The server received 4 checkpoints over 33 minutes while it was written.");
    await check.getByRole("link", { name: "How it was checked" }).click();
    await expect(page.locator("details.technical-details")).toHaveAttribute("open", "");
    await expect(page.locator(".chain-status.ok")).toBeVisible();
  });

  test("sections follow the reading order, with technical details collapsed last", async ({ page }) => {
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(["Signed writing record"]);
    await expect(page.getByRole("heading", { level: 2 })).toHaveText(["Edit timeline", "Writing rhythm", "Check a document", "Technical details"]);
    await expect(page.locator("details.technical-details")).not.toHaveAttribute("open", "");
    await expect(page.locator("svg.fingerprint-chart")).toBeVisible();
    await expect(page.locator("main svg pattern")).toHaveCount(0);
    await expect(page.locator(".writing-rhythm path.rhythm-curve")).toHaveCount(1);
    await expect(page.locator(".writing-rhythm path.rhythm-area")).toHaveCount(1);
    await expect(page.locator(".writing-rhythm .fp-bin").first()).toHaveAttribute("fill", "transparent");
    await expect(page.locator(".writing-rhythm .section-intro")).toHaveText("How long the writer paused between one edit and the next, and how often.");
    await expect(region(page, "How this was written")).toHaveCount(0);
  });

  test("says nothing about where the text was written", async ({ page }) => {
    await openTechnicalDetails(page);
    await expect(region(page, "Capture context")).toHaveCount(0);
    await expect(page.locator("main")).not.toContainText(/Page title|Major mode|Surface|example\.test/);
  });

  test("renders the edit timeline without document text", async ({ page }) => {
    const timeline = page.locator("section.edit-timeline");
    await expect(timeline).toContainText("Document length over time");
    await expect(timeline).toContainText("Pastes, cuts, and large insertions are marked on the curve");
    const chart = timeline.locator("svg.timeline-chart");
    await expect(chart).toHaveCount(1);
    await expect(chart).toHaveAttribute("role", "img");
    // Only NOTABLE events get a marker dot — pastes, cuts/deletes, drops, large
    // inserts. The fixture has one paste and one cut, so two <circle> markers
    // carry the per-event <title>; the rising curve carries the typing itself.
    const eventDots = chart.locator("circle:has(title)");
    await expect(eventDots).toHaveCount(2);
    await expect(eventDots.first().locator("title")).toContainText("Paste at");
    const html = await page.content();
    for (const plaintext of plaintextFixtures) {
      expect(html.includes(plaintext), `record page leaked plaintext: ${plaintext}`).toBe(false);
    }
  });

  test("renders analyzer signals as facts, not verdicts", async ({ page }) => {
    await openTechnicalDetails(page);
    const signals = region(page, "Analyzer signals");
    await expect(signals).toContainText("timing-distribution");
    await expect(signals).toContainText("Measured 3 inter-event intervals");
    await expect(signals).toContainText("edit-topology");
    await expect(signals).toContainText("revision/dead-end indicator, not a verdict");
    const text = (await signals.innerText()).toLowerCase();
    for (const term of ["humanness score", "certificate of humanity", "percentage human", "ai-written verdict"]) {
      expect(text.includes(term), `analyzer signals leaked verdict-style term: ${term}`).toBe(false);
    }
  });

  test("signature section shows the record hash and the reader's recomputed hash", async ({ page }) => {
    await openTechnicalDetails(page);
    const panel = region(page, "Signature & details");
    await expect(panel).toContainText("Full record hash");
    await expect(panel).toContainText("Computed hash");
    await expect(panel).toContainText("Server metadata");
    const status = panel.locator(".chain-status");
    await expect(status).toHaveClass(/ok/);
    await expect(status).toContainText("reproduce the displayed record hash");
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("labels inferred start separately from upload receipt", async ({ page }) => {
    await page.goto("/tampered");
    await page.getByRole("heading", { name: "Signed writing record" }).waitFor();
    await openTechnicalDetails(page);
    const timing = region(page, "Timing and counts");
    await expect(timing).toContainText("Start inferred from upload and claimed duration");
    await expect(timing).toContainText("Uploaded");
  });

  test("observation status line shows public state copy without overclaim", async ({ page }) => {
    await openTechnicalDetails(page);
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
    await openTechnicalDetails(page);
    const verification = region(page, "Signature & details");
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
    const card = region(page, "Check a document");
    await expect(card).toContainText("No document was bound to this record, so it has no text to check against.");
    await expect(card.getByLabel("document to check")).toHaveCount(0);
  });

  test("renders a footer with the candid tagline and nav", async ({ page }) => {
    const footer = page.locator("footer.record-footer");
    await expect(footer).toContainText("We cannot prove a human wrote it");
    await expect(footer.getByRole("link", { name: "Verify a record" })).toHaveAttribute("href", "/docs/verification/");
  });

  test("labels checkpoint receipt times without calling them writing boundaries", async ({ page }) => {
    await openTechnicalDetails(page);
    const timing = region(page, "Timing and counts");
    await expect(timing).toContainText("First checkpoint received");
    await expect(timing).toContainText("2026-05-28 14:02 UTC");
    await expect(timing).toContainText("Last checkpoint received");
    await expect(timing).toContainText("2026-05-28 14:34 UTC");
  });
});

test.describe("unknown record address", () => {
  test("says plainly that no record exists here and links home", async ({ page }) => {
    const response = await page.goto("/unknown");
    expect(response.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "No record at this address" })).toBeVisible();
    const main = page.locator("main");
    await expect(main).toContainText("No writing record exists at /unknown");
    await expect(main.getByRole("link", { name: "home page" })).toHaveAttribute("href", "/");
    await expect(main).not.toContainText("Record fetch failed");
  });
});

test.describe("tampered record", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/tampered");
    await page.getByRole("heading", { name: "Signed writing record" }).waitFor();
  });

  test("signature section says plainly that the recomputed chain does not match", async ({ page }) => {
    await openTechnicalDetails(page);
    const panel = region(page, "Signature & details");
    const status = panel.locator(".chain-status");
    await expect(status).toHaveClass(/error/);
    await expect(status).toContainText("does not match");
    await expect(panel).toContainText("Computed hash");
  });

  test("the alert's link opens the technical details at the signature section", async ({ page }) => {
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("Recomputing the hash chain from these events does not reproduce the signed record hash, so its contents cannot be trusted.");
    await alert.getByRole("link").click();
    await expect(page.locator("details.technical-details")).toHaveAttribute("open", "");
    const heading = page.getByRole("heading", { name: "Signature & details" });
    await expect(heading).toBeInViewport();
    await expect(heading).toBeFocused();
  });

  test("observation status is shown even when no observation was requested", async ({ page }) => {
    await openTechnicalDetails(page);
    const status = page.getByRole("region", { name: "Observation status" });
    await expect(status).toContainText("No observation requested.");
  });
});

test.describe("record with unknown document length", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/unknownlength");
    await page.getByRole("heading", { name: "Signed writing record" }).waitFor();
  });

  test("timeline does not draw a document-length curve it cannot infer", async ({ page }) => {
    const timeline = page.locator("section.edit-timeline");
    await expect(timeline).toContainText("length is unknown");
    const chart = timeline.locator("svg.timeline-chart");
    await expect(chart.locator("path.length-curve")).toHaveCount(0);
    await expect(chart.locator("text.length-scale")).toHaveCount(0);
    await expect(chart.locator("circle:has(title)")).toHaveCount(2);
    await expect(page.locator(".record-fact").filter({ hasText: "Length" }).locator("dd")).toHaveText("not measured");
  });

  test("header states the unobserved state without naming the tool", async ({ page }) => {
    await expect(page.locator(".record-summary")).not.toContainText("Emacs");
    await expect(page.locator(".record-check")).toContainText("The server received no checkpoints while it was written.");
  });

  test("observation status reports the unobserved state", async ({ page }) => {
    await openTechnicalDetails(page);
    const status = page.getByRole("region", { name: "Observation status" });
    await expect(status).toContainText("Not observed.");
  });

  test("a continuation record links to the record it continues from", async ({ page }) => {
    await openTechnicalDetails(page);
    const panel = region(page, "Signature & details");
    await expect(panel).toContainText("Continues from");
    const link = panel.locator("a.parent-record-link");
    await expect(link).toHaveAttribute("href", /^\/b3:[0-9a-f]{64}$/);
  });
});

test.describe("text binding — bound record", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/bound");
    await page.getByRole("heading", { name: "Signed writing record" }).waitFor();
  });

  test("the document check comes right after the timeline", async ({ page }) => {
    await expect(page.getByRole("heading", { level: 2 })).toHaveText(["Edit timeline", "Writing rhythm", "Check a document", "Technical details"]);
  });

  test("exact paste of the signed text matches as same wording", async ({ page }) => {
    const card = region(page, "Check a document");
    await card.getByLabel("document to check").fill(BOUND_TEXT);
    await card.getByRole("button", { name: "Check" }).click();
    const result = card.locator(".binding-result");
    await expect(result).toHaveClass(/ok/);
    await expect(result).toContainText("Same wording as the signed text.");
    await expect(result).toContainText("ignores spacing, punctuation, case, and number formatting");
    await expect(result).toContainText("not a check of exact text");
  });

  test("appended text reports a prefix match with extra characters", async ({ page }) => {
    const card = region(page, "Check a document");
    await card.getByLabel("document to check").fill(`${BOUND_TEXT}\n\n— recorded at possiblymadebyahuman.com/bound`);
    await card.getByRole("button", { name: "Check" }).click();
    const result = card.locator(".binding-result");
    await expect(result).toHaveClass(/ok/);
    await expect(result).toContainText("Same wording as the signed text");
    await expect(result).toContainText(/\d+ more characters? after it/);
  });

  test("leading over-selection still matches with material before the signed text", async ({ page }) => {
    const card = region(page, "Check a document");
    await card.getByLabel("document to check").fill(`On Tuesday, someone wrote:\n\n${BOUND_TEXT}`);
    await card.getByRole("button", { name: "Check" }).click();
    const result = card.locator(".binding-result");
    await expect(result).toHaveClass(/ok/);
    await expect(result).toContainText(/\d+ more characters? before it/);
    await expect(result).toContainText("ignores spacing, punctuation, case, and number formatting");
  });

  test("different text does not match", async ({ page }) => {
    const card = region(page, "Check a document");
    await card.getByLabel("document to check").fill("Something else entirely, written by another author at another time.");
    await card.getByRole("button", { name: "Check" }).click();
    const result = card.locator(".binding-result");
    await expect(result).toHaveClass(/error/);
    await expect(result).toContainText("don't match");
    await expect(result).toContainText("ignores spacing, punctuation, case, and number formatting");
  });

  test("a match shows an affirmative check mark", async ({ page }) => {
    const card = region(page, "Check a document");
    await card.getByLabel("document to check").fill(BOUND_TEXT);
    await card.getByRole("button", { name: "Check" }).click();
    const result = card.locator(".binding-result");
    await expect(result).toHaveClass(/ok/);
    await expect(result.locator(".binding-result-mark svg")).toHaveCount(1);
    await expect(result).toContainText("Same wording as the signed text.");
  });

  test("editing the box clears a stale result and Check stamps a time", async ({ page }) => {
    const card = region(page, "Check a document");
    const box = card.getByLabel("document to check");
    await box.fill(BOUND_TEXT);
    await card.getByRole("button", { name: "Check" }).click();
    await expect(card.locator(".binding-result")).toBeVisible();
    await expect(card).toContainText("Checked at");
    await box.fill(`${BOUND_TEXT} extra words`);
    await expect(card.locator(".binding-result")).toHaveCount(0);
  });

  test("a check result survives opening the technical details", async ({ page }) => {
    const card = region(page, "Check a document");
    await card.getByLabel("document to check").fill(BOUND_TEXT);
    await card.getByRole("button", { name: "Check" }).click();
    await expect(card.locator(".binding-result")).toHaveClass(/ok/);
    await openTechnicalDetails(page);
    await expect(card.locator(".binding-result")).toHaveClass(/ok/);
  });

  test("the header gives the signed text's size in letters and digits beside the length", async ({ page }) => {
    const facts = page.locator("header.record-header .record-fact");
    const labels = await facts.locator("dt").allTextContents();
    expect(labels.slice(-2)).toEqual(["Length", "Signed text"]);
    await expect(facts.filter({ hasText: "Signed text" }).locator("dd")).toHaveText("95 letters and digits");
    await expect(region(page, "How this was written")).toHaveCount(0);
  });

  test("the document being checked is never sent to the server", async ({ page }) => {
    const marker = "ZZUNIQUECANARYMARKER42";
    const requestLog = [];
    page.on("request", (request) => {
      requestLog.push(`${request.url()} ${request.postData() ?? ""}`);
    });
    const card = region(page, "Check a document");
    await card.getByLabel("document to check").fill(`${BOUND_TEXT} ${marker}`);
    await card.getByRole("button", { name: "Check" }).click();
    await expect(card.locator(".binding-result")).toBeVisible();
    for (const entry of requestLog) {
      expect(entry.includes(marker), `candidate text was sent to the server: ${entry}`).toBe(false);
    }
  });
});

test("unknown size statistics display not measured rather than numeric zero or null", async ({ page, request }) => {
  const record = await (await request.get('/api/records/bound')).json();
  record.stats.largest_atomic_insert_codepoints = null;
  record.signals = [{ analyzer_id: 'edit-topology', analyzer_version: '0.2.0', applicable: true,
    measures: [{ key: 'inserted_codepoints_total', value: null, unit: 'codepoints' }], explanation: 'Required sizes were not captured.' }];
  await page.route('**/api/records/bound', route => route.fulfill({ json: record }));
  await page.goto('/bound');
  await expect(page.locator('.record-fact').filter({ hasText: 'Largest insertion' }).locator('dd')).toHaveText('not measured');
  await expect(page.locator('.record-fact').filter({ hasText: 'Pastes' }).locator('dd')).toHaveText('2');
  await expect(page.locator('.signal-card dd')).toHaveText('not measured');
  await expect(page.locator('main')).not.toContainText(/\bnull\b|unknown codepoints/);
});

for (const tamper of ["events", "binding"]) {
  test(`a tampered ${tamper} record cannot produce a successful document check`, async ({ page, request }) => {
    const record = await (await request.get('/api/records/bound')).json();
    if (tamper === 'events') record.events[0].ins_len += 1;
    else record.manifest.text_binding.canonical_length += 1;
    await page.route('**/api/records/bound', route => route.fulfill({ json: record }));
    await page.goto('/bound');
    await expect(page.getByRole('alert')).toContainText('This record does not verify.');
    const card = page.getByRole('region', { name: 'Check a document', exact: true });
    await expect(card.locator('.check-unavailable')).toContainText('this record does not verify');
    await card.getByLabel('document to check').fill(BOUND_TEXT);
    await expect(card.getByRole('button', { name: 'Check', exact: true })).toBeDisabled();
    await expect(card.locator('.binding-result')).toHaveCount(0);
    await expect(page.locator('.chain-status')).toHaveClass(/error/);
  });
}

test.describe("record page structure", () => {
  test("measure definition buttons are large enough to tap", async ({ page }) => {
    await page.goto("/smoke");
    await page.getByRole("heading", { name: "Signed writing record" }).waitFor();
    await openTechnicalDetails(page);
    const box = await page.locator(".measure-info").first().boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(24);
    expect(box.height).toBeGreaterThanOrEqual(24);
  });

  test("the bare root address does not invent a record slug", async ({ page }) => {
    const requested = [];
    page.on("request", (request) => { if (request.url().includes("/api/records/")) requested.push(request.url()); });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "No record address" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Signed writing record" })).toHaveCount(0);
    expect(requested).toEqual([]);
  });

  test("the browser tab names the record page", async ({ page }) => {
    await page.goto("/smoke");
    await page.getByRole("heading", { name: "Signed writing record" }).waitFor();
    await expect(page).toHaveTitle("Signed writing record · possiblymadebyahuman");
    await page.goto("/unknown");
    await expect(page).toHaveTitle("No record at this address · possiblymadebyahuman");
  });

  test("a failed hash check raises one top-level alert above the header", async ({ page }) => {
    await page.goto("/tampered");
    await page.getByRole("heading", { name: "Signed writing record" }).waitFor();
    const alert = page.getByRole("alert");
    await expect(alert).toHaveCount(1);
    await expect(alert).toContainText("This record does not verify.");
    const alertBox = await alert.boundingBox();
    const headingBox = await page.getByRole("heading", { name: "Signed writing record" }).boundingBox();
    expect(alertBox.y).toBeLessThan(headingBox.y);
    await expect(page.locator(".chain-status.error")).not.toHaveAttribute("role", "status");
  });
});
