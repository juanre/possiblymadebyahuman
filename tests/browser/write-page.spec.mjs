import { expect, test } from "@playwright/test";
import { verifyRecord } from "../../packages/format/src/index.ts";

const canaries = ["A🙂B", "LineOne", "LineTwo", "NEWLINE-CANARY", "🙂"];

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
  await page.getByRole("button", { name: "sign", exact: true }).click();
  await page.getByRole("button", { name: "sign & upload" }).click();

  await expect(page.getByText("open signature →")).toBeVisible();
  await expect(page.getByRole("link", { name: "http://127.0.0.1:4173/writetest1" })).toBeVisible();

  expect(uploadedPayload, "record upload payload captured").toBeTruthy();
  expect(verifyRecord({ manifest: uploadedPayload.manifest, events: uploadedPayload.events }).valid).toBe(true);
  expect(uploadedPayload.manifest.capture_context.surface).toBe("web-draft");
  expect(uploadedPayload.observation.observed_session_id).toBeTruthy();
  expect(uploadedPayload.observation.token).toBe("t".repeat(32));

  // bind-by-default sealed a content-blind text binding into the record.
  expect(uploadedPayload.manifest.format_version).toBe("0.2");
  expect(uploadedPayload.manifest.text_binding).toBeTruthy();
  expect(uploadedPayload.manifest.text_binding.scheme).toBe("canon-letters/0.1");
  expect(uploadedPayload.manifest.text_binding).not.toHaveProperty("policy");
  // "A🙂B" canonicalizes to "ab" (emoji dropped, casefolded) -> 2 codepoints.
  expect(uploadedPayload.manifest.text_binding.canonical_length).toBe(2);

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

test("/write captures Enter as a one-codepoint line break event", async ({ page }) => {
  let uploadedPayload;

  await page.route("**/api/observed-sessions/*/checkpoints", async (route) => {
    const request = route.request();
    const body = request.postDataJSON();
    const observedSessionId = new URL(request.url()).pathname.split("/").at(-2);
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        observed_session_id: observedSessionId,
        token: "n".repeat(32),
        checkpoint_id: `newline-cp-${body.event_count}`,
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
        short_signature: "newline1",
        url: "http://127.0.0.1:4173/newline1",
        created: true,
      }),
    });
  });

  await page.goto("/write");
  const canvas = page.getByRole("textbox", { name: "Writing canvas" });
  await canvas.click();
  await page.keyboard.type("LineOne");
  await page.keyboard.press("Enter");
  await page.keyboard.type("LineTwo");
  await page.getByRole("button", { name: "sign", exact: true }).click();
  await page.getByRole("button", { name: "sign & upload" }).click();
  await expect(page.getByRole("link", { name: "http://127.0.0.1:4173/newline1" })).toBeVisible();

  expect(uploadedPayload, "record upload payload captured").toBeTruthy();
  expect(verifyRecord({ manifest: uploadedPayload.manifest, events: uploadedPayload.events }).valid).toBe(true);
  const newlineEvent = uploadedPayload.events.find((event) => event.op === "insert" && event.pos === 7 && event.del_len === 0 && event.ins_len === 1);
  expect(newlineEvent, "line break event should be recorded as +1 at codepoint 7").toBeTruthy();
  expect(newlineEvent.source).toBe("typing");
  expect(uploadedPayload.events.length).toBe(15);

  const serialized = JSON.stringify(uploadedPayload);
  for (const canary of ["LineOne", "LineTwo", "NEWLINE-CANARY"]) {
    expect(serialized.includes(canary), `uploaded payload leaked plaintext ${canary}`).toBe(false);
  }
  for (const forbidden of ["final_text_hash", "final_text_length", "ins_hash", "ins_text", "final_text"]) {
    expect(serialized.includes(forbidden), `uploaded payload included ${forbidden}`).toBe(false);
  }
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
  await page.getByRole("button", { name: "sign", exact: true }).click();
  await page.getByRole("button", { name: "sign & upload" }).click();
  // After a failed upload the mode line shows the short status + the full
  // technical detail is preserved in the title attribute on the error span.
  const errorSpan = page.locator(".ml-error");
  await expect(errorSpan).toBeVisible();
  await expect(errorSpan).toHaveText("upload failed, try again");
  await expect(errorSpan).toHaveAttribute("title", /Upload failed: temporary_test_failure/);
  await page.getByRole("button", { name: "retry" }).click();
  await expect(page.getByRole("link", { name: "http://127.0.0.1:4173/retrytest1" })).toBeVisible();
  expect(uploadAttempts).toBe(2);
});

