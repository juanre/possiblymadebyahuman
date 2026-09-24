import { readWriteSessions } from "./journal-fixtures.mjs";
import { expect, test } from "@playwright/test";

const storageKey = "pmbah.write.sessions.v1";
const sessions = readWriteSessions;

test("two writing tabs cannot overwrite the same session; ownership transfers after closing", async ({ page, context }) => {
  await context.route("**/api/observed-sessions/*/checkpoints", route => route.fulfill({ status: 503, body: "unavailable" }));
  await page.goto("/write");
  const firstCanvas = page.getByRole("textbox", { name: "Writing canvas" });
  await expect(firstCanvas).toBeEditable();
  await firstCanvas.pressSequentially("abc");
  await expect.poll(async () => (await sessions(page))[0]?.events.length).toBe(3);
  const original = (await sessions(page))[0];

  const second = await context.newPage();
  await second.goto("/write");
  await expect(second.getByRole("status", { name: "Drafting message" })).toContainText("Another writing tab");
  await expect(second.getByRole("textbox", { name: "Writing canvas" })).toHaveAttribute("readonly", "");
  await second.getByRole("button", { name: "retry saving" }).click();
  await expect(second.getByRole("status", { name: "Drafting message" })).toContainText("Another writing tab");
  expect((await sessions(second))[0].events).toEqual(original.events);
  await firstCanvas.pressSequentially("d");
  await expect.poll(async () => (await sessions(page))[0]?.events.length).toBe(4);
  await page.close();

  await second.getByRole("button", { name: "retry saving" }).click();
  const secondCanvas = second.getByRole("textbox", { name: "Writing canvas" });
  await expect(secondCanvas).toBeEditable();
  expect(await secondCanvas.inputValue()).toBe("");
  await secondCanvas.pressSequentially("z");
  await expect.poll(async () => (await sessions(second))[0]?.events.length).toBe(5);
  const recovered = (await sessions(second))[0];
  expect(recovered.session_id).toBe(original.session_id);
  expect(recovered.events.slice(0, 3)).toEqual(original.events);
  expect(recovered.events.at(-1)).toMatchObject({ pos: null, ins_len: 1 });
});

test("unrecognized storage is preserved on initialization and retry", async ({ page }) => {
  const raw = JSON.stringify({ future_version: 2, saved_links: ["keep this value"] });
  await page.addInitScript(({ key, raw }) => localStorage.setItem(key, raw), { key: storageKey, raw });
  await page.goto("/write");
  await expect(page.getByRole("status", { name: "Drafting message" })).toContainText("unrecognized shape");
  await page.getByRole("button", { name: "retry saving" }).click();
  await expect(page.getByRole("status", { name: "Drafting message" })).toContainText("unrecognized shape");
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBe(raw);
});

test("a successful discard starts an exact empty capture without an invented gap", async ({ page }) => {
  await page.route("**/api/observed-sessions/*/checkpoints", route => route.fulfill({ status: 503, body: "unavailable" }));
  await page.goto("/write");
  const canvas = page.getByRole("textbox", { name: "Writing canvas" });
  await expect(canvas).toBeEditable();
  await canvas.pressSequentially("old");
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "discard", exact: true }).click();
  await expect(canvas).toHaveValue("");
  await canvas.pressSequentially("n");
  await expect.poll(async () => (await sessions(page)).flatMap(session => session.events)).toMatchObject([
    { seq: 0, op: "insert", pos: 0, ins_len: 1, del_len: 0 },
  ]);
});

test("a failed clear preserves the canvas and recovers with an honest capture boundary", async ({ page }) => {
  await page.route("**/api/observed-sessions/*/checkpoints", route => route.fulfill({ status: 503, body: "unavailable" }));
  await page.goto("/write");
  const canvas = page.getByRole("textbox", { name: "Writing canvas" });
  await expect(canvas).toBeEditable();
  await canvas.pressSequentially("old");
  const original = (await sessions(page))[0];
  await page.evaluate(id => {
    const put = IDBObjectStore.prototype.put;
    let fail = true;
    IDBObjectStore.prototype.put = function(value, key) {
      if (this.name === 'sessions' && fail && value.session_id !== id && value.event_count === 0) {
        fail = false;
        throw new DOMException('Test quota failure', 'QuotaExceededError');
      }
      return key === undefined ? put.call(this, value) : put.call(this, value, key);
    };
  }, original.session_id);
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "discard", exact: true }).click();
  await expect(page.getByRole("button", { name: "retry saving" })).toBeVisible();
  await expect(canvas).toHaveValue("old");
  await page.getByRole("button", { name: "retry saving" }).click();
  await expect(canvas).toBeEditable();
  await canvas.pressSequentially("n");
  await expect.poll(async () => (await sessions(page)).flatMap(session => session.events)).toMatchObject([
    { seq: 0, op: "insert", pos: null, ins_len: 1, del_len: 0 },
  ]);
});
