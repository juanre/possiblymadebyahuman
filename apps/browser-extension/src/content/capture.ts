import { buildTextFieldMutation } from "../lib/codepoint.ts";
import { extractDescriptor, isEligibleTag } from "../lib/descriptor.ts";
import type { BackgroundResponse, ContentToBackground } from "../lib/messages.ts";

declare const chrome: {
  runtime: {
    sendMessage(message: ContentToBackground): Promise<BackgroundResponse>;
    id?: string;
  };
};

const BADGE_ATTR = "data-pmbah-badge";
const SESSION_ATTR = "data-pmbah-session";
const STATE_ATTR = "data-pmbah-state";

type FieldEntry = {
  element: HTMLElement;
  session_id: string | null;
  previousTextSnapshot: () => string;
  state: "pending" | "recording" | "ineligible" | "signed" | "error";
};

const fields = new WeakMap<HTMLElement, FieldEntry>();

function isTextField(element: Element): element is HTMLTextAreaElement | HTMLInputElement {
  return element.tagName === "TEXTAREA" || element.tagName === "INPUT";
}

function isContentEditable(element: HTMLElement): boolean {
  return element.isContentEditable;
}

function isEligibleElement(element: HTMLElement): boolean {
  if (isContentEditable(element)) return true;
  return isEligibleTag({
    tagName: element.tagName,
    getAttribute: (name) => element.getAttribute(name),
    closest: (selector) => element.closest(selector) as { getAttribute(name: string): string | null } | null,
    parentElement: parentSlice(element),
  });
}

interface ParentSliceLike {
  readonly tagName: string;
  readonly children: ReadonlyArray<{ readonly tagName: string }>;
  readonly parentElement: ParentSliceLike | null;
}

function parentSlice(element: HTMLElement | null): ParentSliceLike | null {
  if (!element) return null;
  const parent = element.parentElement;
  if (!parent) return null;
  return {
    tagName: parent.tagName,
    get children(): ReadonlyArray<{ readonly tagName: string }> {
      return Array.from(parent.children).map((child) => ({ tagName: child.tagName }));
    },
    get parentElement(): ParentSliceLike | null {
      return parentSlice(parent);
    },
  };
}

function isFieldEmpty(element: HTMLElement): boolean {
  if (isTextField(element)) return element.value.length === 0;
  if (isContentEditable(element)) {
    const text = element.textContent ?? "";
    return text.trim().length === 0;
  }
  return true;
}

function ensureBadge(element: HTMLElement): HTMLElement {
  const existing = element.getAttribute(BADGE_ATTR);
  if (existing) {
    const found = document.querySelector(`[id="${existing}"]`);
    if (found) return found as HTMLElement;
  }
  const id = `pmbah-badge-${Math.random().toString(36).slice(2, 10)}`;
  element.setAttribute(BADGE_ATTR, id);
  const badge = document.createElement("div");
  badge.id = id;
  badge.setAttribute("role", "status");
  badge.setAttribute("aria-live", "polite");
  badge.style.cssText = [
    "position:absolute",
    "z-index:2147483647",
    "padding:2px 8px",
    "font:11px ui-monospace, SFMono-Regular, Menlo, monospace",
    "background:#202124",
    "color:#fbf8f2",
    "border-radius:999px",
    "pointer-events:none",
    "opacity:0.92",
  ].join(";");
  badge.textContent = "pending";
  document.body.appendChild(badge);
  positionBadge(element, badge);
  return badge;
}

function positionBadge(element: HTMLElement, badge: HTMLElement): void {
  const rect = element.getBoundingClientRect();
  const top = window.scrollY + rect.top - 16;
  const left = window.scrollX + rect.right - badge.offsetWidth - 4;
  badge.style.top = `${Math.max(0, top)}px`;
  badge.style.left = `${Math.max(0, left)}px`;
}

