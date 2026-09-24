import { expect, test } from "@playwright/test";
import {
  advanceEventHash,
  sealRecordHash,
  createTextBinding,
} from "../../packages/format/src/index.ts";
import { analyzeEventLog } from "../../packages/analyzers/src/streaming.ts";

async function pagedFixture(
  page,
  request,
  { tamper = false, failOnce = false } = {},
) {
  const small = await (await request.get("/api/records/bound")).json();
  const count = 9000;
  const events = Array.from({ length: count }, (_, seq) => ({
    seq,
    t: seq * 100,
    op: "insert",
    pos: seq,
    del_len: 0,
    ins_len: 1,
    source: "typing",
  }));
  const tips = [];
  let tip = null;
  const manifest = {
    ...small.manifest,
    format_version: "0.3",
    event_count: count,
    duration_ms: count * 100,
    text_binding: createTextBinding(
      "bounded reader",
      small.manifest.session_id,
    ),
  };
  for (const event of events) {
    tip = advanceEventHash(
      tip,
      event,
      manifest.session_id,
      manifest.format_version,
    );
    tips.push(tip);
  }
  manifest.record_hash = sealRecordHash(
    tip,
    manifest.format_version,
    manifest.text_binding,
    manifest,
  );
  const derived = analyzeEventLog(events, manifest);
  const summary = {
    manifest,
    ...derived,
    observation: {
      state: "unobserved",
      observed_session_id: null,
      commitments: [],
      checkpoint_count: 0,
      first_observed_at: null,
      last_observed_at: null,
      server_observed_span_ms: null,
    },
    first_event_t: 0,
    last_event_t: events.at(-1).t,
  };
  let requests = 0;
  await page.route("**/api/records/long-session", (route) =>
    route.fulfill({
      status: 409,
      json: { error: "chunked_record_requires_pagination" },
    }),
  );
  await page.route("**/api/records/long-session/summary", (route) =>
    route.fulfill({ json: summary }),
  );
  await page.route("**/api/records/*/events?*", (route) => {
    requests++;
    const url = new URL(route.request().url());
    const offset = Number(url.searchParams.get("offset"));
    const limit = Number(url.searchParams.get("limit"));
    expect(limit).toBeLessThanOrEqual(4096);
    if (failOnce && offset > 0) {
      failOnce = false;
      return route.fulfill({ status: 503, json: { error: "temporary" } });
    }
    const batch = events
      .slice(offset, offset + limit)
      .map((event) => ({ ...event }));
    if (tamper && offset === 0) batch[100].ins_len = 2;
    const next = offset + batch.length;
    return route.fulfill({
      json: {
        events: batch,
        total_events: count,
        next_offset: next === count ? null : next,
        chain_tip_before: tips[offset - 1] ?? null,
        chain_tip_after: tips[next - 1],
      },
    });
  });
  return { requests: () => requests };
}

test("large record loads summary without events and verifies in bounded worker pages before allowing document checks", async ({
  page,
  request,
}) => {
  const fixture = await pagedFixture(page, request);
  await page.goto("/long-session");
  await expect(
    page.getByRole("heading", { name: "Signed writing record" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Verify full record", exact: true }),
  ).toBeVisible();
  expect(fixture.requests()).toBe(0);
  await expect(page.locator(".chain-status")).toContainText(
    "not been downloaded",
  );
  await page
    .getByRole("button", { name: "Verify full record", exact: true })
    .click();
  await expect(page.locator(".chain-status")).toHaveClass(/ok/);
  expect(fixture.requests()).toBe(3);
  await expect(
    page.getByRole("img", {
      name: "Verified editing activity across the full record",
    }),
  ).toBeVisible();
  expect(
    await page
      .locator(
        'svg[aria-label="Verified editing activity across the full record"] rect',
      )
      .count(),
  ).toBe(128);
});

test("tampered paged events never produce a verified binding or overview", async ({
  page,
  request,
}) => {
  await pagedFixture(page, request, { tamper: true });
  await page.goto("/long-session");
  await page
    .getByRole("button", { name: "Verify full record", exact: true })
    .click();
  await expect(page.locator(".chain-status")).toHaveClass(/error/);
  await expect(page.locator(".chain-status")).toContainText("hash");
  await expect(
    page.getByRole("img", {
      name: "Verified editing activity across the full record",
    }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Document checking is unavailable", { exact: false }),
  ).toBeVisible();
});

test("failed page download can retry without mistaking a verified prefix for a complete record", async ({
  page,
  request,
}) => {
  await pagedFixture(page, request, { failOnce: true });
  await page.goto("/long-session");
  await page
    .getByRole("button", { name: "Verify full record", exact: true })
    .click();
  await expect(page.locator(".chain-status")).toContainText(
    "could not be loaded",
  );
  await page
    .getByRole("button", { name: "Verify full record", exact: true })
    .click();
  await expect(page.locator(".chain-status")).toHaveClass(/ok/);
});
