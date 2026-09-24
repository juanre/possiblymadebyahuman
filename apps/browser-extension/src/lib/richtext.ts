import { netLengthChangeMutation, operationFor } from "./codepoint.ts";
import type { PendingMutation } from "../../../../packages/producer-core/src/index.ts";
import type { Source } from "../../../../packages/format/src/index.ts";

/** Numeric projection of a DOM editor. Text is inspected only during this call.
 * Text nodes use Unicode codepoints. BR and boundaries between block siblings
 * contribute one newline; a final BR in a block is the browser's empty-line
 * placeholder, not an extra character. Inline markup contributes no characters.
 * Embedded objects and nested independent editors make this model unsupported.
 */
export type RichMeasurement = { length: number | null; start: number | null; end: number | null };
export { richTextIndex, releaseRichTextIndex } from "./richtext-index.ts";
import { richTextIndex } from "./richtext-index.ts";
export function measureRichText(root: HTMLElement, range?: StaticRange | Range): RichMeasurement {
  return richTextIndex(root).measure(range);
}

export type RichChange = RichMeasurement & { source: Source; kind: "insert" | "delete" | "history" | "format" | "unknown" };
export function richMutation(before: RichChange, after: RichMeasurement): PendingMutation | null {
  if (before.length === null || after.length === null) return { op: "replace", pos: null, del_len: null, ins_len: null, source: before.source };
  const delta = after.length - before.length;
  if (before.kind === "format" && delta === 0) return null;
  if ((before.kind === "insert" || before.kind === "delete") && before.start !== null && before.end !== null) {
    const del_len = before.end - before.start;
    const ins_len = delta + del_len;
    // The browser's target range and final caret must agree with the measured
    // change. A page that transforms the DOM cannot make an impossible exact edit.
    if (ins_len >= 0 && (before.kind !== "delete" || ins_len === 0) && after.start === before.start + ins_len && after.end === after.start) {
      if (ins_len === 0 && del_len === 0) return null;
      return { op: operationFor({ ins_len, del_len }), pos: before.start, del_len, ins_len, source: before.source };
    }
  }
  // Undo/redo target ranges are generally absent. Net length cannot establish
  // either replacement size; keep activity visible without inventing measurements.
  const net = netLengthChangeMutation({ lengthBefore: before.length, lengthAfter: after.length });
  return net ? { ...net, source: before.source } : { op: "replace", pos: null, del_len: null, ins_len: null, source: before.source };
}
