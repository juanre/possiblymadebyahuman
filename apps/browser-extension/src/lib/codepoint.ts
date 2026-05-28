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
export function sourceFromInputType(inputType: string | undefined | null): Source {
  if (!inputType) return "unknown";
  switch (inputType) {
    case "insertText":
    case "insertLineBreak":
    case "insertParagraph":
      return "typing";
    case "insertFromPaste":
    case "insertFromPasteAsQuotation":
      return "paste";
    case "insertFromDrop":
      return "drop";
    case "insertCompositionText":
    case "insertFromComposition":
      return "ime";
    case "insertReplacementText":
      return "autocomplete";
    case "deleteByCut":
      return "cut";
    case "deleteContentBackward":
    case "deleteContentForward":
    case "deleteWordBackward":
    case "deleteWordForward":
    case "deleteSoftLineBackward":
    case "deleteSoftLineForward":
    case "deleteHardLineBackward":
    case "deleteHardLineForward":
    case "deleteByDrag":
      return "typing";
    default:
      return "unknown";
  }
}

export function operationFor(args: { ins_len: number; del_len: number }): Operation {
  if (args.del_len > 0 && args.ins_len === 0) return "delete";
  if (args.del_len > 0 && args.ins_len > 0) return "replace";
  return "insert";
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
  const ins_len = codepointCount(args.insertedText);
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
