import { expect, test } from "@playwright/test";
import { verifyRecord } from "../../packages/format/src/index.ts";

const canaries = ["A🙂B", "A", "🙂"];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
});

test("/write types, signs, shows short URL, and uploads no plaintext", async ({ page }) => {
  const checkpointRequests = [];
  let uploadedPayload;

  await page.route("**/api/observed-sessions/*/checkpoints", async (route) => {
    const request = route.request();
    const body = request.postDataJSON();
    checkpointRequests.push(body);
    const observedSessionId = new URL(request.url()).pathname.split("/").at(-2);
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        observed_session_id: observedSessionId,
        token: "t".repeat(32),
        checkpoint_id: `cp-${checkpointRequests.length}`,
        event_count: body.event_count,
        chain_tip: body.chain_tip,
        server_t: "2026-05-28T00:00:00.000Z",
        created: true,
      }),
    });
  });

  await page.route("**/api/records", async (route) => {
    uploadedPayload = route.request().postDataJSON();
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        record_hash: uploadedPayload.manifest.record_hash,
        short_signature: "writetest1",
        url: "http://127.0.0.1:4173/writetest1",
        created: true,
      }),
    });
  });

  await page.goto("/write");
  const canvas = page.getByRole("textbox", { name: "Writing canvas" });
  await expect(canvas).toBeVisible();
  await canvas.click();
  await page.keyboard.type("A");
  await page.keyboard.insertText("🙂");
  await page.keyboard.type("B");
  await page.getByRole("button", { name: "sign" }).click();

  await expect(page.getByText("open record →")).toBeVisible();
  await expect(page.getByRole("link", { name: "http://127.0.0.1:4173/writetest1" })).toBeVisible();

  expect(uploadedPayload, "record upload payload captured").toBeTruthy();
  expect(verifyRecord({ manifest: uploadedPayload.manifest, events: uploadedPayload.events }).valid).toBe(true);
  expect(uploadedPayload.manifest.capture_context.surface).toBe("web-draft");
  expect(uploadedPayload.observation.observed_session_id).toBeTruthy();
  expect(uploadedPayload.observation.token).toBe("t".repeat(32));

  const serialized = JSON.stringify(uploadedPayload);
  for (const canary of canaries) {
    expect(serialized.includes(canary), `uploaded payload leaked plaintext ${canary}`).toBe(false);
  }
  for (const forbidden of ["final_text_hash", "final_text_length", "ins_hash", "ins_text", "final_text"]) {
    expect(serialized.includes(forbidden), `uploaded payload included ${forbidden}`).toBe(false);
  }
  expect(uploadedPayload.events.some((event) => event.ins_len === 1)).toBe(true);
  expect(checkpointRequests.length).toBeGreaterThanOrEqual(1);
  expect(checkpointRequests[0]).not.toHaveProperty("token");
});

test("/write keeps a failed upload available for retry", async ({ page }) => {
  let uploadAttempts = 0;
  await page.route("**/api/observed-sessions/*/checkpoints", async (route) => {
    const request = route.request();
    const body = request.postDataJSON();
    const observedSessionId = new URL(request.url()).pathname.split("/").at(-2);
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        observed_session_id: observedSessionId,
        token: "r".repeat(32),
        checkpoint_id: "retry-cp",
        event_count: body.event_count,
        chain_tip: body.chain_tip,
        server_t: "2026-05-28T00:00:00.000Z",
        created: true,
      }),
    });
  });
  await page.route("**/api/records", async (route) => {
    uploadAttempts += 1;
    const payload = route.request().postDataJSON();
    if (uploadAttempts === 1) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "temporary_test_failure" }) });
      return;
    }
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        record_hash: payload.manifest.record_hash,
        short_signature: "retrytest1",
        url: "http://127.0.0.1:4173/retrytest1",
        created: true,
      }),
    });
  });

  await page.goto("/write");
  await page.getByRole("textbox", { name: "Writing canvas" }).click();
  await page.keyboard.type("Retry me");
  await page.getByRole("button", { name: "sign" }).click();
  // After a failed upload the mode line shows the short status + the full
  // technical detail is preserved in the title attribute on the error span.
  const errorSpan = page.locator(".ml-error");
  await expect(errorSpan).toBeVisible();
  await expect(errorSpan).toHaveText("upload failed — try again");
  await expect(errorSpan).toHaveAttribute("title", /Upload failed: temporary_test_failure/);
  await page.getByRole("button", { name: "retry" }).click();
  await expect(page.getByRole("link", { name: "http://127.0.0.1:4173/retrytest1" })).toBeVisible();
  expect(uploadAttempts).toBe(2);
});
