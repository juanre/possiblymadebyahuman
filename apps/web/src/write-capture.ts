import type { PendingMutation } from "../../../packages/producer-core/src/index.ts";
import type { Source } from "../../../packages/format/src/index.ts";

// Only numeric measurements and input classification survive between events.
export type MeasuredInputIntent = {
  inputType: string;
  lengthBefore: number;
  selectionStartCodepoints: number;
  selectedCodepoints: number;
  dataCodepoints: number | null;
};

export function sourceFromInputType(inputType: string): Source {
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

export function lineBreakInsertedCodepoints(inputType: string, dataCodepoints = 0): number | null {
  return inputType === "insertParagraph" || inputType === "insertLineBreak" ? Math.max(1, dataCodepoints) : null;
}

export function deriveMutationFromMeasuredInput(
  intent: MeasuredInputIntent, lengthAfter: number, caretAfter: number,
): PendingMutation | null {
  const delta = lengthAfter - intent.lengthBefore;
  const source = sourceFromInputType(intent.inputType);
  if (intent.inputType.startsWith("delete") && delta < 0) {
    return { op: "delete", pos: caretAfter, del_len: -delta, ins_len: 0, source };
  }
  if (intent.inputType.startsWith("insert")) {
    const inserted = lineBreakInsertedCodepoints(intent.inputType, intent.dataCodepoints ?? 0)
      ?? intent.dataCodepoints
      // Textarea paste commonly omits data; measure the applied replacement.
      ?? (["insertText", "insertFromPaste", "insertFromPasteAsQuotation", "insertFromDrop", "insertFromYank"].includes(intent.inputType)
        ? delta + intent.selectedCodepoints : null);
    if (inserted !== null && inserted > 0) {
      const deleted = inserted - delta;
      const pos = intent.inputType === "insertReplacementText" ? caretAfter - inserted : intent.selectionStartCodepoints;
      if (deleted >= 0 && pos >= 0 && pos + deleted <= intent.lengthBefore) {
        return { op: deleted > 0 ? "replace" : "insert", pos, del_len: deleted, ins_len: inserted, source };
      }
    }
  }
  // Undo/redo can replace equal-length text. A zero net change does not mean
  // nothing happened: input fired, but individual sizes/position are unknown.
  if (delta === 0) return { op: "replace", pos: null, del_len: null, ins_len: null, source: "unknown" };
  return delta > 0
    ? { op: "insert", pos: null, del_len: null, ins_len: delta, source: "unknown" }
    : { op: "delete", pos: null, del_len: -delta, ins_len: null, source: "unknown" };
}

export function attachWriteCapture(element: HTMLTextAreaElement, emit: (mutation: PendingMutation) => void): () => void {
  let pending: MeasuredInputIntent | null = null;
  let composition: Omit<MeasuredInputIntent, "inputType" | "dataCodepoints"> | null = null;
  const measure = () => ({
    lengthBefore: Array.from(element.value).length,
    selectionStartCodepoints: Array.from(element.value.slice(0, element.selectionStart)).length,
    selectedCodepoints: Array.from(element.value.slice(element.selectionStart, element.selectionEnd)).length,
  });
  const before = (event: InputEvent) => {
    pending = null;
    if (composition) return;
    pending = { ...measure(), inputType: event.inputType,
      dataCodepoints: event.data === null ? null : Array.from(event.data).length };
  };
  const input = () => {
    if (composition) return;
    const intent = pending;
    pending = null;
    if (!intent) {
      emit({ op: "replace", pos: null, del_len: null, ins_len: null, source: "unknown" });
      return;
    }
    const mutation = deriveMutationFromMeasuredInput(intent, Array.from(element.value).length,
      Array.from(element.value.slice(0, element.selectionStart)).length);
    if (mutation) emit(mutation);
  };
  const startComposition = () => { pending = null; composition = measure(); };
  const endComposition = (event: CompositionEvent) => {
    const start = composition;
    composition = null;
    pending = null;
    if (!start) return;
    const inserted = Array.from(event.data).length;
    const lengthAfter = Array.from(element.value).length;
    if (inserted === 0 && lengthAfter === start.lengthBefore) return;
    const mutation = deriveMutationFromMeasuredInput({ ...start, inputType: "insertFromComposition", dataCodepoints: inserted },
      lengthAfter, Array.from(element.value.slice(0, element.selectionStart)).length);
    if (mutation) emit(mutation);
  };
  const blur = () => { pending = null; };
  element.addEventListener("beforeinput", before);
  element.addEventListener("input", input);
  element.addEventListener("compositionstart", startComposition);
  element.addEventListener("compositionend", endComposition);
  element.addEventListener("blur", blur);
  return () => {
    element.removeEventListener("beforeinput", before);
    element.removeEventListener("input", input);
    element.removeEventListener("compositionstart", startComposition);
    element.removeEventListener("compositionend", endComposition);
    element.removeEventListener("blur", blur);
  };
}
