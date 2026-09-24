import { expect, test } from "@playwright/test";
import { computeObservedLength, validateEventLog } from "../../packages/format/src/index.ts";

async function events(page) { return page.evaluate(() => window.__pmbah.messages.filter(m => m.kind === "append_mutation").map((m, seq) => ({ seq, t: seq * 10, ...m.mutation }))); }
async function start(page, html = "") {
  await page.goto("/extension-harness");
  const rich = page.getByLabel("rich field");
  await rich.evaluate((el, html) => { el.innerHTML = html; }, html);
  await rich.focus();
  const response = await page.evaluate(() => window.__pmbah.activate());
  expect(response.session_id).toBeTruthy();
  return rich;
}
async function expectLength(page, length) {
  const log = await events(page);
  expect(validateEventLog(log)).toEqual([]);
  expect(computeObservedLength(log)).toBe(length);
}

test("empty Gmail-shaped body has exact typing positions and ignores cancelled beforeinput", async ({ page }) => {
  const rich = await start(page, "<div><br></div>");
  await rich.evaluate(el => el.addEventListener("beforeinput", event => event.preventDefault(), { once: true }));
  await page.keyboard.type("x");
  expect(await events(page)).toEqual([]);
  await page.keyboard.type("hello");
  expect((await events(page)).map(e => [e.pos, e.ins_len, e.del_len])).toEqual([[0,1,0],[1,1,0],[2,1,0],[3,1,0],[4,1,0]]);
  await expectLength(page, 5);
});

test("paragraphs, BRs, emoji, selection replacement and word deletion share one codepoint model", async ({ page }) => {
  await start(page);
  await page.keyboard.type("ab");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("😀");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("word");
  await expectLength(page, 9); // ab newline emoji newline word
  await page.keyboard.press("ControlOrMeta+Shift+ArrowLeft");
  await page.keyboard.type("z");
  await expectLength(page, 6);
  await page.keyboard.press("Backspace");
  await expectLength(page, 5);
  await page.keyboard.press("Backspace");
  await expectLength(page, 4);
});

test("native paste replaces the selected span with applied numeric sizes only", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await start(page);
  await page.keyboard.type("hello");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.evaluate(() => navigator.clipboard.writeText("😀abc"));
  await page.keyboard.press("ControlOrMeta+v");
  await expect.poll(async () => (await events(page)).at(-1)?.source).toBe("paste");
  expect((await events(page)).at(-1)).toMatchObject({ op: "replace", pos: 4, del_len: 1, ins_len: 4, source: "paste" });
  await expectLength(page, 8);
  expect(JSON.stringify(await page.evaluate(() => window.__pmbah.messages))).not.toContain("😀abc");
});

test("native IME yields one precise mutation, followed by precise typing", async ({ page, context }) => {
  await start(page);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "に", selectionStart: 1, selectionEnd: 1 });
  await cdp.send("Input.imeSetComposition", { text: "日本", selectionStart: 2, selectionEnd: 2 });
  await cdp.send("Input.insertText", { text: "日本" });
  await page.keyboard.type("!");
  const log = await events(page);
  expect(log).toHaveLength(2);
  expect(log[0]).toMatchObject({ pos: 0, del_len: 0, ins_len: 2, source: "ime" });
  expect(log[1]).toMatchObject({ pos: 2, del_len: 0, ins_len: 1, source: "typing" });
  await expectLength(page, 3);
});

test("undo retains measured size with unknown position and formatting adds no phantom text", async ({ page }) => {
  await start(page);
  await page.keyboard.type("hello");
  await page.keyboard.press("ControlOrMeta+a");
  const count = (await events(page)).length;
  await page.keyboard.press("ControlOrMeta+b");
  expect((await events(page)).length).toBe(count);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ControlOrMeta+z"); // undo bold, no text change, unknown history operation
  await page.keyboard.press("ControlOrMeta+z"); // undo typing
  expect((await events(page)).some(e => e.source === "unknown" && e.pos === null)).toBe(true);
  expect(validateEventLog(await events(page))).toEqual([]);
});

