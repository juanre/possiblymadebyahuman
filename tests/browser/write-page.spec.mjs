import { mockRecordUpload, readWriteSessions, installJournalFailure } from "./journal-fixtures.mjs";
import { expect, test } from "@playwright/test";
import { verifyRecord } from "../../packages/format/src/index.ts";

const canaries = ["A🙂B", "LineOne", "LineTwo", "NEWLINE-CANARY", "🙂"];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem('pmbah-test-initialized')) {
      window.localStorage.clear();
      window.sessionStorage.setItem('pmbah-test-initialized', 'true');
    }
  });
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

  await mockRecordUpload(page, async (route) => {
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

  await expect(page.getByText("open record →")).toBeVisible();
  await expect(page.getByRole("link", { name: "http://127.0.0.1:4173/writetest1" })).toBeVisible();

  expect(uploadedPayload, "record upload payload captured").toBeTruthy();
  expect(verifyRecord({ manifest: uploadedPayload.manifest, events: uploadedPayload.events }).valid).toBe(true);
  expect(uploadedPayload.manifest.capture_context.surface).toBe("web-draft");
  expect(uploadedPayload.observation.observed_session_id).toBeTruthy();
  expect(uploadedPayload.observation.token).toBe("t".repeat(32));

  // bind-by-default sealed a content-blind text binding into the record.
  expect(uploadedPayload.manifest.format_version).toBe("0.3");
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

  await mockRecordUpload(page, async (route) => {
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
  await mockRecordUpload(page, async (route) => {
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
  await expect(errorSpan).toHaveText("record not uploaded");
  await expect(errorSpan).toHaveAttribute("title", /Record not uploaded: temporary_test_failure/);
  await expect(page.getByRole("textbox", { name: "Writing canvas" })).toHaveAttribute("readonly", "");
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
  await mockRecordUpload(page, async (route) => {
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
  await mockRecordUpload(page, async (route) => {
    const payload = route.request().postDataJSON();
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ record_hash: payload.manifest.record_hash, short_signature: "keeptext1", url: "http://127.0.0.1:4173/keeptext1", created: true }) });
  });

  await page.goto("/write");
  await expect(page.locator(".write-modeline")).toContainText("idle");
  await page.keyboard.type("My precious writing.");
  await page.getByRole("button", { name: "sign", exact: true }).click();
  await page.getByRole("button", { name: "sign & upload" }).click();
  await expect(page.getByText("open record →")).toBeVisible();

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
  await mockRecordUpload(page, async (route) => {
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
  await expect(message).toContainText("Record not uploaded: temporary_test_failure");
  await expect(page.locator(".ml-error")).toHaveText("record not uploaded");
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
  await mockRecordUpload(page, async (route) => {
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
  await mockRecordUpload(page, async (route) => {
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
  await expect(message).toContainText("Record not uploaded: observation_mismatch");
  expect(uploads[0].observation.token).toBe("x".repeat(32));

  await expect(page.getByRole("textbox", { name: "Writing canvas" })).toHaveAttribute("readonly", "");
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

async function captureWriteUpload(page, edit) {
  let payload;
  await page.route("**/api/observed-sessions/*/checkpoints", (route) => route.fulfill({ status: 503, body: "unavailable" }));
  await mockRecordUpload(page, (route) => {
    payload = route.request().postDataJSON();
    return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ record_hash: payload.manifest.record_hash, short_signature: "capture1", url: "http://127.0.0.1:4173/capture1", created: true }) });
  });
  await page.goto("/write");
  const canvas = page.getByRole("textbox", { name: "Writing canvas" });
  await expect(canvas).toBeEditable();
  await canvas.focus();
  await edit(canvas);
  const value = await canvas.inputValue();
  await page.getByRole("button", { name: "sign", exact: true }).click();
  await page.getByRole("button", { name: "sign & upload" }).click();
  await expect(page.getByText("open record →")).toBeVisible();
  expect(verifyRecord(payload).valid).toBe(true);
  return { payload, value };
}

test("/write measures native word deletion and undo instead of assuming one character", async ({ page }) => {
  const { payload, value } = await captureWriteUpload(page, async () => {
    await page.keyboard.type("hello world");
    await page.keyboard.press(process.platform === "darwin" ? "Alt+Backspace" : "Control+Backspace");
    await page.keyboard.press("ControlOrMeta+z");
  });
  expect(value).toBe("hello world");
  expect(payload.events.find((event) => event.op === "delete")).toMatchObject({ del_len: 5, pos: 6 });
  expect(payload.events.at(-1)).toMatchObject({ op: "replace", del_len: null, ins_len: null, source: "unknown" });
});

test("/write ignores cancelled beforeinput and records a composition only at commit", async ({ page }) => {
  const { payload, value } = await captureWriteUpload(page, async (canvas) => {
    await canvas.evaluate((element) => element.addEventListener("beforeinput", (event) => event.preventDefault(), { once: true }));
    await page.keyboard.type("x");
    await expect(canvas).toHaveValue("");
    await canvas.evaluate((element) => {
      element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertCompositionText", data: "あ", isComposing: true }));
      element.value = "あ";
      element.setSelectionRange(1, 1);
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "あ", isComposing: true }));
      element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "あ" }));
    });
    await page.keyboard.type("z");
  });
  expect(value).toBe("あz");
  expect(payload.events).toHaveLength(2);
  expect(payload.events[0]).toMatchObject({ op: "insert", ins_len: 1, source: "ime" });
  expect(payload.events[1]).toMatchObject({ op: "insert", pos: 1, ins_len: 1, source: "typing" });
});

