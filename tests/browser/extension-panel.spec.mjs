import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";

const bundled = await build({ entryPoints: ["apps/browser-extension/src/popup/popup.ts"], bundle: true, write: false, format: "iife", target: "chrome120" });
const shell = (await readFile("apps/browser-extension/src/popup/popup.html", "utf8")).replace('<script type="module" src="popup.js"></script>', "");
const URL = "https://possiblymadebyahuman.com/exampleSaved";
function session(id = "body", label = "Message body") {
  return { session_id: id, state: "active", descriptor: { aria_label: label }, origin: { origin: "https://mail.example", path: "/mail", tab_id: 12, frame_id: 7 }, capture_context: { browser: { url: "https://mail.example/mail", title: "Mail" }, label }, events: [{ op: "insert" }], observation: { state: "known", last_committed_event_count: 1 } };
}
async function loadPanel(page, options = {}) {
  const state = { sessions: [session()], selected: "body", bindingFailure: options.bindingFailure, delay: options.delay ?? 0, calls: [], prepared: false };
  await page.exposeFunction("panelMessage", async message => {
    state.calls.push(message);
    if (message.kind === "list_sessions") return { kind: "list_sessions_result", sessions: state.sessions, selected_session_id: state.selected, capture_status: Object.fromEntries(state.sessions.map(s => [s.session_id, state.prepared ? "stopped" : "active"])) };
    if (message.kind === "prepare_finish") {
      state.prepared = true;
      await new Promise(resolve => setTimeout(resolve, state.delay));
      return { kind: "prepare_finish_result", text_binding: message.bind && !state.bindingFailure ? { scheme: "canon-letters/0.1", canonical_length: 5, commitment: "b3:example" } : null, ...(message.bind && state.bindingFailure ? { reason: "The selected editor is unavailable." } : {}) };
    }
    if (message.kind === "sign_session") {
      const record = state.sessions.find(s => s.session_id === message.session_id);
      record.state = "uploaded";
      record.uploaded_response = { url: URL, short_signature: "exampleSaved" };
      record.signed_text_binding = message.text_binding;
      return { kind: "sign_session_result", result: { kind: "uploaded", response: record.uploaded_response } };
    }
    return { kind: "error", reason: "Unexpected test request" };
  });
  await page.addInitScript(() => {
    window.chrome = { runtime: { sendMessage: message => window.panelMessage(message) } };
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => { throw new Error("denied"); } }, configurable: true });
  });
  await page.route("https://panel.test/", route => route.fulfill({ contentType: "text/html", body: shell }));
  async function open() {
    await page.goto("https://panel.test/");
    await page.addScriptTag({ content: bundled.outputFiles[0].text });
    await expect(page.locator("article.session")).toHaveCount(state.sessions.length);
  }
  await open();
  return { state, open };
}

test("binding failure persists, uploads nothing, and process-only needs its own explicit action", async ({ page }) => {
  const { state, open } = await loadPanel(page, { bindingFailure: true });
  await page.getByRole("button", { name: "Finish & get link" }).click();
  await page.getByRole("button", { name: "Confirm & publish" }).click();
  await expect(page.getByRole("alert")).toContainText("No record was published");
  expect(state.calls.filter(m => m.kind === "sign_session")).toHaveLength(0);
  await expect(page.locator(".sign-confirm-go")).toBeHidden();
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Publish process only" }).click();
  await expect(page.getByRole("heading", { name: "Record saved" })).toBeVisible();
  expect(state.calls.filter(m => m.kind === "sign_session")).toHaveLength(1);
  expect(state.calls.find(m => m.kind === "sign_session").text_binding).toBeUndefined();
  await expect(page.getByLabel("Complete record link")).toHaveValue(URL);
  await page.getByRole("button", { name: "Copy link" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Copy was blocked" })).toContainText("your record is saved");
  await expect(page.getByRole("link", { name: "Open record" })).toHaveAttribute("href", URL);
  await open();
  await expect(page.getByLabel("Complete record link")).toHaveValue(URL);
  await expect(page.getByText("Process-only record.", { exact: false })).toBeVisible();
});

test("rapid confirmation clicks yield one upload and worker selection cannot change the reviewed target", async ({ page }) => {
  const { state } = await loadPanel(page, { delay: 150 });
  await page.getByRole("button", { name: "Finish & get link" }).click();
  state.sessions.push(session("other", "Other editor"));
  state.selected = "other";
  await page.locator(".sign-confirm-go").evaluate(button => { button.click(); button.click(); });
  await expect(page.getByRole("heading", { name: "Record saved" })).toBeVisible();
  expect(state.calls.filter(m => m.kind === "prepare_finish")).toHaveLength(1);
  expect(state.calls.filter(m => m.kind === "sign_session")).toHaveLength(1);
  expect(state.calls.find(m => m.kind === "sign_session").session_id).toBe("body");
  await expect(page.locator("article.selected")).toContainText("Message body");
});

test("cancel after unavailable binding leaves a stopped draft and no upload", async ({ page }) => {
  const { state } = await loadPanel(page, { bindingFailure: true });
  await page.getByRole("button", { name: "Finish & get link" }).click();
  await page.getByRole("button", { name: "Confirm & publish" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator("#toast")).toContainText("Capture remains stopped");
  await expect(page.locator(".session-state")).toHaveText("Stopped draft");
  expect(state.calls.filter(m => m.kind === "sign_session")).toHaveLength(0);
});

test("a reopened panel presents an uploaded anchor as a saved link with its original binding", async ({ page }) => {
  const { state, open } = await loadPanel(page);
  await page.getByRole("button", { name: "Finish & get link" }).click();
  await page.getByRole("button", { name: "Confirm & publish" }).click();
  await expect(page.getByRole("heading", { name: "Record saved" })).toBeVisible();
  // The dispatcher/registry regression exercises the actual sweep/restart.
  // Feed that retained-anchor response into the browser-owned panel here.
  state.sessions[0].continuation_anchor = true;
  state.sessions[0].events = [];
  await open();
  await expect(page.getByLabel("Complete record link")).toHaveValue(URL);
  await expect(page.getByText("Includes a wording commitment.", { exact: false })).toBeVisible();
  await expect(page.locator(".session-meta")).toContainText("local event log cleared");
  await expect(page.locator("article.session")).not.toContainText("0 editing events");
});

test("an explicit start selects its new draft while idle, but unchanged polls preserve manual selection", async ({ page }) => {
  const { state } = await loadPanel(page);
  // A panel can retain its old activeElement when a webpage context menu
  // starts another draft. Polling must still notice that explicit selection.
  await page.getByRole("button", { name: "Finish & get link" }).focus();
  state.sessions.push(session("other", "Second message body"));
  state.selected = "other";
  await expect(page.locator("article.selected")).toContainText("Second message body", { timeout: 5000 });
  await page.locator('article[data-session-id="body"]').getByRole("button", { name: "Select this record" }).click();
  await expect(page.locator("article.selected")).toContainText("Message body");
  // Move focus outside the records so the idle refresh runs.
  await page.locator("h1").click();
  await page.waitForTimeout(2200);
  await expect(page.locator("article.selected")).toContainText("Message body");
});