test("uncaptured programmatic edits cannot produce a fabricated exact length", async ({ page }) => {
  const rich = await start(page);
  await page.keyboard.type("a");
  await rich.evaluate(el => { el.append("UNOBSERVED"); const selection = getSelection(); selection.selectAllChildren(el); selection.collapseToEnd(); });
  await page.keyboard.type("b");
  const log = await events(page);
  expect(log).toHaveLength(2);
  expect(log[1]).toMatchObject({ pos: null, del_len: 0, ins_len: 1, source: "typing" });
  expect(computeObservedLength(log)).toBeNull();
});

test("rich capture gaps survive formatting and canceled compositions without synthetic events", async ({ page }) => {
  const rich = await start(page);
  await page.keyboard.type("a");
  await rich.evaluate(element => {
    element.textContent = "hidden";
    const selection = getSelection();
    selection.selectAllChildren(element);
    selection.collapseToStart();
    element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: "canceled" }));
    element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "formatBold" }));
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "formatBold" }));
    element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));
  });
  expect(await events(page)).toHaveLength(1);
  await page.keyboard.type("zx");
  const log = await events(page);
  expect(log).toHaveLength(3);
  expect(log[1]).toMatchObject({ pos: null, del_len: 0, ins_len: 1, source: "typing" });
  expect(log[2]).toMatchObject({ pos: 1, del_len: 0, ins_len: 1, source: "typing" });
  expect(computeObservedLength(log)).toBeNull();
});

test("native collapsed word and surrogate-pair deletion use the actual target range", async ({ page }) => {
  await start(page);
  await page.keyboard.type("hello word");
  await page.keyboard.press(process.platform === "darwin" ? "Alt+Backspace" : "Control+Backspace");
  expect((await events(page)).at(-1)).toMatchObject({ op: "delete", pos: 6, del_len: 4, ins_len: 0 });
  await page.keyboard.insertText("😀");
  await page.keyboard.press("Backspace");
  expect((await events(page)).at(-1)).toMatchObject({ op: "delete", pos: 6, del_len: 1, ins_len: 0 });
  await expectLength(page, 6);
});

test("inline bold markup and line breaks retain a consistent length", async ({ page }) => {
  await start(page);
  await page.keyboard.press("ControlOrMeta+b");
  await page.keyboard.type("a");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("b");
  await page.keyboard.press("ControlOrMeta+b");
  await page.keyboard.type("c");
  await expectLength(page, 4);
});

test("canceled rich edit does not make finish report an incomplete edit", async ({ page }) => {
  const rich = await start(page);
  await page.keyboard.type("hello");
  await rich.evaluate(el => el.addEventListener("beforeinput", event => event.preventDefault(), { once: true }));
  await page.keyboard.type("x");
  const result = await page.evaluate(() => new Promise(resolve => {
    const session_id = window.__pmbah.messages.find(m => m.kind === "append_mutation").session_id;
    window.__pmbah.listeners.forEach(listener => listener({ kind: "freeze_session", session_id, bind: true }, {}, resolve));
  }));
  expect(result, `Unexpected finish reason: ${result.reason ?? "none"}`).toMatchObject({ kind: "binding_result" });
  expect(result.text_binding).toBeTruthy();
  await page.keyboard.type("invisible-after-finish");
  expect((await events(page)).length).toBe(5);
});

