import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";

const bundled = await build({ entryPoints: ["apps/browser-extension/src/popup/popup.ts"], bundle: true, write: false, format: "iife", target: "chrome120" });
const shell = (await readFile("apps/browser-extension/src/popup/popup.html", "utf8")).replace('<script type="module" src="popup.js"></script>', "");
const URL = "https://possiblymadebyahuman.com/exampleSaved";
function session(id = "body", label = "example.com · Text field · 1", saved = false) {
  return { session_id: id, state: saved ? "uploaded" : "active", display_name: label, descriptor: { aria_label: "Text field" }, origin: { origin: "https://example.com", path: "/editor", tab_id: 12, frame_id: 7 }, capture_context: { browser: { url: "https://example.com/editor", title: "Editor" }, label: "Public description" }, event_count: saved ? 0 : 1, capture_status: saved ? "stopped" : "active", last_edit_wall_ms: Date.UTC(2026, 8, 23), ...(saved ? { uploaded_response: { url: `${URL}${id}`, short_signature: id, record_hash: `b3:${id}` } } : {}) };
}
async function loadPanel(page, options = {}) {
  const state = { sessions: options.sessions ?? [session()], current: options.current ?? { state: "tracked", session_id: "body" }, bindingFailure: options.bindingFailure, delay: options.delay ?? 0, calls: [], scope: options.scope ?? "whole_field", token: "scope-1", scopeChanged: false };
  await page.exposeFunction("panelMessage", async message => {
    state.calls.push(message);
    if (message.kind === "list_panel_sessions") {
      const saved = state.sessions.filter(s => s.state === "uploaded");
      const matches = saved.filter(s => `${s.display_name} ${s.origin.origin} ${s.uploaded_response.url}`.toLowerCase().includes((message.history_query ?? "").toLowerCase()));
      const offset = Math.min(message.history_offset ?? 0, Math.max(matches.length - 1, 0));
      return { kind: "panel_sessions_result", drafts: state.sessions.filter(s => s.state !== "uploaded"), saved: matches.slice(offset, offset + message.history_limit), saved_count: saved.length, matching_saved_count: matches.length, history_offset: offset, current_editor: state.current };
    }
    if (message.kind === "inspect_finish") return { kind: "finish_scope_result", scope: state.scope, scope_token: state.token };
    if (message.kind === "prepare_finish") {
      if (state.scopeChanged) { state.scopeChanged = false; return { kind: "prepare_finish_result", scope_changed: true, scope: state.scope, scope_token: state.token, text_binding: null }; }
      state.sessions.find(s => s.session_id === message.session_id).capture_status = "stopped";
      await new Promise(resolve => setTimeout(resolve, state.delay));
      return { kind: "prepare_finish_result", text_binding: message.bind && !state.bindingFailure ? { scheme: "canon-letters/0.1", canonical_length: 5, commitment: "b3:example" } : null, ...(message.bind && state.bindingFailure ? { reason: "The selected editor is unavailable." } : {}) };
    }
    if (message.kind === "sign_session" || message.kind === "retry_failed_upload") {
      const record = state.sessions.find(s => s.session_id === message.session_id);
      record.state = "uploaded"; record.uploaded_response = { url: URL, short_signature: "exampleSaved", record_hash: "b3:example" }; record.signed_text_binding = message.text_binding;
      return { kind: "sign_session_result", result: { kind: "uploaded", response: record.uploaded_response, text_binding: record.signed_text_binding } };
    }
    if (message.kind === "rename_session") { state.sessions.find(s => s.session_id === message.session_id).display_name = message.name; return { kind: "rename_result", ok: true }; }
    if (message.kind === "remove_saved") { state.sessions = state.sessions.filter(s => s.session_id !== message.session_id); return { kind: "remove_saved_result", ok: true }; }
    if (message.kind === "clear_saved") { state.sessions = state.sessions.filter(s => s.state !== "uploaded"); return { kind: "clear_saved_result", ok: true }; }
    if (message.kind === "export_saved") return { kind: "export_saved_result", links: state.sessions.filter(s => s.state === "uploaded").map(s => ({ name: s.display_name, url: s.uploaded_response.url })) };
    return { kind: "error", reason: "Unexpected test request" };
  });
  await page.addInitScript(() => {
    window.chrome = { runtime: { sendMessage: message => window.panelMessage(message) }, windows: { getCurrent: async () => ({ id: 73 }) } };
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => { throw new Error("denied"); } }, configurable: true });
  });
  await page.route("https://panel.test/", route => route.fulfill({ contentType: "text/html", body: shell }));
  async function open() {
    await page.goto("https://panel.test/");
    await page.addScriptTag({ content: bundled.outputFiles[0].text });
    await expect(page.locator("#history-title")).toHaveText(`Saved records (${state.sessions.filter(s => s.state === "uploaded").length})`);
    await expect(page.locator("#current")).toContainText("This editor");
  }
  await open();
  return { state, open };
}
async function history(page) { await page.locator("#history-title").click(); }