test("/write preserves paste attribution when beforeinput supplies no text", async ({ page }) => {
  const { payload, value } = await captureWriteUpload(page, async (canvas) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.evaluate(() => navigator.clipboard.writeText("Pasted 🙂 text"));
    await canvas.focus();
    await page.keyboard.press("ControlOrMeta+v");
  });
  expect(value).toBe("Pasted 🙂 text");
  expect(payload.events).toHaveLength(1);
  expect(payload.events[0]).toMatchObject({ op: "insert", pos: 0, ins_len: 13, source: "paste" });
});

for (const clipboardState of ['missing', 'denied', 'working']) {
  test(`/write copy actions report actual outcomes when clipboard is ${clipboardState}`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(state => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: state === 'missing' ? undefined : {
        writeText: async value => {
          if (state === 'denied') throw new DOMException('Denied', 'NotAllowedError');
          window.__copiedText = value;
        },
      } });
    }, clipboardState);
    await captureWriteUpload(page, async () => { await page.keyboard.type('copy fixture'); });
    const message = page.getByRole('status', { name: 'Drafting message' });
    await page.getByRole('button', { name: 'copy text', exact: true }).click();
    await expect(message).toContainText(clipboardState === 'working' ? 'Your writing was copied' : 'Your writing could not be copied');
    if (clipboardState === 'working') expect(await page.evaluate(() => window.__copiedText)).toBe('copy fixture');
    await page.getByRole('button', { name: 'copy record link' }).click();
    await expect(message).toContainText(clipboardState === 'working' ? 'Record link copied' : 'record link could not be copied');
    if (clipboardState === 'working') expect(await page.evaluate(() => window.__copiedText)).toContain('/capture1');
    expect(errors).toEqual([]);
  });
}

const installStorageFailure = installJournalFailure;

async function setupRecoveryUpload(page, handle) {
  await page.route('**/api/observed-sessions/*/checkpoints', route => route.fulfill({ status: 503, body: 'unavailable' }));
  await mockRecordUpload(page, handle);
  await page.goto('/write');
  const canvas = page.getByRole('textbox', { name: 'Writing canvas' });
  await expect(canvas).toBeEditable();
  await canvas.pressSequentially('recover fixture');
  return canvas;
}

function successfulUpload(route, payload) {
  return route.fulfill({ status: 201, json: { record_hash: payload.manifest.record_hash,
    short_signature: 'recovery1', url: 'http://127.0.0.1:4173/recovery1', created: true } });
}

async function finishWrite(page) {
  await page.getByRole('button', { name: 'sign', exact: true }).click();
  await page.getByRole('button', { name: 'sign & upload' }).click();
}