function setBadge(element: HTMLElement, state: FieldEntry["state"], note?: string): void {
  const badge = ensureBadge(element);
  element.setAttribute(STATE_ATTR, state);
  const label = stateLabel(state, note);
  badge.textContent = label;
  badge.style.background = badgeColor(state);
  positionBadge(element, badge);
}

function stateLabel(state: FieldEntry["state"], note?: string): string {
  switch (state) {
    case "pending": return "pending";
    case "recording": return note ?? "recording";
    case "ineligible": return "not recording (existing content)";
    case "signed": return "signed";
    case "error": return note ?? "error";
  }
}

function badgeColor(state: FieldEntry["state"]): string {
  switch (state) {
    case "recording": return "#1b5e20";
    case "ineligible": return "#5a432a";
    case "signed": return "#2f80ed";
    case "error": return "#a12a2a";
    default: return "#202124";
  }
}

async function registerField(element: HTMLElement): Promise<void> {
  if (fields.has(element)) return;
  if (!isEligibleElement(element)) return;
  const descriptor = extractDescriptor({
    tagName: element.tagName,
    getAttribute: (name) => element.getAttribute(name),
    closest: (selector) => element.closest(selector) as { getAttribute(name: string): string | null } | null,
    parentElement: parentSlice(element),
  });
  const empty = isFieldEmpty(element);
  setBadge(element, "pending");
  const entry: FieldEntry = {
    element,
    session_id: null,
    state: "pending",
    previousTextSnapshot: () => snapshotValue(element),
  };
  fields.set(element, entry);

  const response = await chrome.runtime.sendMessage({
    kind: "register_field",
    tab_id: -1,
    frame_id: -1,
    origin_url: window.location.origin,
    page_path: window.location.pathname,
    page_title: document.title,
    descriptor,
    field_is_empty: empty,
  });

  if (response.kind !== "register_field_result") {
    setBadge(element, "error", `register_failed:${response.kind === "error" ? response.reason : "unexpected"}`);
    entry.state = "error";
    return;
  }
  if (response.result.kind === "ineligible") {
    setBadge(element, "ineligible");
    entry.state = "ineligible";
    return;
  }
  entry.session_id = response.result.session_id;
  element.setAttribute(SESSION_ATTR, response.result.session_id);
  setBadge(element, "recording", response.result.certainty === "fresh" ? "recording" : `recording (${response.result.certainty})`);
  entry.state = "recording";
}

function snapshotValue(element: HTMLElement): string {
  if (isTextField(element)) return element.value;
  if (isContentEditable(element)) return element.textContent ?? "";
  return "";
}

function selectionRangeFor(element: HTMLElement): { start: number; end: number } {
  if (isTextField(element)) {
    return {
      start: element.selectionStart ?? 0,
      end: element.selectionEnd ?? 0,
    };
  }
  // ContentEditable: degraded — we lack a reliable codepoint anchor without
  // walking the DOM tree, so for v0 we surface mutations with pos=null,
  // ins_len/del_len from event.data length only. The downstream stats label
  // these as "unknown" positions, not zeros that lie.
  return { start: 0, end: 0 };
}

