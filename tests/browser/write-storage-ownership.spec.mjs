import { readWriteSessions } from "./journal-fixtures.mjs";
import { expect, test } from "./csp-guard.mjs";

const storageKey = "pmbah.write.sessions.v1";
const sessions = readWriteSessions;

const readDrafts = (page) => page.evaluate(async () => {
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open("pmbah.write.drafts.v1");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction("drafts", "readonly").objectStore("drafts").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally { database.close(); }
});

test("two writing tabs cannot overwrite the same drafts; ownership transfers after closing", async ({ page, context }) => {
  await context.route("**/api/observed-sessions/*/checkpoints", route => route.fulfill({ status: 503, body: "unavailable" }));
  await page.goto("/write");
  const firstCanvas = page.getByRole("textbox", { name: "Writing canvas" });
  await expect(firstCanvas).toBeEditable();
  await firstCanvas.pressSequentially("abc");
  await expect.poll(async () => (await sessions(page))[0]?.events.length).toBe(3);
  const original = (await sessions(page))[0];

  const second = await context.newPage();
  await second.goto("/write");
  await expect(second.getByRole("alert")).toContainText("Your drafts are open in another tab");
  await expect(second.getByRole("textbox", { name: "Writing canvas" })).toHaveCount(0);
  await second.getByRole("button", { name: "Try again" }).click();
  await expect(second.getByRole("alert")).toContainText("Your drafts are open in another tab");
  expect((await sessions(second))[0].events).toEqual(original.events);
  await firstCanvas.pressSequentially("d");
  await expect.poll(async () => (await sessions(page))[0]?.events.length).toBe(4);
  await expect(page.getByRole("status", { name: "Save state" })).toHaveText("Saved in this browser");
  await page.close();

  await second.getByRole("button", { name: "Try again" }).click();
  await second.getByRole("link", { name: /abcd/ }).click();
  const secondCanvas = second.getByRole("textbox", { name: "Writing canvas" });
  await expect(secondCanvas).toBeEditable();
  await expect(secondCanvas).toHaveValue("abcd");
  await secondCanvas.press("End");
  await secondCanvas.pressSequentially("z");
  await expect.poll(async () => (await sessions(second))[0]?.events.length).toBe(5);
  const recovered = (await sessions(second))[0];
  expect(recovered.session_id).toBe(original.session_id);
  expect(recovered.events.slice(0, 3)).toEqual(original.events);
  // The restored text matches the recorded chain, so the history continues without a gap.
  expect(recovered.events.at(-1)).toMatchObject({ pos: 4, ins_len: 1 });
});

test("restored text that does not match the recorded history resumes after an honest capture gap", async ({ page }) => {
  await page.route("**/api/observed-sessions/*/checkpoints", route => route.fulfill({ status: 503, body: "unavailable" }));
  await page.goto("/write");
  const canvas = page.getByRole("textbox", { name: "Writing canvas" });
  await expect(canvas).toBeEditable();
  await canvas.pressSequentially("old");
  await expect(page.getByRole("status", { name: "Save state" })).toHaveText("Saved in this browser");
  await expect.poll(async () => (await sessions(page))[0]?.events.length).toBe(3);
  // Simulate text saved before the latest recorded edit.
  await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("pmbah.write.drafts.v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const store = database.transaction("drafts", "readwrite").objectStore("drafts");
    const [row] = await new Promise(resolve => { store.getAll().onsuccess = event => resolve(event.target.result); });
    row.text_tag = { ...row.text_tag, event_count: 2 };
    await new Promise(resolve => { store.put(row).onsuccess = resolve; });
    database.close();
  });
  await page.reload();
  await expect(canvas).toHaveValue("old");
  await canvas.press("End");
  await canvas.pressSequentially("n");
  await expect.poll(async () => (await sessions(page))[0]?.events.length).toBe(4);
  expect((await sessions(page))[0].events.at(-1)).toMatchObject({ pos: null, ins_len: 1 });
});

test("unrecognized storage is preserved on initialization and retry", async ({ page }) => {
  const raw = JSON.stringify({ future_version: 2, saved_links: ["keep this value"] });
  await page.addInitScript(({ key, raw }) => localStorage.setItem(key, raw), { key: storageKey, raw });
  await page.goto("/write");
  await expect(page.getByRole("alert")).toContainText("unrecognized shape");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("alert")).toContainText("unrecognized shape");
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBe(raw);
});

test("a new draft starts an exact empty capture without an invented gap and keeps the first draft", async ({ page }) => {
  await page.route("**/api/observed-sessions/*/checkpoints", route => route.fulfill({ status: 503, body: "unavailable" }));
  await page.goto("/write");
  const canvas = page.getByRole("textbox", { name: "Writing canvas" });
  await expect(canvas).toBeEditable();
  await canvas.pressSequentially("old");
  await expect(page.getByRole("status", { name: "Save state" })).toHaveText("Saved in this browser");
  const first = (await sessions(page))[0];
  await page.getByRole("link", { name: "Drafts" }).click();
  await page.getByRole("button", { name: "New draft" }).click();
  await expect(canvas).toHaveValue("");
  await canvas.pressSequentially("n");
  await expect(page.getByRole("status", { name: "Save state" })).toHaveText("Saved in this browser");
  await expect.poll(async () => (await sessions(page)).find(session => session.session_id !== first.session_id)?.events).toMatchObject([
    { seq: 0, op: "insert", pos: 0, ins_len: 1, del_len: 0 },
  ]);
  const drafts = await readDrafts(page);
  expect(drafts.map(draft => draft.text).sort()).toEqual(["n", "old"]);
  await page.getByRole("link", { name: "Drafts" }).click();
  await expect(page.getByRole("list", { name: "Your drafts" }).getByRole("listitem")).toHaveCount(2);
});

test("deleting a draft removes its text and history from this browser", async ({ page }) => {
  await page.route("**/api/observed-sessions/*/checkpoints", route => route.fulfill({ status: 503, body: "unavailable" }));
  await page.goto("/write");
  const canvas = page.getByRole("textbox", { name: "Writing canvas" });
  await expect(canvas).toBeEditable();
  await canvas.pressSequentially("gone");
  await expect(page.getByRole("status", { name: "Save state" })).toHaveText("Saved in this browser");
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Delete draft" }).click();
  await expect(page.getByRole("heading", { name: "Drafts" })).toBeVisible();
  await expect(page.getByText("No drafts in this browser.")).toBeVisible();
  expect(await readDrafts(page)).toEqual([]);
  expect(await sessions(page)).toEqual([]);
});
