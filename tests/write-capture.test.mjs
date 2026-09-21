import assert from "node:assert/strict";
import test from "node:test";
import { deriveMutationFromMeasuredInput as derive, lineBreakInsertedCodepoints, sourceFromInputType } from "../apps/web/src/write-capture.ts";

const intent = (inputType, lengthBefore, start, selected = 0, dataCodepoints = null) => ({
  inputType, lengthBefore, selectionStartCodepoints: start, selectedCodepoints: selected, dataCodepoints,
});

test("/write uses applied codepoint changes for word and grapheme deletions", () => {
  assert.deepEqual(derive(intent("deleteWordBackward", 11, 11), 6, 6),
    { op: "delete", pos: 6, del_len: 5, ins_len: 0, source: "typing" });
  assert.deepEqual(derive(intent("deleteContentBackward", 8, 8), 1, 1),
    { op: "delete", pos: 1, del_len: 7, ins_len: 0, source: "typing" });
  assert.deepEqual(derive(intent("deleteContentForward", 8, 1), 1, 1),
    { op: "delete", pos: 1, del_len: 7, ins_len: 0, source: "typing" });
});

test("/write measures insertion, selection replacement and autocorrect", () => {
  assert.deepEqual(derive(intent("insertText", 2, 1, 0, 1), 3, 2),
    { op: "insert", pos: 1, del_len: 0, ins_len: 1, source: "typing" });
  assert.deepEqual(derive(intent("insertFromPaste", 4, 1, 2, 3), 5, 4),
    { op: "replace", pos: 1, del_len: 2, ins_len: 3, source: "paste" });
  assert.deepEqual(derive(intent("insertReplacementText", 9, 9, 0, 4), 10, 7),
    { op: "replace", pos: 3, del_len: 3, ins_len: 4, source: "autocomplete" });
});

test("/write undo/redo retain uncertainty, including an equal-length replacement", () => {
  assert.deepEqual(derive(intent("historyUndo", 3, 3), 0, 0),
    { op: "delete", pos: null, del_len: 3, ins_len: null, source: "unknown" });
  assert.deepEqual(derive(intent("historyRedo", 3, 3), 3, 3),
    { op: "replace", pos: null, del_len: null, ins_len: null, source: "unknown" });
});

test("/write captures applied line breaks with empty event data", () => {
  for (const type of ["insertParagraph", "insertLineBreak"]) {
    assert.equal(lineBreakInsertedCodepoints(type), 1);
    assert.deepEqual(derive(intent(type, 5, 2, 3), 3, 3),
      { op: "replace", pos: 2, del_len: 3, ins_len: 1, source: "typing" });
  }
});

test("/write source attribution is conservative", () => {
  for (const [type, source] of [["insertFromPaste","paste"], ["deleteByCut","cut"],
    ["deleteByDrag","drop"], ["insertCompositionText","ime"], ["formatBold","unknown"],
    ["insertMadeUpType","unknown"]]) assert.equal(sourceFromInputType(type), source);
});
