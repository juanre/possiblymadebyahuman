import type { PendingMutation } from "../../../packages/producer-core/src/index.ts";
import type { Source } from "../../../packages/format/src/index.ts";

export type MeasuredInputIntent = {
  inputType: string;
  selectionStartCodepoints: number;
  selectedCodepoints: number;
  dataCodepoints: number;
  hasBackwardCodepoint: boolean;
  hasForwardCodepoint: boolean;
};

export function sourceFromInputType(inputType: string): Source {
  if (inputType.includes("FromPaste")) return "paste";
  if (inputType.includes("ByCut")) return "cut";
  if (inputType.includes("FromDrop")) return "drop";
  if (inputType.includes("Composition")) return "ime";
  if (inputType.includes("Replacement") || inputType.includes("FromYank")) return "autocomplete";
  if (inputType.startsWith("insert") || inputType.startsWith("delete")) return "typing";
  return "unknown";
}

export function lineBreakInsertedCodepoints(inputType: string, dataCodepoints = 0): number | null {
  return inputType === "insertParagraph" || inputType === "insertLineBreak" ? Math.max(1, dataCodepoints) : null;
}

export function deriveMutationFromMeasuredInput(intent: MeasuredInputIntent): PendingMutation | null {
  const source = sourceFromInputType(intent.inputType);
  const selected = Math.max(0, intent.selectedCodepoints);
  const structuralInsert = lineBreakInsertedCodepoints(intent.inputType, intent.dataCodepoints);
  const inserted = structuralInsert ?? Math.max(0, intent.dataCodepoints);
  const start = Math.max(0, intent.selectionStartCodepoints);

  if (intent.inputType.startsWith("delete")) {
    if (selected > 0) return { op: "delete", pos: start, del_len: selected, ins_len: 0, source };
    if (intent.inputType.endsWith("Backward")) {
      if (!intent.hasBackwardCodepoint) return null;
      return { op: "delete", pos: Math.max(0, start - 1), del_len: 1, ins_len: 0, source };
    }
    if (!intent.hasForwardCodepoint) return null;
    return { op: "delete", pos: start, del_len: 1, ins_len: 0, source };
  }

  if (intent.inputType.startsWith("insert")) {
    if (selected > 0 && inserted > 0) return { op: "replace", pos: start, del_len: selected, ins_len: inserted, source };
    if (selected > 0) return { op: "delete", pos: start, del_len: selected, ins_len: 0, source };
    if (inserted > 0) return { op: "insert", pos: start, del_len: 0, ins_len: inserted, source };
  }

  return null;
}
