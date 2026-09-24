import { expect, test } from "@playwright/test";

const unknown = { op: "replace", pos: null, del_len: null, ins_len: null, source: "unknown" };
const shape = ({ op, pos, del_len, ins_len, source }) => ({ op, pos, del_len, ins_len, source });

for (const producer of ["extension", "write"]) {
  test.describe(`${producer} applied capture parity`, () => {
    let field;
    let events;
    test.beforeEach(async ({ page }) => {
      page.on("pageerror", error => { throw error; });
      if (producer === "extension") {
        await page.goto("/extension-harness");
        field = page.getByLabel("plain field");
        await field.focus();
        await page.evaluate(() => window.__pmbah.activate());
        events = async () => (await page.evaluate(() => window.__pmbah.messages.filter(m => m.kind === "append_mutation").map(m => m.mutation))).map(shape);
      } else {
        await page.route("**/api/observed-sessions/*/checkpoints", route => route.fulfill({ status: 503, body: "unavailable" }));
        await page.goto("/write");
        field = page.getByRole("textbox", { name: "Writing canvas" });
        await expect(field).toBeEditable();
        await field.focus();
        events = async () => (await page.evaluate(() => new Promise((resolve, reject) => { const request = indexedDB.open("pmbah.write.journal.v1"); request.onerror = () => reject(request.error); request.onsuccess = () => { const db = request.result; const read = db.transaction("events").objectStore("events").getAll(); read.onsuccess = () => { db.close(); resolve(read.result.map(row => row.event)); }; read.onerror = () => reject(read.error); }; }))).map(shape);
      }
    });

    test("paste with absent event data measures the applied selection replacement", async () => {
      await field.pressSequentially("a🙂bc");
      await field.evaluate(element => {
        element.setSelectionRange(1, 4);
        element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertFromPaste", data: null }));
        element.value = "aXYZc";
        element.setSelectionRange(4, 4);
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: null }));
      });
      await expect.poll(async () => (await events()).at(-1)).toEqual({ op: "replace", pos: 1, del_len: 2, ins_len: 3, source: "paste" });
    });

    test("equal and unequal history replacements retain fully unknown measurements", async () => {
      await field.evaluate(element => {
        element.value = "cat";
        for (const value of ["dog", "elephant", "ox"]) {
          element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "historyUndo" }));
          element.value = value;
          element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "historyUndo" }));
        }
      });
      await expect.poll(events).toEqual([unknown, unknown, unknown]);
    });

    test("input without beforeinput is recorded as unknown", async () => {
      await field.evaluate(element => {
        element.value = "changed";
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "changed" }));
      });
      await expect.poll(events).toEqual([unknown]);
    });

    test("abandoned beforeinput cannot supply facts to a later isolated input", async () => {
      await field.evaluate(async element => {
        element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: "x" }));
        await new Promise(resolve => setTimeout(resolve, 10));
        element.value = "x";
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "x" }));
      });
      await expect.poll(events).toEqual([unknown]);
    });

    test("canceled selected composition emits nothing and committed composition emits once", async () => {
      await field.pressSequentially("abc");
      await field.evaluate(element => {
        element.setSelectionRange(0, 3);
        element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));
        element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        element.value = "語";
        element.setSelectionRange(1, 1);
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "語", isComposing: true }));
        element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "語" }));
        element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertCompositionText", data: "語" }));
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "語" }));
      });
      await expect.poll(async () => (await events()).slice(3)).toEqual([{ op: "replace", pos: 0, del_len: 3, ins_len: 1, source: "ime" }]);
    });

    test("finish detects a silent same-UTF16-size change to surrogate composition", async ({ page }) => {
      await field.pressSequentially("abc");
      await field.evaluate(element => { element.value = "a🙂"; });
      if (producer === "extension") {
        const result = await page.evaluate(() => new Promise(resolve => {
          const session_id = window.__pmbah.messages.find(message => message.kind === "append_mutation").session_id;
          window.__pmbah.listeners.forEach(listener => listener({ kind: "freeze_session", session_id, bind: true }, {}, resolve));
        }));
        expect(result.kind).toBe("binding_error");
        expect(result.reason).toContain("Capture has a gap");
      } else {
        await page.getByRole("button", { name: "sign", exact: true }).click();
        await page.getByRole("button", { name: "sign & upload", exact: true }).click();
        await expect(page.getByText("Capture has a gap.", { exact: false })).toBeVisible();
      }
    });

    test("formatting with unchanged length emits no mutation", async () => {
      await field.evaluate(element => {
        element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "formatBold" }));
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "formatBold" }));
      });
      expect(await events()).toEqual([]);
    });

    test("unobserved length changes mark only the next real edit after canceled or format cycles", async ({ page }) => {
      await field.pressSequentially("a");
      await field.evaluate(element => {
        element.value = "hidden";
        element.setSelectionRange(0, 0);
        element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: "canceled" }));
        element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "formatBold" }));
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "formatBold" }));
        element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));
      });
      expect(await events()).toEqual([{ op: "insert", pos: 0, del_len: 0, ins_len: 1, source: "typing" }]);
      await page.keyboard.type("zx");
      await expect.poll(events).toEqual([
        { op: "insert", pos: 0, del_len: 0, ins_len: 1, source: "typing" },
        { op: "insert", pos: null, del_len: 0, ins_len: 1, source: "typing" },
        { op: "insert", pos: 1, del_len: 0, ins_len: 1, source: "typing" },
      ]);
    });
  });
}

test("extension preserves unknown selection position for an email input", async ({ page }) => {
  await page.goto("/extension-harness");
  await page.evaluate(() => {
    const element = document.createElement("input");
    element.type = "email";
    element.setAttribute("aria-label", "email field");
    document.body.append(element);
    element.focus();
  });
  await page.evaluate(() => window.__pmbah.activate());
  await page.getByLabel("email field").evaluate(element => {
    element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: "a" }));
    element.value = "a";
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "a" }));
  });
  await expect.poll(() => page.evaluate(() => window.__pmbah.messages.filter(m => m.kind === "append_mutation").map(m => m.mutation))).toEqual([
    { op: "insert", pos: null, del_len: 0, ins_len: 1, source: "typing" },
  ]);
});

for (const rich of [false, true]) {
  for (const bind of [false, true]) {
    test(`extension ${rich ? "rich editor" : "text field"} checks final capture gap when binding=${bind}`, async ({ page }) => {
      await page.goto("/extension-harness");
      const field = page.getByLabel(rich ? "rich field" : "plain field");
      await field.focus();
      await page.evaluate(() => window.__pmbah.activate());
      await page.keyboard.type("a");
      await field.evaluate((element, rich) => {
        if (rich) element.textContent = "unobserved change";
        else element.value = "unobserved change";
      }, rich);
      const result = await page.evaluate(bind => new Promise(resolve => {
        const session_id = window.__pmbah.messages.find(message => message.kind === "append_mutation").session_id;
        window.__pmbah.listeners.forEach(listener => listener({ kind: "freeze_session", session_id, bind }, {}, resolve));
      }), bind);
      if (bind) {
        expect(result.kind).toBe("binding_error");
        expect(result.reason).toContain("Capture has a gap");
      } else expect(result).toEqual({ kind: "binding_result", text_binding: null });
      expect(await page.evaluate(() => window.__pmbah.messages.filter(message => message.kind === "append_mutation").length)).toBe(1);
    });
  }
}