test('/write failed local capture save is visible, stops editing, and can be saved again', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await installStorageFailure(page);
  const canvas = await setupRecoveryUpload(page, route => route.abort());
  await page.evaluate(() => { window.__failLocalSave = true; });
  await canvas.pressSequentially('x');
  await expect(canvas).not.toBeEditable();
  await expect(page.getByRole('status', { name: 'Drafting message' })).toContainText('could not be saved locally');
  await page.evaluate(() => { window.__failLocalSave = false; });
  await page.getByRole('button', { name: 'retry saving' }).click();
  await expect(canvas).toBeEditable();
  const records = await readWriteSessions(page);
  expect(records[0].events).toHaveLength('recover fixturex'.length);
  expect(errors).toEqual([]);
});

test('/write persists a frozen finish before upload and retries identical content after reload', async ({ page }) => {
  const uploads = [];
  await setupRecoveryUpload(page, route => {
    const payload = route.request().postDataJSON();
    uploads.push(payload);
    return uploads.length === 1 ? route.fulfill({ status: 503, json: { error: 'temporary' } }) : successfulUpload(route, payload);
  });
  await finishWrite(page);
  await expect(page.getByRole('button', { name: 'retry', exact: true })).toBeVisible();
  const saved = (await readWriteSessions(page))[0];
  expect(saved.signed_duration_ms).toBe(uploads[0].manifest.duration_ms);
  expect(saved.format_version).toBe('0.3');
  expect(JSON.stringify(saved)).not.toContain('recover fixture');
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Writing canvas' })).toHaveValue('');
  await page.getByRole('button', { name: 'retry', exact: true }).click();
  await expect(page.getByText('open record →')).toBeVisible();
  expect(uploads).toHaveLength(2);
  expect(uploads[1]).toEqual(uploads[0]);
});

test('/write never uploads when freezing cannot be saved locally', async ({ page }) => {
  let uploads = 0;
  await installStorageFailure(page);
  await setupRecoveryUpload(page, route => { uploads++; return successfulUpload(route, route.request().postDataJSON()); });
  await page.getByRole('button', { name: 'sign', exact: true }).click();
  await page.evaluate(() => { window.__failLocalSave = true; });
  await page.getByRole('button', { name: 'sign & upload' }).click();
  await expect(page.getByRole('button', { name: 'retry', exact: true })).toBeVisible();
  expect(uploads).toBe(0);
  await page.evaluate(() => { window.__failLocalSave = false; });
  await page.getByRole('button', { name: 'retry', exact: true }).click();
  await expect(page.getByText('open record →')).toBeVisible();
  expect(uploads).toBe(1);
});

test('/write shows the accepted link even if saving upload success fails', async ({ page }) => {
  let uploads = 0;
  await installStorageFailure(page);
  await setupRecoveryUpload(page, async route => {
    uploads++;
    await page.evaluate(() => { window.__failLocalSave = true; });
    return successfulUpload(route, route.request().postDataJSON());
  });
  await finishWrite(page);
  await expect(page.getByText('open record →')).toBeVisible();
  await expect(page.getByRole('status', { name: 'Drafting message' })).toContainText('Record uploaded, but its link could not be saved locally');
  await page.evaluate(() => { window.__failLocalSave = false; });
  await page.getByRole('button', { name: 'retry saving' }).click();
  const saved = (await readWriteSessions(page))[0];
  expect(saved.state).toBe('uploaded');
  expect(uploads).toBe(1);
});

test('/write failed discard keeps both writing and captured events', async ({ page }) => {
  await installStorageFailure(page);
  const canvas = await setupRecoveryUpload(page, route => route.abort());
  await page.evaluate(() => { window.__failLocalSave = true; });
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'discard', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Drafting message' })).toContainText('Could not save the session change');
  await expect(canvas).toHaveValue('recover fixture');
  await page.evaluate(() => { window.__failLocalSave = false; });
  await page.getByRole('button', { name: 'retry saving' }).click();
  await expect(canvas).toBeEditable();
  const saved = (await readWriteSessions(page))[0];
  expect(saved.events).toHaveLength('recover fixture'.length);
});

