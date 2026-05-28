import assert from "node:assert/strict";
import test from "node:test";

import { deriveMutationFromMeasuredInput, sourceFromInputType } from "../apps/web/src/write-capture.ts";

test("/write measured input mapping preserves codepoint counts without text", () => {
  assert.deepEqual(deriveMutationFromMeasuredInput({
    inputType: "insertText",
    selectionStartCodepoints: 1,
    selectedCodepoints: 0,
    dataCodepoints: 1,
    hasBackwardCodepoint: true,
    hasForwardCodepoint: false,
  }), { op: "insert", pos: 1, del_len: 0, ins_len: 1, source: "typing" });

  assert.deepEqual(deriveMutationFromMeasuredInput({
    inputType: "insertFromPaste",
    selectionStartCodepoints: 2,
    selectedCodepoints: 1,
    dataCodepoints: 3,
    hasBackwardCodepoint: true,
    hasForwardCodepoint: true,
  }), { op: "replace", pos: 2, del_len: 1, ins_len: 3, source: "paste" });

  assert.deepEqual(deriveMutationFromMeasuredInput({
    inputType: "deleteContentBackward",
    selectionStartCodepoints: 4,
    selectedCodepoints: 0,
    dataCodepoints: 0,
    hasBackwardCodepoint: true,
    hasForwardCodepoint: false,
  }), { op: "delete", pos: 3, del_len: 1, ins_len: 0, source: "typing" });
});

test("/write source attribution is conservative", () => {
  assert.equal(sourceFromInputType("insertFromPaste"), "paste");
  assert.equal(sourceFromInputType("deleteByCut"), "cut");
  assert.equal(sourceFromInputType("insertFromDrop"), "drop");
  assert.equal(sourceFromInputType("insertCompositionText"), "ime");
  assert.equal(sourceFromInputType("formatBold"), "unknown");
});
