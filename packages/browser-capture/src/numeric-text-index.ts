/** Numeric-only UTF-16/codepoint index. Never retains source text or characters. */
type Node = {
  offset: number;
  priority: number;
  count: number;
  shift: number;
  left: Node | null;
  right: Node | null;
};
const count = (node: Node | null): number => node?.count ?? 0;
function shift(node: Node | null, delta: number): void {
  if (node) {
    node.offset += delta;
    node.shift += delta;
  }
}
function push(node: Node): void {
  if (node.shift) {
    shift(node.left, node.shift);
    shift(node.right, node.shift);
    node.shift = 0;
  }
}
function update(node: Node): Node {
  node.count = 1 + count(node.left) + count(node.right);
  return node;
}
function split(node: Node | null, offset: number): [Node | null, Node | null] {
  if (!node) return [null, null];
  push(node);
  if (node.offset < offset) {
    const [left, right] = split(node.right, offset);
    node.right = left;
    return [update(node), right];
  }
  const [left, right] = split(node.left, offset);
  node.left = right;
  return [left, update(node)];
}
function merge(left: Node | null, right: Node | null): Node | null {
  if (!left) return right;
  if (!right) return left;
  if (left.priority < right.priority) {
    push(left);
    left.right = merge(left.right, right);
    return update(left);
  }
  push(right);
  right.left = merge(left, right.left);
  return update(right);
}
function preceding(node: Node | null, offset: number): number {
  if (!node) return 0;
  push(node);
  return node.offset < offset
    ? count(node.left) + 1 + preceding(node.right, offset)
    : preceding(node.left, offset);
}
const high = (code: number) => code >= 0xd800 && code <= 0xdbff;
const low = (code: number) => code >= 0xdc00 && code <= 0xdfff;
export class NumericTextIndex {
  #root: Node | null = null;
  #seed = 0x9e3779b9;
  utf16Length = 0;
  constructor(text: string) {
    this.reset(text);
  }
  get length(): number {
    return this.utf16Length - count(this.#root);
  }
  get numericNodeCount(): number {
    return count(this.#root);
  }
  offset(utf16: number): number {
    const offset = Math.max(0, Math.min(this.utf16Length, utf16));
    return offset - preceding(this.#root, offset - 1);
  }
  reset(text: string): void {
    this.#root = null;
    this.utf16Length = text.length;
    this.#root = this.#scan(text, 0, text.length);
  }
  /** Replace a known UTF-16 span; inspect only the inserted span and its boundaries. */
  replace(textAfter: string, start: number, end: number): void {
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end < start ||
      end > this.utf16Length
    )
      throw new RangeError("Invalid numeric text span");
    const inserted = textAfter.length - this.utf16Length + end - start;
    if (inserted < 0) throw new RangeError("Invalid numeric text delta");
    const from = Math.max(0, start - 1),
      to = end + 1;
    const [before, rest] = split(this.#root, from);
    const [, after] = split(rest, to);
    shift(after, textAfter.length - this.utf16Length);
    const middle = this.#scan(textAfter, from, start + inserted + 1);
    this.#root = merge(merge(before, middle), after);
    this.utf16Length = textAfter.length;
  }
  #scan(text: string, start: number, end: number): Node | null {
    let root: Node | null = null;
    for (
      let offset = start;
      offset < Math.min(end, text.length - 1);
      offset++
    ) {
      if (!high(text.charCodeAt(offset)) || !low(text.charCodeAt(offset + 1)))
        continue;
      this.#seed ^= this.#seed << 13;
      this.#seed ^= this.#seed >>> 17;
      this.#seed ^= this.#seed << 5;
      root = merge(root, {
        offset,
        priority: this.#seed >>> 0,
        count: 1,
        shift: 0,
        left: null,
        right: null,
      });
    }
    return root;
  }
}
export type NumericTextIntent = {
  length: number;
  start: number | null;
  end: number | null;
  inputType: string;
  dataLength: number | null;
};
/** Incremental indexing is possible only when DOM facts establish the actual span. */
export function applyNumericTextInput(
  index: NumericTextIndex,
  textAfter: string,
  caret: number | null,
  intent: NumericTextIntent | null,
): void {
  if (
    !intent ||
    intent.length !== index.utf16Length ||
    intent.start === null ||
    intent.end === null ||
    caret === null ||
    /^(history|format)/.test(intent.inputType)
  ) {
    if (
      intent?.inputType.startsWith("format") &&
      textAfter.length === index.utf16Length
    )
      return;
    index.reset(textAfter);
    return;
  }
  let start = Math.min(intent.start, intent.end),
    end = Math.max(intent.start, intent.end);
  if (intent.inputType.startsWith("delete") && start === end) {
    const deleted = index.utf16Length - textAfter.length;
    start = caret;
    end = start + deleted;
    if (deleted < 0) {
      index.reset(textAfter);
      return;
    }
  } else if (
    intent.inputType === "insertReplacementText" &&
    intent.dataLength !== null
  ) {
    start = caret - intent.dataLength;
    end = start + index.utf16Length - textAfter.length + intent.dataLength;
  } else if (
    !intent.inputType.startsWith("insert") &&
    !intent.inputType.startsWith("delete")
  ) {
    index.reset(textAfter);
    return;
  }
  const inserted = textAfter.length - index.utf16Length + end - start;
  if (
    start < 0 ||
    end < start ||
    end > index.utf16Length ||
    inserted < 0 ||
    caret !== start + inserted
  ) {
    index.reset(textAfter);
    return;
  }
  index.replace(textAfter, start, end);
}