test("/write can sign the process only, binding no document", async ({ page }) => {
  let uploadedPayload;
  await page.route("**/api/observed-sessions/*/checkpoints", async (route) => {
    const request = route.request();
    const body = request.postDataJSON();
    const observedSessionId = new URL(request.url()).pathname.split("/").at(-2);
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        observed_session_id: observedSessionId,
        token: "o".repeat(32),
        checkpoint_id: "optout-cp",
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
        short_signature: "optout1",
        url: "http://127.0.0.1:4173/optout1",
        created: true,
      }),
    });
  });

  await page.goto("/write");
  await page.getByRole("textbox", { name: "Writing canvas" }).click();
  await page.keyboard.type("Process only, no binding here.");
  await page.getByRole("button", { name: "sign", exact: true }).click();
  await page.getByRole("checkbox").uncheck();
  await page.getByRole("button", { name: "sign & upload" }).click();
  await expect(page.getByRole("link", { name: "http://127.0.0.1:4173/optout1" })).toBeVisible();

  expect(uploadedPayload.manifest.text_binding, "process-only sign must not bind a document").toBeUndefined();
  expect(verifyRecord({ manifest: uploadedPayload.manifest, events: uploadedPayload.events }).valid).toBe(true);
});

test("/write keeps your writing after signing and offers to copy it", async ({ page }) => {
  await page.route("**/api/observed-sessions/*/checkpoints", async (route) => {
    const body = route.request().postDataJSON();
    const observedSessionId = new URL(route.request().url()).pathname.split("/").at(-2);
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ observed_session_id: observedSessionId, token: "k".repeat(32), checkpoint_id: "keep-cp", event_count: body.event_count, chain_tip: body.chain_tip, server_t: "2026-05-28T00:00:00.000Z", created: true }),
    });
  });
  await page.route("**/api/records", async (route) => {
    const payload = route.request().postDataJSON();
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ record_hash: payload.manifest.record_hash, short_signature: "keeptext1", url: "http://127.0.0.1:4173/keeptext1", created: true }) });
  });

  await page.goto("/write");
  await expect(page.locator(".write-modeline")).toContainText("idle");
  await page.keyboard.type("My precious writing.");
  await page.getByRole("button", { name: "sign", exact: true }).click();
  await page.getByRole("button", { name: "sign & upload" }).click();
  await expect(page.getByText("open signature →")).toBeVisible();

  // Signing must NOT wipe the canvas; the writer keeps their words.
  await expect(page.getByRole("textbox", { name: "Writing canvas" })).toHaveValue("My precious writing.");
  // And there is a button to copy the writing to the clipboard.
  await expect(page.getByRole("button", { name: "copy text" })).toBeVisible();
});

test("/write focuses the canvas on load so you can type without clicking", async ({ page }) => {
  await page.goto("/write");
  // Wait for the local session to be ready (modeline reads "idle"); the app
  // puts the cursor in the canvas on ready. Then typing with no click must
  // land in the canvas.
  await expect(page.locator(".write-modeline")).toContainText("idle");
  await page.keyboard.type("hello");
  await expect(page.getByRole("textbox", { name: "Writing canvas" })).toHaveValue("hello");
});

test("/write shows its status message on the page, including why an upload failed", async ({ page }) => {
  await page.route("**/api/observed-sessions/*/checkpoints", async (route) => {
    const body = route.request().postDataJSON();
    const observedSessionId = new URL(route.request().url()).pathname.split("/").at(-2);
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ observed_session_id: observedSessionId, token: "m".repeat(32), checkpoint_id: "message-cp", event_count: body.event_count, chain_tip: body.chain_tip, server_t: "2026-05-28T00:00:00.000Z", created: true }),
    });
  });
  await page.route("**/api/records", async (route) => {
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "temporary_test_failure" }) });
  });

  await page.goto("/write");
  const message = page.getByRole("status", { name: "Drafting message" });
  await expect(message).toBeVisible();
  await expect(message).toContainText("Text stays in this browser");

  await page.getByRole("textbox", { name: "Writing canvas" }).click();
  await page.keyboard.type("Say it out loud");
  await expect(message).toContainText("Capturing content-blind edit events locally.");
  await page.getByRole("button", { name: "sign", exact: true }).click();
  await page.getByRole("button", { name: "sign & upload" }).click();
  // The full reason is readable on the page, not only in a hover title.
  await expect(message).toBeVisible();
  await expect(message).toContainText("Upload failed: temporary_test_failure");
  await expect(page.locator(".ml-error")).toHaveText("upload failed, try again");
});