test("unavailable text check uploads nothing until editing activity is explicitly chosen; saved URL survives reopen", async ({ page }) => {
  const { state, open } = await loadPanel(page, { bindingFailure: true });
  await page.getByRole("button", { name: "Finish & get link" }).click();
  await page.getByRole("button", { name: "Confirm & publish" }).click();
  await expect(page.getByRole("alert")).toContainText("No record was published");
  expect(state.calls.filter(m => m.kind === "sign_session")).toHaveLength(0);
  await expect(page.locator(".sign-confirm-go")).toBeHidden();
  await page.getByRole("button", { name: "Publish editing activity only" }).click();
  await expect(page.getByRole("heading", { name: "Record saved" })).toBeVisible();
  expect(state.calls.find(m => m.kind === "sign_session").text_binding).toBeUndefined();
  await expect(page.getByLabel("Complete record link")).toHaveValue(URL);
  await page.getByRole("button", { name: "Copy link" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Copy was blocked" })).toContainText("your record is saved");
  await open();
  await expect(page.locator(".saved-row")).toHaveCount(0);
  await history(page);
  await page.locator(".saved-row summary").click();
  await expect(page.getByLabel("Complete record link")).toHaveValue(URL);
  await expect(page.getByText("No text check included.", { exact: true })).toBeVisible();
});

test("finish pins its draft and reviewed selection token even when focus changes, and duplicate clicks upload once", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 380, height: 900 });
  const { state } = await loadPanel(page, { delay: 150, scope: "selection" });
  await page.getByRole("button", { name: "Finish & get link" }).click();
  await expect(page.locator(".binding-scope")).toHaveText("Selected text");
  await page.screenshot({ path: testInfo.outputPath("panel-review-380.png"), fullPage: true });
  state.sessions.push(session("other", "Other editor")); state.current = { state: "tracked", session_id: "other" };
  await page.locator(".sign-confirm-go").evaluate(button => { button.click(); button.click(); });
  await expect(page.getByRole("heading", { name: "Record saved" })).toBeVisible();
  expect(state.calls.filter(m => m.kind === "prepare_finish")).toHaveLength(1);
  expect(state.calls.find(m => m.kind === "prepare_finish")).toMatchObject({ session_id: "body", expected_scope_token: "scope-1" });
  expect(state.calls.filter(m => m.kind === "sign_session")).toHaveLength(1);
  expect(state.calls.find(m => m.kind === "sign_session").session_id).toBe("body");
});

test("changed selection updates the scope and requires another confirmation before upload", async ({ page }) => {
  const { state } = await loadPanel(page, { scope: "selection" });
  await page.getByRole("button", { name: "Finish & get link" }).click();
  await expect(page.locator(".binding-scope")).toHaveText("Selected text");
  state.scope = "whole_field"; state.token = "scope-2"; state.scopeChanged = true;
  await page.getByRole("button", { name: "Confirm & publish" }).click();
  await expect(page.getByRole("alert")).toContainText("confirm again");
  await expect(page.locator(".binding-scope")).toHaveText("Whole field");
  expect(state.calls.filter(m => m.kind === "sign_session")).toHaveLength(0);
  await page.getByRole("button", { name: "Confirm & publish" }).click();
  await expect(page.getByRole("heading", { name: "Record saved" })).toBeVisible();
  expect(state.calls.filter(m => m.kind === "prepare_finish").at(-1).expected_scope_token).toBe("scope-2");
});

test("focus follows exact session identity, untracked fields are explicit, and requests stay window-scoped", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 380, height: 900 });
  const { state } = await loadPanel(page, { sessions: [session(), session("other", "example.com · Text field · 2")] });
  await expect(page.locator("article.current")).toHaveAttribute("data-session-id", "body");
  await page.screenshot({ path: testInfo.outputPath("panel-current-380.png"), fullPage: true });
  state.current = { state: "tracked", session_id: "other" };
  await expect(page.locator("article.current")).toHaveAttribute("data-session-id", "other");
  state.current = { state: "untracked" };
  await expect(page.locator("#current")).toContainText("No writing record is active for this field");
  await expect(page.locator("article.current")).toHaveCount(0);
  expect(state.calls.filter(m => m.kind === "start_focused_editor")).toHaveLength(0);
  expect(state.calls.filter(m => m.kind === "list_panel_sessions").every(m => m.window_id === 73 && m.history_limit === 20)).toBe(true);
  expect(state.calls.some(m => m.kind === "list_sessions")).toBe(false);
});

