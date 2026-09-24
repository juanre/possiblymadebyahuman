import type { Operation, Source } from "../../../../packages/format/src/index.ts";
import type { PendingMutation } from "../../../../packages/producer-core/src/index.ts";

/**
 * Pure helpers for deriving codepoint-anchored process metadata from DOM input
 * events. None of these functions persist, hash, log, or upload text — they
 * inspect a transient string and immediately return numeric metadata. Callers
 * MUST not retain the inputs.
 */

export function codepointCount(text: string): number {
  // Array.from over a string yields codepoints (surrogate-pair safe).
  return Array.from(text).length;
}

export function codepointOffsetOf(text: string, utf16Index: number): number {
  if (utf16Index <= 0) return 0;
  if (utf16Index >= text.length) return codepointCount(text);
  return codepointCount(text.slice(0, utf16Index));
}

/**
 * Maps DOM InputEvent.inputType to the format's Source enum, honouring the
 * content-blindness rule: when the inputType is unknown or ambiguous, return
 * "unknown" rather than guessing.
 */
export { sourceFromInputType } from "../../../../packages/producer-core/src/measured-input.ts";
import { sourceFromInputType, unknownMutation } from "../../../../packages/producer-core/src/measured-input.ts";

export function operationFor(args: { ins_len: number; del_len: number }): Operation {
  if (args.del_len > 0 && args.ins_len === 0) return "delete";
  if (args.del_len > 0 && args.ins_len > 0) return "replace";
  return "insert";
}

export function insertedCodepointsForInput(inputType: string | null, insertedText: string): number {
  const count = codepointCount(insertedText);
  if (inputType === "insertLineBreak" || inputType === "insertParagraph") return Math.max(1, count);
  return count;
}

export function isDeletionInputType(inputType: string | null): boolean {
  return typeof inputType === "string" && inputType.startsWith("delete");
}

/** Undo, redo and formatting commands whose size is only measurable after the browser applies them. */
export function isNetChangeInputType(inputType: string | null): boolean {
  return typeof inputType === "string" && (inputType.startsWith("history") || inputType.startsWith("format"));
}

/**
 * A deletion with a collapsed caret (Backspace, Delete, word and line deletes)
 * has no selection to measure in `beforeinput`. The caller records the field's
 * codepoint length before the change and, once the browser has applied it,
 * passes the new length and caret. The deleted span always ends where the
 * caret lands, so pos is the caret and del_len is the length difference.
 */
export function collapsedDeletionMutation(args: {
  lengthBefore: number;
  lengthAfter: number;
  caretAfterCodepoints: number;
  source: Source;
}): PendingMutation | null {
  const del_len = args.lengthBefore - args.lengthAfter;
  if (del_len <= 0) return null;
  return { op: "delete", pos: Math.max(0, args.caretAfterCodepoints), del_len, ins_len: 0, source: args.source };
}

/** A net delta cannot establish either replacement size. */
export function netLengthChangeMutation(_args: { lengthBefore: number; lengthAfter: number }): PendingMutation {
  return unknownMutation();
}

/**
 * A spellcheck or autocorrect replacement carries the inserted text but replaces
 * a range the selection does not describe. With the inserted size known and the
 * field length before and after, the replaced span is the length difference and
 * it ends where the caret lands.
 */
export function measuredReplacementMutation(args: {
  lengthBefore: number;
  lengthAfter: number;
  insLen: number;
  caretAfterCodepoints: number;
  source: Source;
}): PendingMutation | null {
  const del_len = Math.max(0, args.lengthBefore - args.lengthAfter + args.insLen);
  if (del_len === 0 && args.insLen === 0) return null;
  return {
    op: operationFor({ ins_len: args.insLen, del_len }),
    pos: Math.max(0, args.caretAfterCodepoints - args.insLen),
    del_len,
    ins_len: args.insLen,
    source: args.source,
  };
}

/**
 * One IME composition is one `ime` mutation: the span selected when composition
 * started (already measured numerically by the caller) is replaced by the
 * committed text. A cancelled composition that replaced nothing records nothing.
 */
export function compositionMutation(args: {
  pos: number | null;
  del_len: number | null;
  committedText: string;
}): PendingMutation | null {
  const ins_len = codepointCount(args.committedText);
  const del_len = args.del_len;
  if (ins_len === 0 && (del_len ?? 0) === 0) return null;
  const op: Operation = del_len !== null ? operationFor({ ins_len, del_len }) : "insert";
  return { op, pos: args.pos, del_len, ins_len, source: "ime" };
}

/**
 * Contenteditable insertions expose their size through the input event's data
 * for typed text, through the drag/clipboard transfer for pastes and drops, and through
 * the structural Enter inputTypes. Anything else is unknown, not zero.
 */
export function contentEditableInsertedCodepoints(
  inputType: string | null,
  data: string | null,
  transferredText: string | null,
): number | null {
  if (inputType === "insertLineBreak" || inputType === "insertParagraph") return Math.max(1, codepointCount(data ?? ""));
  if (typeof data === "string" && data.length > 0) return codepointCount(data);
  if (typeof transferredText === "string" && transferredText.length > 0) return codepointCount(transferredText);
  return null;
}

/**
 * Synchronously builds a PendingMutation from a textarea/input `beforeinput`
 * cycle. The caller reads the field's pre-change text transiently from
 * `event.target.value` at the call site, passes it in as `text`, and the
 * helper computes codepoint-anchored numeric metadata. Neither the caller nor
 * this helper retains the text after the call returns — that is the content-
 * opacity rule and it is enforced by the consumer-side static audit.
 *
 * If the selection facts are unreliable (start === end at the same point with
 * no inserted text, or the inputType is structural/ambiguous) the caller is
 * expected to degrade explicitly and emit nulls — there is no diff fallback,
 * because a diff fallback would require retaining text between events.
 */
export function buildTextFieldMutation(args: {
  text: string;
  selectionStartUtf16: number;
  selectionEndUtf16: number;
  insertedText: string;
  inputType: string | null;
}): PendingMutation {
  const ins_len = insertedCodepointsForInput(args.inputType, args.insertedText);
  const del_start = Math.min(args.selectionStartUtf16, args.selectionEndUtf16);
  const del_end = Math.max(args.selectionStartUtf16, args.selectionEndUtf16);
  const deletedSlice = args.text.slice(del_start, del_end);
  const del_len = codepointCount(deletedSlice);
  const pos = codepointOffsetOf(args.text, del_start);
  return {
    op: operationFor({ ins_len, del_len }),
    pos,
    del_len,
    ins_len,
    source: sourceFromInputType(args.inputType),
  };
}