async function handleInput(event: InputEvent): Promise<void> {
  const target = event.target as HTMLElement | null;
  if (!target) return;
  const entry = fields.get(target);
  if (!entry || entry.state !== "recording" || !entry.session_id) return;
  const inputType = event.inputType ?? null;
  const insertedText = event.data ?? "";
  if (isTextField(target)) {
    const previousText = entry.previousTextSnapshot();
    const range = selectionRangeFor(target);
    // For deleting events the selection range here is AFTER the delete already
    // applied; the previousTextSnapshot still holds the pre-delete state
    // because it is captured on the prior input cycle. We reconstruct the
    // deleted span from the difference between previousText.length and
    // current target.value.length when the explicit range is collapsed.
    const currentText = target.value;
    const mutation = inferTextFieldMutation({
      previousText,
      currentText,
      selectionStartUtf16: range.start,
      selectionEndUtf16: range.end,
      insertedText,
      inputType,
    });
    entry.previousTextSnapshot = () => currentText;
    const response = await chrome.runtime.sendMessage({
      kind: "append_mutation",
      session_id: entry.session_id,
      mutation,
    });
    if (response.kind === "error") {
      setBadge(target, "error", response.reason);
      entry.state = "error";
    }
    return;
  }
  // ContentEditable degraded path — emit a mutation with null position and
  // best-effort codepoint counts; pos is null to honour the spec rather than
  // fabricate an offset.
  const mutation = {
    op: insertedText.length > 0 ? "insert" as const : "delete" as const,
    pos: null,
    del_len: null,
    ins_len: Array.from(insertedText).length,
    source: ((): import("../../../../packages/format/src/index.ts").Source => {
      const t = inputType ?? "";
      if (t === "insertFromPaste") return "paste";
      if (t === "insertText" || t === "insertParagraph" || t === "insertLineBreak") return "typing";
      return "unknown";
    })(),
  };
  const response = await chrome.runtime.sendMessage({
    kind: "append_mutation",
    session_id: entry.session_id,
    mutation,
  });
  if (response.kind === "error") {
    setBadge(target, "error", response.reason);
    entry.state = "error";
  }
}

export function inferTextFieldMutation(args: {
  previousText: string;
  currentText: string;
  selectionStartUtf16: number;
  selectionEndUtf16: number;
  insertedText: string;
  inputType: string | null;
}) {
  const lengthDelta = args.currentText.length - args.previousText.length;
  // If the inserted text plus the deleted range explain the diff, trust the
  // explicit numbers from the InputEvent. Otherwise fall back to inferring
  // the deletion span by comparing previousText and currentText at the
  // caret. Both paths inspect strings transiently and discard them.
  if (lengthDelta === args.insertedText.length - (args.selectionEndUtf16 - args.selectionStartUtf16)) {
    return buildTextFieldMutation({
      previousText: args.previousText,
      selectionStartUtf16: args.selectionStartUtf16,
      selectionEndUtf16: args.selectionEndUtf16,
      insertedText: args.insertedText,
      inputType: args.inputType,
    });
  }
  // Diff-fallback: derive deletion span by comparing the two snapshots around
  // the caret. Safe because pos/del_len come out as codepoint counts only.
  const commonPrefix = sharedPrefixLength(args.previousText, args.currentText);
  const commonSuffix = sharedSuffixLength(args.previousText, args.currentText, commonPrefix);
  const del_end_utf16 = args.previousText.length - commonSuffix;
  const del_start_utf16 = commonPrefix;
  return buildTextFieldMutation({
    previousText: args.previousText,
    selectionStartUtf16: del_start_utf16,
    selectionEndUtf16: del_end_utf16,
    insertedText: args.currentText.slice(commonPrefix, args.currentText.length - commonSuffix),
    inputType: args.inputType,
  });
}

function sharedPrefixLength(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  let i = 0;
  while (i < len && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}

function sharedSuffixLength(a: string, b: string, prefix: number): number {
  const maxA = a.length - prefix;
  const maxB = b.length - prefix;
  const len = Math.min(maxA, maxB);
  let i = 0;
  while (i < len && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i += 1;
  return i;
}

function attachListeners(element: HTMLElement): void {
  element.addEventListener("focus", () => {
    void registerField(element);
  });
  element.addEventListener("input", (event) => {
    void handleInput(event as InputEvent);
  });
}

function scan(root: ParentNode): void {
  const fieldsList = root.querySelectorAll("textarea, input, [contenteditable]");
  for (const el of Array.from(fieldsList) as HTMLElement[]) {
    if (isEligibleElement(el)) attachListeners(el);
  }
}

function start(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  scan(document);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (node instanceof Element) scan(node);
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

start();

export const __test = {
  inferTextFieldMutation,
  sharedPrefixLength,
  sharedSuffixLength,
  isEligibleElement,
};

export const CONTENT_ENTRYPOINT = "capture";
