import { NumericTextIndex, applyNumericTextInput, type NumericTextIntent } from "../../../packages/browser-capture/src/numeric-text-index.ts";
import type { PendingMutation } from "../../../packages/producer-core/src/index.ts";
import { deriveMutationFromMeasuredInput, unknownMutation, type MeasuredInputIntent } from "../../../packages/producer-core/src/measured-input.ts";
export { deriveMutationFromMeasuredInput, lineBreakInsertedCodepoints, sourceFromInputType } from "../../../packages/producer-core/src/measured-input.ts";
export type { MeasuredInputIntent } from "../../../packages/producer-core/src/measured-input.ts";

export type WriteCaptureHandle = (() => void) & { isPending(): boolean; hasGap(): boolean };

export function attachWriteCapture(element: HTMLTextAreaElement, emit: (mutation: PendingMutation) => void): WriteCaptureHandle {
  let pending: MeasuredInputIntent | null = null;
  let composition: Omit<MeasuredInputIntent, "inputType" | "dataCodepoints"> | null = null;
  let committed: { length: number; caret: number } | null = null;
  let cycle = 0;
  const index = new NumericTextIndex(element.value);
  let numericIntent: NumericTextIntent | null = null;
  let observedLength = index.length;
  let gap = false;
  const emitApplied = (mutation: PendingMutation | null, lengthAfter: number) => {
    if (mutation) {
      emit(gap ? { ...mutation, pos: null } : mutation);
      gap = false;
    }
    observedLength = lengthAfter;
  };
  const measure = () => {
    if (index.utf16Length !== element.value.length) index.reset(element.value);
    return { lengthBefore: index.length,
      selectionStartCodepoints: index.offset(element.selectionStart),
      selectedCodepoints: index.offset(element.selectionEnd) - index.offset(element.selectionStart) };
  };
  const beginNumeric = (inputType: string, dataLength: number | null) => {
    numericIntent = { length: index.utf16Length, start: element.selectionStart, end: element.selectionEnd, inputType, dataLength };
  };
  const applyNumeric = () => {
    applyNumericTextInput(index, element.value, element.selectionStart, numericIntent);
    numericIntent = null;
  };
  const before = (event: InputEvent) => {
    pending = null;
    if (composition) return;
    if (committed && event.inputType?.includes("Composition")) return;
    committed = null;
    const currentCycle = ++cycle;
    setTimeout(() => { if (cycle === currentCycle) { pending = null; if (!composition) numericIntent = null; } }, 0);
    const measured = measure();
    if (measured.lengthBefore !== observedLength) gap = true;
    beginNumeric(event.inputType ?? "", typeof event.data === "string" ? event.data.length : null);
    pending = { ...measured, inputType: event.inputType ?? "",
      dataCodepoints: typeof event.data === "string" ? Array.from(event.data).length : null };
  };
  const input = (event: Event) => {
    if (composition) return;
    const inputEvent = event as InputEvent;
    if (committed && (inputEvent.inputType?.includes("Composition") || inputEvent.isComposing)) {
      const matches = committed.length === measure().lengthBefore &&
        committed.caret === index.offset(element.selectionStart);
      committed = null;
      pending = null;
      if (matches) return;
    } else committed = null;
    const intent = pending;
    pending = null;
    applyNumeric();
    if (!intent) {
      emitApplied(unknownMutation(), index.length);
      return;
    }
    const mutation = deriveMutationFromMeasuredInput(intent, index.length, index.offset(element.selectionStart));
    emitApplied(mutation, index.length);
  };
  const startComposition = () => {
    pending = null;
    committed = null;
    composition = measure();
    beginNumeric("insertFromComposition", null);
    if (composition.lengthBefore !== observedLength) gap = true;
  };
  const endComposition = (event: CompositionEvent) => {
    const start = composition;
    composition = null;
    pending = null;
    if (!start) return;
    const inserted = Array.from(event.data).length;
    applyNumeric();
    const lengthAfter = index.length;
    committed = { length: lengthAfter, caret: index.offset(element.selectionStart) };
    if (inserted === 0 && lengthAfter === start.lengthBefore) { observedLength = lengthAfter; return; }
    const mutation = deriveMutationFromMeasuredInput({ ...start, inputType: "insertFromComposition", dataCodepoints: inserted },
      lengthAfter, index.offset(element.selectionStart));
    emitApplied(mutation, lengthAfter);
  };
  const blur = () => { pending = null; };
  element.addEventListener("beforeinput", before);
  element.addEventListener("input", input);
  element.addEventListener("compositionstart", startComposition);
  element.addEventListener("compositionend", endComposition);
  element.addEventListener("blur", blur);
  const dispose = () => {
    element.removeEventListener("beforeinput", before);
    element.removeEventListener("input", input);
    element.removeEventListener("compositionstart", startComposition);
    element.removeEventListener("compositionend", endComposition);
    element.removeEventListener("blur", blur);
  };
  return Object.assign(dispose, {
    isPending: () => composition !== null,
    hasGap: () => {
      gap ||= Array.from(element.value).length !== observedLength;
      return gap;
    },
  });
}
