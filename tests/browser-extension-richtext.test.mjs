import assert from "node:assert/strict";
import test from "node:test";
import { richMutation } from "../apps/browser-extension/src/lib/richtext.ts";

test("rich measurement rejects a transformed replacement whose final caret contradicts the target range", () => {
  const mutation = richMutation({ length: 4, start: 2, end: 2, kind: "insert", source: "typing" }, { length: 7, start: 7, end: 7 });
  assert.deepEqual(mutation, { op: "replace", pos: null, del_len: null, ins_len: null, source: "typing" });
});

test("equal-length undo stays visible without claiming an exact location", () => {
  assert.deepEqual(richMutation({ length: 4, start: 2, end: 2, kind: "history", source: "unknown" }, { length: 4, start: 2, end: 2 }),
    { op: "replace", pos: null, del_len: null, ins_len: null, source: "unknown" });
});

test("formatting without a numeric change emits no phantom edit", () => {
  assert.equal(richMutation({ length: 4, start: 1, end: 3, kind: "format", source: "unknown" }, { length: 4, start: 1, end: 3 }), null);
});

test("rich replacement derives applied size rather than trusting input data", () => {
  assert.deepEqual(richMutation({ length: 6, start: 1, end: 4, kind: "insert", source: "paste" }, { length: 5, start: 3, end: 3 }),
    { op: "replace", pos: 1, del_len: 3, ins_len: 2, source: "paste" });
});
