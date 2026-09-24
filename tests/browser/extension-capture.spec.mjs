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

test("capture times survive pending registration and serialized acknowledgement queues", async ({ page }) => {
  await page.goto("/extension-harness");
  await page.getByLabel("plain field").focus();
  await page.evaluate(() => {
    window.__captureClock = 1_000;
    Date.now = () => window.__captureClock;
    const send = chrome.runtime.sendMessage;
    const registration = new Promise(resolve => { window.__releaseRegistration = resolve; });
    const acknowledgement = new Promise(resolve => { window.__releaseAcknowledgement = resolve; });
    chrome.runtime.sendMessage = async message => {
      if (message.kind === "register_field") await registration;
      const response = await send(message);
      if (message.kind === "append_mutation") await acknowledgement;
      return response;
    };
    window.__activation = window.__pmbah.activate();
  });
  await page.evaluate(() => { window.__captureClock = 1_010; });
  await page.keyboard.type("a");
  await page.evaluate(() => { window.__captureClock = 1_025; });
  await page.keyboard.type("b");
  expect(await mutations(page)).toHaveLength(0);
  await page.evaluate(async () => {
    window.__captureClock = 5_000;
    window.__releaseRegistration();
    await window.__activation;
  });
  await expect.poll(async () => (await mutations(page)).length).toBe(1);
  await page.evaluate(() => { window.__captureClock = 1_035; });
  await page.keyboard.type("c");
  expect(await mutations(page)).toHaveLength(1);
  await page.evaluate(() => { window.__captureClock = 8_000; window.__releaseAcknowledgement(); });
  await expect.poll(async () => (await mutations(page)).length).toBe(3);
  const messages = await page.evaluate(() => window.__pmbah.messages);
  expect(messages.find(message => message.kind === "register_field").started_at_wall_ms).toBe(1_000);
  expect(messages.filter(message => message.kind === "append_mutation").map(message => message.captured_at_wall_ms)).toEqual([1_010, 1_025, 1_035]);
});

test.describe("extension content script in a real page", () => {
  test.beforeEach(async ({ page }) => {
    page.on("pageerror", (error) => { throw error; });
    await page.goto("/extension-harness");
  });

  test("focus and typing are dormant until the person chooses an editor, with no page overlays", async ({ page }) => {
    const plain = page.getByLabel("plain field");
    await plain.fill("private draft");
    await page.getByLabel("rich field").fill("unrelated draft");
    expect(await page.evaluate(() => window.__pmbah.messages)).toEqual([]);
    await plain.fill("");
    await plain.focus();
    await page.evaluate(() => window.__pmbah.activate());
    await expect.poll(() => page.evaluate(() => window.__pmbah.messages.filter((m) => m.kind === "register_field").length)).toBe(1);
    await expect(page.locator("[data-pmbah-badge], [data-pmbah-state], [data-pmbah-session]")).toHaveCount(0);
    await page.keyboard.type("a");
    expect((await mutations(page)).length).toBe(1);
    await page.getByLabel("rich field").fill("still unrelated");
    expect((await mutations(page)).length).toBe(1);
  });

  test("typing, Backspace, selection and Enter produce consistent events, including after a no-op Backspace", async ({ page }) => {
    const field = page.getByLabel("plain field");
    await field.focus();
    await page.evaluate(() => window.__pmbah.activate());

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

  test("undo preserves unknown sizes and position and leaves later typing exact", async ({ page }) => {
    const field = page.getByLabel("plain field");
    await field.focus();
    await page.evaluate(() => window.__pmbah.activate());
    await page.keyboard.type("ab");
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => (await field.inputValue()).length < 2).toBe(true);
    await page.keyboard.type("c");
    const events = await mutations(page);
    const undo = events.find((event) => event.source === "unknown");
    expect(undo).toBeTruthy();
    expect(undo.pos).toBeNull();
    expect(undo).toMatchObject({ op: "replace", del_len: null, ins_len: null });
    expect(events.at(-1).op).toBe("insert");
    expect(events.at(-1).ins_len).toBe(1);
    expect(validateEventLog(events.map((event, seq) => ({ seq, t: seq * 10, ...event })))).toEqual([]);
  });

  test("contenteditable records exact positions and lengths, and a no-op Backspace does not double the next insert", async ({ page }) => {
    const rich = page.getByLabel("rich field");
    await rich.focus();
    await page.evaluate(() => window.__pmbah.activate());
    await page.keyboard.press("Backspace"); // empty editor: nothing happens
    await page.keyboard.type("ab");
    await page.keyboard.press("Backspace");
    await expect.poll(async () => (await mutations(page)).length).toBe(3);
    expect(shapes(await mutations(page))).toEqual([
      { op: "insert", pos: 0, del_len: 0, ins_len: 1, source: "typing" },
      { op: "insert", pos: 1, del_len: 0, ins_len: 1, source: "typing" },
      { op: "delete", pos: 1, del_len: 1, ins_len: 0, source: "typing" },
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
  await page.evaluate(() => window.__pmbah.activate());
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


test("trusted right-click chooses the exact editor despite later focus or synthetic retargeting", async ({ page }) => {
  await page.goto("/extension-harness");
  const plain = page.getByLabel("plain field");
  const rich = page.getByLabel("rich field");
  await plain.focus();
  await rich.click({ button: "right" });
  // A page script or intervening focus change must not replace the editor
  // chosen by the actual user gesture while its browser menu is open.
  await plain.evaluate(element => {
    element.focus();
    element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  });
  expect(await page.evaluate(() => window.__pmbah.messages)).toEqual([]);
  const result = await page.evaluate(() => window.__pmbah.activate("context"));
  expect(result.kind).toBe("start_editor_result");
  expect(result.session_id).toBeTruthy();
  const registrations = await page.evaluate(() => window.__pmbah.messages.filter(message => message.kind === "register_field"));
  expect(registrations).toHaveLength(1);
  expect(registrations[0].descriptor.aria_label).toBe("rich field");
  await plain.fill("unselected private text");
  expect(await mutations(page)).toEqual([]);
  await rich.focus();
  await page.keyboard.type("a");
  expect(shapes(await mutations(page))).toEqual([{ op: "insert", pos: 0, del_len: 0, ins_len: 1, source: "typing" }]);
  expect((await page.evaluate(() => window.__pmbah.activate("context"))).reason).toBeTruthy();
  expect(await page.evaluate(() => window.__pmbah.messages.filter(message => message.kind === "register_field").length)).toBe(1);
});
