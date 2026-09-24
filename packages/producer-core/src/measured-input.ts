import type { Source } from "../../format/src/index.ts";
import type { PendingMutation } from "./types.ts";

// Numeric facts only. The DOM adapters inspect text transiently and discard it.
export type MeasuredInputIntent = {
  inputType: string;
  lengthBefore: number;
  selectionStartCodepoints: number | null;
  selectedCodepoints: number | null;
  dataCodepoints: number | null;
};

export function sourceFromInputType(inputType: string | null | undefined): Source {
  switch (inputType) {
    case "insertText": case "insertLineBreak": case "insertParagraph":
    case "deleteContentBackward": case "deleteContentForward":
    case "deleteWordBackward": case "deleteWordForward":
    case "deleteSoftLineBackward": case "deleteSoftLineForward":
    case "deleteHardLineBackward": case "deleteHardLineForward": return "typing";
    case "insertFromPaste": case "insertFromPasteAsQuotation": return "paste";
    case "deleteByCut": return "cut";
    case "insertFromDrop": case "deleteByDrag": return "drop";
    case "insertCompositionText": case "insertFromComposition": return "ime";
    case "insertReplacementText": case "insertFromYank": return "autocomplete";
    default: return "unknown";
  }
}

export function unknownMutation(source: Source = "unknown"): PendingMutation {
  return { op: "replace", pos: null, del_len: null, ins_len: null, source };
}

export function lineBreakInsertedCodepoints(inputType: string, dataCodepoints = 0): number | null {
  return inputType === "insertParagraph" || inputType === "insertLineBreak" ? Math.max(1, dataCodepoints) : null;
}

export function deriveMutationFromMeasuredInput(
  intent: MeasuredInputIntent, lengthAfter: number, caretAfter: number | null,
): PendingMutation | null {
  const delta = lengthAfter - intent.lengthBefore;
  const source = sourceFromInputType(intent.inputType);
  if (intent.inputType.startsWith("format") && delta === 0) return null;
  // Net length is not either replacement size. Undo may replace 10 characters
  // with 7; reporting a deletion of 3 would invent a different operation.
  if (intent.inputType.startsWith("history")) return unknownMutation();
  if (intent.inputType.startsWith("delete") && delta < 0) {
    const pos = caretAfter !== null && caretAfter >= 0 && caretAfter - delta <= intent.lengthBefore ? caretAfter : null;
    return { op: "delete", pos, del_len: -delta, ins_len: 0, source };
  }
  if (intent.inputType.startsWith("insert")) {
    const inserted = lineBreakInsertedCodepoints(intent.inputType, intent.dataCodepoints ?? 0)
      ?? intent.dataCodepoints
      ?? (["insertText", "insertFromPaste", "insertFromPasteAsQuotation", "insertFromDrop", "insertFromYank"].includes(intent.inputType)
        && intent.selectedCodepoints !== null ? delta + intent.selectedCodepoints : null);
    if (inserted !== null && inserted > 0) {
      const deleted = inserted - delta;
      const replacement = intent.inputType === "insertReplacementText";
      const pos = replacement ? (caretAfter === null ? null : caretAfter - inserted) : intent.selectionStartCodepoints;
      if (deleted >= 0 && deleted <= intent.lengthBefore &&
          (replacement || intent.selectedCodepoints === null || deleted === intent.selectedCodepoints) &&
          (pos === null || (pos >= 0 && pos + deleted <= intent.lengthBefore && (caretAfter === null || caretAfter === pos + inserted)))) {
        return { op: deleted > 0 ? "replace" : "insert", pos, del_len: deleted, ins_len: inserted, source };
      }
    }
  }
  return unknownMutation(source);
}
