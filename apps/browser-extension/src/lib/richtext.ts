import { codepointCount, codepointOffsetOf, netLengthChangeMutation, operationFor } from "./codepoint.ts";
import type { PendingMutation } from "../../../../packages/producer-core/src/index.ts";
import type { Source } from "../../../../packages/format/src/index.ts";

/** Numeric projection of a DOM editor. Text is inspected only during this call.
 * Text nodes use Unicode codepoints. BR and boundaries between block siblings
 * contribute one newline; a final BR in a block is the browser's empty-line
 * placeholder, not an extra character. Inline markup contributes no characters.
 * Embedded objects and nested independent editors make this model unsupported.
 */
export type RichMeasurement = { length: number | null; start: number | null; end: number | null };
const BLOCK = /^(DIV|P|LI|UL|OL|BLOCKQUOTE|PRE|H[1-6])$/;
const UNSUPPORTED = /^(IMG|VIDEO|AUDIO|IFRAME|CANVAS|SVG|MATH|TABLE|INPUT|TEXTAREA|HR|SCRIPT|STYLE)$/;
export function measureRichText(root: HTMLElement, range?: StaticRange | Range): RichMeasurement {
  const bases = new Map<Node, number>();
  const boundaries = new Map<Node, number[]>();
  let length = 0;
  let supported = true;
  function isPlaceholderBreak(node: Node): boolean {
    let cursor: Node | null = node;
    while (cursor && cursor !== root) {
      let sibling = cursor.nextSibling;
      while (sibling) {
        if (sibling.nodeType !== Node.COMMENT_NODE && !(sibling.nodeType === Node.TEXT_NODE && (sibling.textContent ?? "").length === 0)) return false;
        sibling = sibling.nextSibling;
      }
      cursor = cursor.parentNode;
      if (cursor instanceof HTMLElement && (cursor === root || BLOCK.test(cursor.tagName))) return true;
    }
    return true;
  }
  function visit(node: Node): void {
    bases.set(node, length);
    if (node.nodeType === Node.TEXT_NODE) { length += codepointCount(node.textContent ?? ""); return; }
    if (!(node instanceof HTMLElement)) { if (node.nodeType !== Node.COMMENT_NODE) supported = false; return; }
    if (node !== root && (UNSUPPORTED.test(node.tagName) || node.getAttribute("contenteditable") === "false" || node.hasAttribute("hidden"))) supported = false;
    const offsets: number[] = [];
    let previous: Node | undefined;
    for (const child of Array.from(node.childNodes)) {
      offsets.push(length);
      if (child.nodeType === Node.COMMENT_NODE) continue;
      const childBlock = child instanceof HTMLElement && BLOCK.test(child.tagName);
      const previousBlock = previous instanceof HTMLElement && BLOCK.test(previous.tagName);
      if (previous && (childBlock || previousBlock)) length += 1;
      if (child instanceof HTMLElement && child.tagName === "BR") {
        bases.set(child, length);
        // Browsers keep a trailing BR to make the last empty line editable.
        if (!isPlaceholderBreak(child)) length += 1;
      } else visit(child);
      previous = child;
    }
    offsets.push(length);
    boundaries.set(node, offsets);
  }
  visit(root);
  if (!supported) return { length: null, start: null, end: null };
  function offset(node: Node, index: number): number | null {
    const base = bases.get(node);
    if (base === undefined) return null;
    if (node.nodeType === Node.TEXT_NODE) return base + codepointOffsetOf(node.textContent ?? "", index);
    return boundaries.get(node)?.[index] ?? base;
  }
  const selection = root.ownerDocument.getSelection();
  const selected = range ?? (selection?.rangeCount === 1 ? selection.getRangeAt(0) : null);
  if (!selected) return { length, start: null, end: null };
  const start = offset(selected.startContainer, selected.startOffset);
  const end = offset(selected.endContainer, selected.endOffset);
  return { length, start, end };
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
  // Undo/redo target ranges are generally absent. Preserve measurable net size,
  // but do not invent an edit location or turn an equal-size replacement into no activity.
  const net = netLengthChangeMutation({ lengthBefore: before.length, lengthAfter: after.length });
  return net ? { ...net, source: before.source } : { op: "replace", pos: null, del_len: null, ins_len: null, source: before.source };
}