test("/write uploads a diverged session as unobserved and says so on the page", async ({ page }) => {
  let checkpointCalls = 0;
  let uploadedPayload;
  await page.route("**/api/observed-sessions/*/checkpoints", async (route) => {
    checkpointCalls += 1;
    const body = route.request().postDataJSON();
    const observedSessionId = new URL(route.request().url()).pathname.split("/").at(-2);
    if (checkpointCalls > 1) {
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "checkpoint_conflict" }) });
      return;
    }
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ observed_session_id: observedSessionId, token: "d".repeat(32), checkpoint_id: "diverge-cp", event_count: body.event_count, chain_tip: body.chain_tip, server_t: "2026-05-28T00:00:00.000Z", created: true }),
    });
  });
  await page.route("**/api/records", async (route) => {
    uploadedPayload = route.request().postDataJSON();
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ record_hash: uploadedPayload.manifest.record_hash, short_signature: "diverged1", url: "http://127.0.0.1:4173/diverged1", created: true }) });
  });

  await page.goto("/write");
  const message = page.getByRole("status", { name: "Drafting message" });
  await page.getByRole("textbox", { name: "Writing canvas" }).click();
  // Enough events for a second checkpoint under any interleaving: either the
  // events queued behind the first one, or the 50-event cadence after it.
  await page.keyboard.type("The server will reject every checkpoint after the first one it sees");
  await expect.poll(() => checkpointCalls).toBeGreaterThanOrEqual(2);
  await page.getByRole("button", { name: "sign", exact: true }).click();
  await page.getByRole("button", { name: "sign & upload" }).click();

  await expect(page.getByRole("link", { name: "http://127.0.0.1:4173/diverged1" })).toBeVisible();
  await expect(message).toContainText("server observation");
  await expect(message).toContainText("diverged");
  expect(uploadedPayload.observation).toEqual({ state: "unobserved" });
});

test("/write retries an upload rejected with observation_mismatch as unobserved and says so", async ({ page }) => {
  const uploads = [];
  await page.route("**/api/observed-sessions/*/checkpoints", async (route) => {
    const body = route.request().postDataJSON();
    const observedSessionId = new URL(route.request().url()).pathname.split("/").at(-2);
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ observed_session_id: observedSessionId, token: "x".repeat(32), checkpoint_id: `mismatch-cp-${body.event_count}`, event_count: body.event_count, chain_tip: body.chain_tip, server_t: "2026-05-28T00:00:00.000Z", created: true }),
    });
  });
  await page.route("**/api/records", async (route) => {
    const payload = route.request().postDataJSON();
    uploads.push(payload);
    if (uploads.length === 1) {
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "observation_mismatch", details: ["checkpoint mismatch-cp-1 does not match final record prefix"] }) });
      return;
    }
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ record_hash: payload.manifest.record_hash, short_signature: "mismatch1", url: "http://127.0.0.1:4173/mismatch1", created: true }) });
  });

  await page.goto("/write");
  const message = page.getByRole("status", { name: "Drafting message" });
  await page.getByRole("textbox", { name: "Writing canvas" }).click();
  await page.keyboard.type("Bound once, then unobserved");
  await page.getByRole("button", { name: "sign", exact: true }).click();
  await page.getByRole("button", { name: "sign & upload" }).click();
  await expect(message).toContainText("Upload failed: observation_mismatch");
  expect(uploads[0].observation.token).toBe("x".repeat(32));

  await page.getByRole("button", { name: "retry" }).click();
  await expect(page.getByRole("link", { name: "http://127.0.0.1:4173/mismatch1" })).toBeVisible();
  await expect(message).toContainText("server observation");
  await expect(message).toContainText("diverged");
  expect(uploads.length).toBe(2);
  expect(uploads[1].observation).toEqual({ state: "unobserved" });
});

test("/write explains on the empty canvas that text stays here and only the shape of editing is recorded", async ({ page }) => {
  await page.goto("/write");
  const canvas = page.getByRole("textbox", { name: "Writing canvas" });
  await expect(canvas).toHaveAttribute("placeholder", /stays in this browser/);
  await expect(canvas).toHaveAttribute("placeholder", /shape of the editing/);
  await expect(canvas).toHaveAttribute("placeholder", /recorded/);
});