test("private rename survives refresh/reopen and never changes the public label", async ({ page }) => {
  const { state, open } = await loadPanel(page);
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await page.getByLabel("Private name").fill("My private project");
  // A focus signal from another editor must not destroy a name being edited.
  state.current = { state: "untracked" };
  await page.waitForTimeout(650);
  await expect(page.getByLabel("Private name")).toHaveValue("My private project");
  await page.getByLabel("Private name").press("Enter");
  await expect(page.locator(".session-title")).toHaveText("My private project");
  await open();
  await expect(page.locator(".session-title")).toHaveText("My private project");
  await page.getByRole("button", { name: "Finish & get link" }).click();
  await expect(page.getByLabel("Public label")).toHaveValue("Public description");
  expect(state.sessions[0].capture_context.label).toBe("Public description");
});

test("Escape cancels private renaming without a write, and polling preserves keyboard focus", async ({ page }) => {
  const { state } = await loadPanel(page);
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await page.getByLabel("Private name").fill("Uncommitted name");
  await page.getByLabel("Private name").press("Escape");
  await expect(page.getByLabel("Private name")).toHaveCount(0);
  expect(state.calls.some(call => call.kind === "rename_session")).toBe(false);
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  await stop.focus();
  state.sessions[0].event_count = 2;
  await expect(page.locator("article.current")).toContainText("2 editing events");
  await expect(stop).toBeFocused();
});

for (const count of [0, 1, 20, 200]) {
  test(`${count} saved records stay collapsed and render at most one 20-row page`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 340, height: 800 });
    const { state } = await loadPanel(page, { sessions: Array.from({ length: count }, (_, i) => session(`saved-${i}`, `Saved draft ${i}`, true)), current: { state: "untracked" } });
    await expect(page.locator(".saved-row")).toHaveCount(0);
    await history(page);
    await expect(page.locator(".saved-row")).toHaveCount(Math.min(count, 20));
    await expect(page.locator(".saved-row details[open]")).toHaveCount(0);
    if (count === 200) {
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await expect(page.locator("#history-page")).toHaveText("21–40 of 200");
      await expect(page.locator(".saved-row")).toHaveCount(20);
      await page.getByLabel("Search saved records").fill("Saved draft 199");
      await expect(page.locator(".saved-row")).toHaveCount(1);
      await expect(page.locator(".saved-row")).toContainText("Saved draft 199");
      expect(state.sessions).toHaveLength(200);
      await expect(page.getByLabel("Search saved records")).toBeFocused();
      await page.screenshot({ path: testInfo.outputPath("panel-history-search-340.png"), fullPage: true });
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(state.calls.filter(m => m.kind === "list_panel_sessions").every(m => m.history_limit === 20)).toBe(true);
  });
}

test("export includes all links beyond the visible page, and explicit removal keeps public records and drafts", async ({ page }) => {
  const { state } = await loadPanel(page, { sessions: [session(), ...Array.from({ length: 25 }, (_, i) => session(`saved-${i}`, `Saved draft ${i}`, true))] });
  await history(page);
  const downloadPending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export all links" }).click();
  const download = await downloadPending;
  const links = JSON.parse(await readFile(await download.path(), "utf8"));
  expect(links).toHaveLength(25);
  expect(state.sessions).toHaveLength(26);
  await page.locator(".saved-row").first().locator("summary").click();
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Remove saved link", exact: true }).click();
  await expect(page.locator("#history-title")).toHaveText("Saved records (24)");
  page.once("dialog", dialog => { expect(dialog.message()).toContain("Public records and unfinished drafts stay available"); return dialog.accept(); });
  await page.getByRole("button", { name: "Remove all saved links", exact: true }).click();
  await expect(page.locator("#history-title")).toHaveText("Saved records (0)");
  expect(state.sessions.map(s => s.session_id)).toEqual(["body"]);
});

test("browsing and copying saved history cannot retarget the draft being finished", async ({ page }) => {
  const { state } = await loadPanel(page, { sessions: [session(), session("old", "Old record", true)] });
  await history(page);
  await page.locator(".saved-row").getByRole("button", { name: "Copy link" }).click();
  await expect(page.locator("article.current")).toHaveAttribute("data-session-id", "body");
  await page.getByRole("button", { name: "Finish & get link" }).click();
  await page.getByRole("button", { name: "Confirm & publish" }).click();
  await expect(page.getByRole("heading", { name: "Record saved" })).toBeVisible();
  expect(state.calls.find(m => m.kind === "sign_session").session_id).toBe("body");
});

test("saved success shows the authoritative text check when history filtering excludes the new record", async ({ page }) => {
  await loadPanel(page, { sessions: [session(), session("old", "Old record", true)] });
  await history(page);
  await page.getByLabel("Search saved records").fill("Old record");
  await expect(page.locator(".saved-row")).toHaveCount(1);
  await page.getByRole("button", { name: "Finish & get link" }).click();
  await page.getByRole("button", { name: "Confirm & publish" }).click();
  await expect(page.locator("#latest")).toContainText("Text check included.");
  await expect(page.locator("#latest")).not.toContainText("No text check included.");
  await expect(page.locator(".saved-row")).toHaveCount(1);
  await expect(page.locator(".saved-row")).toContainText("Old record");
});
