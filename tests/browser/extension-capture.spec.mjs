import { expect, test } from "@playwright/test";

import { computeObservedLength, validateEventLog } from "../../packages/format/src/index.ts";

// Drives the built content script with real key events, the way Chrome would
// run it, and checks the numeric mutations it sends to the (stubbed) worker.
async function mutations(page) {
  return page.evaluate(() => window.__pmbah.messages.filter((m) => m.kind === "append_mutation").map((m) => m.mutation));
}

function shapes(list) {
  return list.map(({ op, pos, del_len, ins_len, source }) => ({ op, pos, del_len, ins_len, source }));
}

test.describe("extension content script in a real page", () => {
  test.beforeEach(async ({ page }) => {
    page.on("pageerror", (error) => { throw error; });
    await page.goto("/extension-harness");
  });

  test("loads as a classic script and registers a focused textarea", async ({ page }) => {
    await page.getByLabel("plain field").focus();
    await expect.poll(() => page.evaluate(() => window.__pmbah.messages.some((m) => m.kind === "register_field"))).toBe(true);
    await expect(page.locator("[data-pmbah-state='recording']")).toHaveCount(1);
  });

  test("typing, Backspace, selection and Enter produce consistent events, including after a no-op Backspace", async ({ page }) => {
    const field = page.getByLabel("plain field");
    await field.focus();
    await expect(page.locator("[data-pmbah-state='recording']")).toHaveCount(1);

    await page.keyboard.type("abc");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Home");
    await page.keyboard.press("Backspace"); // nothing to delete: must record nothing and leave nothing stale
    await page.keyboard.type("z");
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Shift+ArrowLeft");
    await page.keyboard.press("Backspace");

    await expect.poll(async () => (await mutations(page)).length).toBe(7);
    const events = await mutations(page);
    expect(shapes(events)).toEqual([
      { op: "insert", pos: 0, del_len: 0, ins_len: 1, source: "typing" },
      { op: "insert", pos: 1, del_len: 0, ins_len: 1, source: "typing" },
      { op: "insert", pos: 2, del_len: 0, ins_len: 1, source: "typing" },
      { op: "delete", pos: 2, del_len: 1, ins_len: 0, source: "typing" },
      { op: "insert", pos: 0, del_len: 0, ins_len: 1, source: "typing" },
      { op: "insert", pos: 3, del_len: 0, ins_len: 1, source: "typing" },
      { op: "delete", pos: 3, del_len: 1, ins_len: 0, source: "typing" },
    ]);
    const log = events.map((event, seq) => ({ seq, t: seq * 10, ...event }));
    expect(validateEventLog(log)).toEqual([]);
    expect(computeObservedLength(log)).toBe(3);
    expect(await field.inputValue()).toBe("zab");
  });

  test("undo records a net change with unknown position and leaves later typing exact", async ({ page }) => {
    const field = page.getByLabel("plain field");
    await field.focus();
    await expect(page.locator("[data-pmbah-state='recording']")).toHaveCount(1);
    await page.keyboard.type("ab");
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => (await field.inputValue()).length < 2).toBe(true);
    await page.keyboard.type("c");
    const events = await mutations(page);
    const undo = events.find((event) => event.source === "unknown");
    expect(undo).toBeTruthy();
    expect(undo.pos).toBeNull();
    expect(undo.op).toBe("delete");
    expect(events.at(-1).op).toBe("insert");
    expect(events.at(-1).ins_len).toBe(1);
    expect(validateEventLog(events.map((event, seq) => ({ seq, t: seq * 10, ...event })))).toEqual([]);
  });

  test("contenteditable records sizes only, and a no-op Backspace does not double the next insert", async ({ page }) => {
    const rich = page.getByLabel("rich field");
    await rich.focus();
    await expect(page.locator("[data-pmbah-state='recording']")).toHaveCount(1);
    await page.keyboard.press("Backspace"); // empty editor: nothing happens
    await page.keyboard.type("ab");
    await page.keyboard.press("Backspace");
    await expect.poll(async () => (await mutations(page)).length).toBe(3);
    expect(shapes(await mutations(page))).toEqual([
      { op: "insert", pos: null, del_len: null, ins_len: 1, source: "typing" },
      { op: "insert", pos: null, del_len: null, ins_len: 1, source: "typing" },
      { op: "delete", pos: null, del_len: 1, ins_len: 0, source: "typing" },
    ]);
  });
});

test("directly appended textarea is captured, and cancelled edits emit no mutation", async ({ page }) => {
  await page.goto("/extension-harness");
  await page.evaluate(() => {
    const field = document.createElement("textarea");
    field.setAttribute("aria-label", "dynamic field");
    document.body.append(field);
  });
  const field = page.getByLabel("dynamic field");
  await field.focus();
  await expect(page.locator("[data-pmbah-state='recording']")).toHaveCount(1);
  await field.evaluate((element) => {
    element.addEventListener("beforeinput", (event) => event.preventDefault(), { once: true });
  });
  await page.keyboard.type("x");
  await expect(field).toHaveValue("");
  expect(await mutations(page)).toEqual([]);
  await page.keyboard.type("y");
  await expect.poll(async () => (await mutations(page)).length).toBe(1);
  expect((await mutations(page))[0]).toMatchObject({ op: "insert", pos: 0, ins_len: 1 });
});
