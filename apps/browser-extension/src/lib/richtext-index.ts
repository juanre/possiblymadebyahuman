import {
  NumericTextIndex,
  applyNumericTextInput,
  type NumericTextIntent,
} from "../../../../packages/browser-capture/src/numeric-text-index.ts";
const BLOCK = /^(DIV|P|LI|UL|OL|BLOCKQUOTE|PRE|H[1-6])$/;
const UNSUPPORTED =
  /^(IMG|VIDEO|AUDIO|IFRAME|CANVAS|SVG|MATH|TABLE|INPUT|TEXTAREA|HR|SCRIPT|STYLE)$/;
type Weight = {
  length: number;
  pending: boolean;
  visible: boolean;
  semantic: boolean;
  firstBlock: boolean;
  lastBlock: boolean;
  unsupported: boolean;
};
const empty = (): Weight => ({
  length: 0,
  pending: false,
  visible: false,
  semantic: false,
  firstBlock: false,
  lastBlock: false,
  unsupported: false,
});
/** A trailing BR is withheld until a later visible sibling proves it is not a placeholder. */
function combine(a: Weight, b: Weight): Weight {
  return {
    length:
      a.length +
      b.length +
      (a.pending && b.visible ? 1 : 0) +
      (a.semantic && b.semantic && (a.lastBlock || b.firstBlock) ? 1 : 0),
    pending: b.visible ? b.pending : a.pending,
    visible: a.visible || b.visible,
    semantic: a.semantic || b.semantic,
    firstBlock: a.semantic ? a.firstBlock : b.firstBlock,
    lastBlock: b.semantic ? b.lastBlock : a.lastBlock,
    unsupported: a.unsupported || b.unsupported,
  };
}
type Entry = {
  node: Node;
  parent: Entry | null;
  link: Link | null;
  children: Link | null;
  text: NumericTextIndex | null;
  weight: Weight;
};
type Link = {
  entry: Entry;
  left: Link | null;
  right: Link | null;
  parent: Link | null;
  size: number;
  priority: number;
  weight: Weight;
};
const size = (node: Link | null) => node?.size ?? 0;
const weight = (node: Link | null) => node?.weight ?? empty();
function update(node: Link): Link {
  node.size = 1 + size(node.left) + size(node.right);
  node.weight = combine(
    combine(weight(node.left), node.entry.weight),
    weight(node.right),
  );
  if (node.left) node.left.parent = node;
  if (node.right) node.right.parent = node;
  return node;
}
function merge(a: Link | null, b: Link | null): Link | null {
  if (!a) {
    if (b) b.parent = null;
    return b;
  }
  if (!b) {
    a.parent = null;
    return a;
  }
  if (a.priority < b.priority) {
    a.right = merge(a.right, b);
    update(a);
    a.parent = null;
    return a;
  }
  b.left = merge(a, b.left);
  update(b);
  b.parent = null;
  return b;
}
function split(node: Link | null, count: number): [Link | null, Link | null] {
  if (!node) return [null, null];
  if (count <= size(node.left)) {
    const [a, b] = split(node.left, count);
    node.left = b;
    update(node);
    node.parent = null;
    return [a, node];
  }
  const [a, b] = split(node.right, count - size(node.left) - 1);
  node.right = a;
  update(node);
  node.parent = null;
  return [node, b];
}
function rank(node: Link): number {
  let result = size(node.left);
  while (node.parent) {
    if (node === node.parent.right) result += size(node.parent.left) + 1;
    node = node.parent;
  }
  return result;
}
function prefix(node: Link | null, count: number): Weight {
  if (!node || count <= 0) return empty();
  if (count >= size(node)) return node.weight;
  const left = size(node.left);
  if (count <= left) return prefix(node.left, count);
  return combine(
    combine(weight(node.left), node.entry.weight),
    prefix(node.right, count - left - 1),
  );
}
export type IndexedRichMeasurement = {
  length: number | null;
  start: number | null;
  end: number | null;
};
/** DOM references plus numeric weights only. No text snapshot is retained. */
export class RichTextIndex {
  readonly #root: Entry;
  readonly #entries = new WeakMap<Node, Entry>();
  readonly #observer: MutationObserver;
  #seed = 0x12345678;
  #pending: {
    entry: Entry;
    intent: NumericTextIntent;
    composition: boolean;
  } | null = null;
  constructor(root: HTMLElement) {
    this.#root = this.#build(root, null);
    this.#observer = new MutationObserver((records) => this.#process(records));
    this.#observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["contenteditable", "hidden"],
    });
  }
  dispose(): void {
    this.#observer.disconnect();
    this.#pending = null;
  }
  prepare(
    range: Range | StaticRange | null,
    inputType: string,
    dataLength: number | null,
    composition = false,
  ): void {
    this.#flush();
    this.#pending = null;
    if (!range || range.startContainer !== range.endContainer) return;
    const entry = this.#entries.get(range.startContainer);
    if (!entry?.text) return;
    this.#pending = {
      entry,
      intent: {
        length: entry.text.utf16Length,
        start: range.startOffset,
        end: range.endOffset,
        inputType,
        dataLength,
      },
      composition,
    };
  }
  clearPending(): void {
    this.#pending = null;
  }
  measure(range?: Range | StaticRange): IndexedRichMeasurement {
    this.#flush();
    if (this.#root.weight.unsupported)
      return { length: null, start: null, end: null };
    const selection = this.#root.node.ownerDocument?.getSelection();
    const selected =
      range ?? (selection?.rangeCount === 1 ? selection.getRangeAt(0) : null);
    return {
      length: this.#root.weight.length,
      start: selected
        ? this.#offset(selected.startContainer, selected.startOffset)
        : null,
      end: selected
        ? this.#offset(selected.endContainer, selected.endOffset)
        : null,
    };
  }
  #flush(): void {
    this.#process(this.#observer.takeRecords());
  }
  #process(records: MutationRecord[]): void {
    // Multiple characterData records can describe a single applied edit. Inspect
    // the final leaf once; no oldValue is requested from MutationObserver.
    const text = new Set<Entry>();
    for (const record of records) {
      const target = this.#entries.get(record.target);
      if (!target) continue;
      if (record.type === "characterData") {
        text.add(target);
        continue;
      }
      if (record.type === "attributes") {
        this.#refresh(target);
        continue;
      }
      this.#pending = null;
      for (const node of Array.from(record.removedNodes)) {
        const child = this.#entries.get(node);
        if (child?.parent !== target || !child.link) continue;
        const at = rank(child.link);
        const [left, rest] = split(target.children, at);
        const [, right] = split(rest, 1);
        target.children = merge(left, right);
        child.parent = null;
        child.link = null;
      }
      let at = record.previousSibling
        ? this.#entries.get(record.previousSibling)
        : undefined;
      let insertion = at?.parent === target && at.link ? rank(at.link) + 1 : 0;
      for (const node of Array.from(record.addedNodes)) {
        // Mutation records may include a node subsequently moved again. Process
        // only its final parent; the later record inserts it at its final position.
        if (node.parentNode !== target.node) continue;
        let child = this.#entries.get(node);
        if (child?.parent && child.link) {
          const old = child.parent;
          const pos = rank(child.link);
          const [left, rest] = split(old.children, pos);
          const [, right] = split(rest, 1);
          old.children = merge(left, right);
          child.parent = null;
          child.link = null;
          this.#refresh(old);
        }
        child = this.#build(node, target);
        const link = this.#link(child);
        const [left, right] = split(target.children, insertion++);
        target.children = merge(merge(left, link), right);
      }
      this.#refresh(target);
    }
    for (const entry of text) {
      if (!entry.text || !this.#attached(entry)) continue;
      const selection = entry.node.ownerDocument?.getSelection();
      const caret =
        selection?.anchorNode === entry.node ? selection.anchorOffset : null;
      const pending = this.#pending?.entry === entry ? this.#pending : null;
      applyNumericTextInput(
        entry.text,
        entry.node.textContent ?? "",
        caret,
        pending?.intent ?? null,
      );
      if (pending?.composition && caret !== null) {
        pending.intent = {
          ...pending.intent,
          length: entry.text.utf16Length,
          end: caret,
        };
      } else if (pending) this.#pending = null;
      this.#refresh(entry);
    }
  }
  #attached(entry: Entry): boolean {
    let cursor = entry;
    while (cursor.parent) cursor = cursor.parent;
    return cursor === this.#root;
  }
  #detach(entry: Entry): void {
    if (!entry.parent || !entry.link) return;
    const parent = entry.parent,
      at = rank(entry.link);
    const [left, rest] = split(parent.children, at);
    const [, right] = split(rest, 1);
    parent.children = merge(left, right);
    entry.parent = null;
    entry.link = null;
    this.#refresh(parent);
  }
  #build(node: Node, parent: Entry | null): Entry {
    const previous = this.#entries.get(node);
    if (previous) this.#detach(previous);
    const entry: Entry = {
      node,
      parent,
      link: null,
      children: null,
      text:
        node.nodeType === Node.TEXT_NODE
          ? new NumericTextIndex(node.textContent ?? "")
          : null,
      weight: empty(),
    };
    this.#entries.set(node, entry);
    if (node instanceof HTMLElement && node.tagName !== "BR")
      for (const child of Array.from(node.childNodes)) {
        const nested = this.#build(child, entry);
        entry.children = merge(entry.children, this.#link(nested));
      }
    this.#setWeight(entry);
    return entry;
  }
  #link(entry: Entry): Link {
    this.#seed ^= this.#seed << 13;
    this.#seed ^= this.#seed >>> 17;
    this.#seed ^= this.#seed << 5;
    const link: Link = {
      entry,
      left: null,
      right: null,
      parent: null,
      size: 1,
      priority: this.#seed >>> 0,
      weight: entry.weight,
    };
    entry.link = link;
    return link;
  }
  #setWeight(entry: Entry): void {
    const node = entry.node;
    if (entry.text) {
      entry.weight = {
        ...empty(),
        length: entry.text.length,
        semantic: true,
        visible: entry.text.utf16Length > 0,
      };
      return;
    }
    if (node.nodeType === Node.COMMENT_NODE) {
      entry.weight = empty();
      return;
    }
    if (!(node instanceof HTMLElement)) {
      entry.weight = { ...empty(), unsupported: true };
      return;
    }
    const block = BLOCK.test(node.tagName),
      children = weight(entry.children);
    entry.weight = {
      ...children,
      semantic: true,
      visible: true,
      firstBlock: block,
      lastBlock: block,
      pending:
        node.tagName === "BR"
          ? true
          : node === this.#root?.node || block
            ? false
            : children.pending,
      unsupported:
        children.unsupported ||
        (entry.parent !== null &&
          (UNSUPPORTED.test(node.tagName) ||
            node.getAttribute("contenteditable") === "false" ||
            node.hasAttribute("hidden"))),
    };
  }
  #refresh(entry: Entry): void {
    let current: Entry | null = entry;
    while (current) {
      this.#setWeight(current);
      let link: Link | null = current.link;
      while (link) {
        update(link);
        link = link.parent;
      }
      current = current.parent;
    }
  }
  #offset(node: Node, index: number): number | null {
    const found = this.#entries.get(node);
    if (!found || !this.#attached(found)) return null;
    let entry: Entry = found;
    let offset = entry.text
      ? entry.text.offset(index)
      : prefix(entry.children, index).length;
    // A withheld BR before the boundary counts if a later visible sibling exists
    // in this same inline sequence, or in an enclosing inline sequence.
    let trailing = entry.text ? false : prefix(entry.children, index).pending;
    if (
      !entry.text &&
      trailing &&
      prefix(entry.children, size(entry.children)).visible
    ) {
      const [, rest] = this.#suffixWeight(entry.children, index);
      if (rest.visible) {
        offset++;
        trailing = false;
      }
    }
    if (entry.node instanceof HTMLElement && BLOCK.test(entry.node.tagName))
      trailing = false;
    while (entry.parent && entry.link) {
      const parent: Entry = entry.parent,
        position = rank(entry.link),
        before = prefix(parent.children, position);
      const after = this.#suffixWeight(parent.children, position + 1)[1];
      offset +=
        before.length +
        (before.pending && entry.weight.visible ? 1 : 0) +
        (before.semantic &&
        entry.weight.semantic &&
        (before.lastBlock || entry.weight.firstBlock)
          ? 1
          : 0);
      // Empty text/comment nodes do not resolve an earlier BR. Carry that
      // pending boundary until a later visible sibling or block boundary.
      if (before.pending && !entry.weight.visible) trailing = true;
      if (trailing && after.visible) {
        offset++;
        trailing = false;
      }
      if (parent.node instanceof HTMLElement && BLOCK.test(parent.node.tagName))
        trailing = false;
      entry = parent;
    }
    return offset;
  }
  #suffixWeight(node: Link | null, start: number): [Weight, Weight] {
    if (!node) return [empty(), empty()];
    const left = size(node.left);
    if (start <= left) {
      const [a, b] = this.#suffixWeight(node.left, start);
      return [a, combine(combine(b, node.entry.weight), weight(node.right))];
    }
    const [a, b] = this.#suffixWeight(node.right, start - left - 1);
    return [combine(combine(weight(node.left), node.entry.weight), a), b];
  }
}
const indexes = new WeakMap<HTMLElement, RichTextIndex>();
export function richTextIndex(root: HTMLElement): RichTextIndex {
  let index = indexes.get(root);
  if (!index) {
    index = new RichTextIndex(root);
    indexes.set(root, index);
  }
  return index;
}

export function releaseRichTextIndex(root: HTMLElement): void {
  indexes.get(root)?.dispose();
  indexes.delete(root);
}
