import type { FieldDescriptor } from "../../../../packages/producer-core/src/index.ts";

/**
 * DescriptorTarget is the read-only slice of the DOM the descriptor extractor
 * needs. Content scripts pass real elements; tests pass plain shape objects.
 * The extractor reads only attributes and structural tag names — never text
 * content. Eligibility (empty vs non-empty) is the caller's responsibility.
 */
export interface DescriptorTarget {
  readonly tagName: string;
  getAttribute(name: string): string | null;
  closest(selector: string): { getAttribute(name: string): string | null } | null;
  readonly parentElement: ParentElementSlice | null;
  matches?(selector: string): boolean;
}

export interface ParentElementSlice {
  readonly tagName: string;
  readonly children: ReadonlyArray<{ readonly tagName: string }>;
  readonly parentElement: ParentElementSlice | null;
}

const TAG_TO_KIND: Record<string, FieldDescriptor["tag_name"]> = {
  TEXTAREA: "TEXTAREA",
  INPUT: "INPUT",
};

const TEXTUAL_INPUT_TYPES = new Set([
  "text",
  "search",
  "email",
  "url",
  "tel",
  null,
  "",
]);

export function isEligibleTag(target: DescriptorTarget): boolean {
  const tag = target.tagName.toUpperCase();
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") {
    const type = (target.getAttribute("type") ?? "").toLowerCase();
    return TEXTUAL_INPUT_TYPES.has(type === "" ? "" : type);
  }
  const contentEditable = target.getAttribute("contenteditable");
  if (contentEditable !== null) {
    const normalised = contentEditable.toLowerCase();
    return normalised === "" || normalised === "true" || normalised === "plaintext-only";
  }
  return false;
}

/**
 * Computes a stable signature for the field's structural neighbourhood. The
 * signature is opaque (FNV-1a 32-bit hex over a small tag-path string) and
 * does not depend on text content — it depends only on tag names, ancestor
 * positions, and the sibling index of the field within its parent.
 */
export function domSignature(target: DescriptorTarget): string {
  let parent: ParentElementSlice | null = target.parentElement;
  let descent = 0;
  const parts: string[] = [target.tagName.toUpperCase()];
  while (parent && descent < 5) {
    const siblingTags = parent.children.map((child) => child.tagName.toUpperCase()).join(",");
    parts.push(`${parent.tagName.toUpperCase()}[${siblingTags}]`);
    parent = parent.parentElement;
    descent += 1;
  }
  return fnv1aHex(parts.join("/"));
}

export function indexAmongSimilar(target: DescriptorTarget): number {
  const parent = target.parentElement;
  if (!parent) return 0;
  let index = 0;
  for (const sibling of parent.children) {
    if (sibling === target) break;
    if (sibling.tagName === target.tagName) index += 1;
  }
  return index;
}

export function fieldKindFor(target: DescriptorTarget): string {
  const tag = target.tagName.toUpperCase();
  if (tag === "TEXTAREA") return "textarea";
  if (tag === "INPUT") {
    const type = (target.getAttribute("type") ?? "text").toLowerCase();
    return `input:${type}`;
  }
  return "contenteditable";
}

export function extractDescriptor(target: DescriptorTarget): FieldDescriptor {
  const tag = target.tagName.toUpperCase();
  const tagName = TAG_TO_KIND[tag] ?? "CONTENTEDITABLE";
  const form = target.closest("form");
  return {
    tag_name: tagName,
    field_kind: fieldKindFor(target),
    name: nullableAttr(target, "name"),
    id: nullableAttr(target, "id"),
    aria_label: nullableAttr(target, "aria-label"),
    nearest_form_id: form ? nullableAttr(form, "id") : null,
    dom_signature: domSignature(target),
    index_among_similar: indexAmongSimilar(target),
  };
}

function nullableAttr(target: { getAttribute(name: string): string | null }, name: string): string | null {
  const raw = target.getAttribute(name);
  return raw && raw.trim().length > 0 ? raw : null;
}

function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