test("process-only finish never reads text or creates a wording commitment", async ({ page }) => {
  const rich = await start(page);
  await page.keyboard.type("private words");
  await rich.evaluate(el => {
    Object.defineProperty(el, "textContent", { get() { throw new Error("A process-only finish read editor text"); } });
  });
  const result = await page.evaluate(() => new Promise(resolve => {
    const session_id = window.__pmbah.messages.find(m => m.kind === "append_mutation").session_id;
    window.__pmbah.listeners.forEach(listener => listener({ kind: "freeze_session", session_id, bind: false }, {}, resolve));
  }));
  expect(result).toEqual({ kind: "binding_result", text_binding: null });
  const retry = await page.evaluate(() => new Promise(resolve => {
    const session_id = window.__pmbah.messages.find(m => m.kind === "append_mutation").session_id;
    window.__pmbah.listeners.forEach(listener => listener({ kind: "freeze_session", session_id, bind: true }, {}, resolve));
  }));
  expect(retry).toEqual({ kind: "binding_result", text_binding: null });
  expect(JSON.stringify(await page.evaluate(() => window.__pmbah.messages))).not.toContain("commitment");
});

test("finish ignores a canceled beforeinput even before its cleanup timer can run", async ({ page }) => {
  await start(page);
  await page.keyboard.type("hello");
  const { prevented, result } = await page.evaluate(async () => {
    const el = document.querySelector("#rich");
    el.addEventListener("beforeinput", event => event.preventDefault(), { once: true });
    const input = new InputEvent("beforeinput", { inputType: "insertText", data: "x", bubbles: true, cancelable: true });
    el.dispatchEvent(input);
    // Dispatch finish in the same JavaScript task. No timer is allowed to run
    // first, making the abandoned measurement-cycle race deterministic.
    const session_id = window.__pmbah.messages.find(m => m.kind === "append_mutation").session_id;
    const result = await new Promise(resolve => window.__pmbah.listeners.forEach(listener => listener({ kind: "freeze_session", session_id, bind: true }, {}, resolve)));
    return { prevented: input.defaultPrevented, result };
  });
  expect(prevented).toBe(true);
  expect(result, `Unexpected finish reason: ${result.reason ?? "none"}`).toMatchObject({ kind: "binding_result" });
  expect(result.text_binding).toBeTruthy();
  expect((await events(page)).length).toBe(5);
});

test("finish still refuses wording binding during a native composition", async ({ page, context }) => {
  await start(page);
  await page.keyboard.type("a");
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "に", selectionStart: 1, selectionEnd: 1 });
  const result = await page.evaluate(() => new Promise(resolve => {
    const session_id = window.__pmbah.messages.find(m => m.kind === "append_mutation").session_id;
    window.__pmbah.listeners.forEach(listener => listener({ kind: "freeze_session", session_id, bind: true }, {}, resolve));
  }));
  expect(result).toEqual({ kind: "binding_error", reason: "An edit was still incomplete. The record has stopped; a text binding is unavailable." });
  await cdp.send("Input.insertText", { text: "日本" });
  expect((await events(page)).length).toBe(1);
});

test('finished rich editors release observers and a later start measures a fresh baseline', async ({ page }) => {
  const rich = await start(page);
  await page.keyboard.type('a');
  const stopped = await rich.evaluate(async element => {
    element.dispatchEvent(new InputEvent('beforeinput', {bubbles:true,inputType:'insertText',data:'canceled'}));
    const session_id=window.__pmbah.messages.find(message=>message.kind==='append_mutation').session_id;
    await new Promise(resolve=>window.__pmbah.listeners.forEach(listener=>listener({kind:'freeze_session',session_id,bind:false},{},resolve)));
    let reads=0;const native=String.prototype.charCodeAt;
    String.prototype.charCodeAt=function(...args){reads++;return native.apply(this,args);};
    try{
      await new Promise(resolve=>setTimeout(resolve,10));
      element.textContent='xx🙂';
      await new Promise(resolve=>setTimeout(resolve,0));
      return reads;
    }finally{String.prototype.charCodeAt=native;}
  });
  expect(stopped).toBe(0);
  await rich.focus();
  await page.evaluate(()=>window.__pmbah.activate());
  await page.keyboard.press('End');
  await page.keyboard.type('b');
  const log=await events(page);
  expect(log).toHaveLength(2);
  expect(log.at(-1)).toMatchObject({pos:3,ins_len:1,del_len:0});
});