test('/write malformed upload success remains frozen and retryable', async ({ page }) => {
  const uploads = [];
  await setupRecoveryUpload(page, route => {
    const payload = route.request().postDataJSON();
    uploads.push(payload);
    return uploads.length === 1 ? route.fulfill({ status: 201, json: {} }) : successfulUpload(route, payload);
  });
  await finishWrite(page);
  await expect(page.getByRole('status', { name: 'Drafting message' })).toContainText('Invalid upload response');
  await expect(page.getByText('open record →')).toHaveCount(0);
  await page.getByRole('button', { name: 'retry', exact: true }).click();
  await expect(page.getByText('open record →')).toBeVisible();
  expect(uploads[1]).toEqual(uploads[0]);
});

test('/write seals trailing idle time and preserves the saved parent when continuing', async ({ page }) => {
  const uploads = [];
  await page.addInitScript(() => {
    const now = Date.now;
    window.__elapsedOffset = 0;
    Date.now = () => now() + window.__elapsedOffset;
  });
  const canvas = await setupRecoveryUpload(page, route => {
    const payload = route.request().postDataJSON();
    uploads.push(payload);
    return successfulUpload(route, payload);
  });
  await page.evaluate(() => { window.__elapsedOffset += 60_000; });
  await finishWrite(page);
  await expect(page.getByText('open record →')).toBeVisible();
  expect(uploads[0].manifest.duration_ms - uploads[0].events.at(-1).t).toBeGreaterThanOrEqual(60_000);
  await page.getByRole('button', { name: 'keep editing' }).click();
  await expect(canvas).toBeEditable();
  await page.evaluate(() => { window.__elapsedOffset += 120_000; });
  await canvas.pressSequentially('x');
  await finishWrite(page);
  await expect(page.getByText('open record →')).toBeVisible();
  expect(uploads).toHaveLength(2);
  expect(uploads[1].manifest.parent_record).toBe(uploads[0].manifest.record_hash);
  expect(uploads[1].manifest.session_id).not.toBe(uploads[0].manifest.session_id);
  expect(uploads[1].events).toHaveLength(1);
  expect(uploads[1].events[0].pos).toBeNull();
  expect(uploads[1].events[0].t).toBeGreaterThanOrEqual(120_000);
  expect(verifyRecord(uploads[1]).valid).toBe(true);
  const saved = await readWriteSessions(page);
  expect(saved.filter(record => record.state === 'uploaded')).toHaveLength(2);
  expect(saved.find(record => record.session_id === uploads[0].manifest.session_id).uploaded_response.record_hash).toBe(uploads[0].manifest.record_hash);
});

for (const recordAnotherEdit of [false, true]) {
  test(`/write rejects an unobserved final length change and recovers with another edit=${recordAnotherEdit}`, async ({ page }) => {
    const uploads = [];
    const canvas = await setupRecoveryUpload(page, route => {
      const payload = route.request().postDataJSON();
      uploads.push(payload);
      return successfulUpload(route, payload);
    });
    await canvas.evaluate(element => { element.value += ' UNOBSERVED'; });
    await finishWrite(page);
    await expect(page.getByRole('status', { name: 'Drafting message' })).toContainText('Capture has a gap');
    await expect(canvas).toBeEditable();
    expect(uploads).toEqual([]);
    if (recordAnotherEdit) {
      await canvas.pressSequentially('n');
      await finishWrite(page);
    } else {
      await page.getByRole('button', { name: 'sign', exact: true }).click();
      await page.getByRole('checkbox').uncheck();
      await page.getByRole('button', { name: 'sign & upload' }).click();
    }
    await expect(page.getByText('open record →')).toBeVisible();
    expect(uploads).toHaveLength(1);
    expect(Boolean(uploads[0].manifest.text_binding)).toBe(recordAnotherEdit);
    expect(uploads[0].events).toHaveLength('recover fixture'.length + Number(recordAnotherEdit));
    if (recordAnotherEdit) expect(uploads[0].events.at(-1).pos).toBeNull();
    expect(verifyRecord(uploads[0]).valid).toBe(true);
  });
}
