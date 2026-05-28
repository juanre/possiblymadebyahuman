import { codepointCount, buildTextFieldMutation, sourceFromInputType } from "../lib/codepoint.ts";
import { extractDescriptor, isEligibleTag } from "../lib/descriptor.ts";
import type { BackgroundResponse, ContentToBackground } from "../lib/messages.ts";
import type { PendingMutation } from "../../../../packages/producer-core/src/index.ts";

declare const chrome: {
  runtime: {
    sendMessage(message: ContentToBackground): Promise<BackgroundResponse>;
    id?: string;
  };
};

// Per-field UI state. There are no string fields here — by content-blindness
// rule the content script must not retain text across input events. Every
// beforeinput cycle inspects the field's text once inside the handler scope
// and discards the reference when the handler returns.
type FieldEntry = {
  element: HTMLElement;
  session_id: string | null;
  state: "pending" | "recording" | "ineligible" | "signed" | "error";
};

const BADGE_ATTR = "data-pmbah-badge";
const SESSION_ATTR = "data-pmbah-session";
const STATE_ATTR = "data-pmbah-state";

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

// One transient eligibility-time read of the field's text length. The string
// reference dies when this function returns; only the boolean leaves the call.
function isFieldEmpty(element: HTMLElement): boolean {
  if (isTextField(element)) return element.value.length === 0;
  if (isContentEditable(element)) return (element.textContent ?? "").trim().length === 0;
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
  badge.textContent = stateLabel(state, note);
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
  const entry: FieldEntry = { element, session_id: null, state: "pending" };
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

/**
 * beforeinput is the canonical content-blind capture point: it fires BEFORE
 * the browser applies the change, so `target.value`, `target.selectionStart`,
 * and `target.selectionEnd` reflect the pre-change state. We read those three
 * values inline, compute codepoint-anchored numeric metadata via
 * `buildTextFieldMutation`, and the string references die when this handler
 * returns. No text crosses event boundaries.
 *
 * If the selection is empty AND there is no inserted text AND no inputType is
 * provided, the cycle is ambiguous (e.g. a programmatic format change) and we
 * emit nulls rather than retain text to disambiguate.
 */
function handleBeforeInput(event: InputEvent): void {
  const target = event.target as Element | null;
  if (!target || !(target instanceof HTMLElement)) return;
  const entry = fields.get(target);
  if (!entry || entry.state !== "recording" || !entry.session_id) return;
  const inputType = event.inputType ?? null;
  const insertedText = event.data ?? "";

  if (isTextField(target)) {
    const start = target.selectionStart ?? 0;
    const end = target.selectionEnd ?? 0;
    if (insertedText.length === 0 && start === end && !inputType) {
      sendMutation(entry, ambiguousMutation(insertedText, inputType));
      return;
    }
    const mutation = buildTextFieldMutation({
      text: target.value,
      selectionStartUtf16: start,
      selectionEndUtf16: end,
      insertedText,
      inputType,
    });
    sendMutation(entry, mutation);
    return;
  }

  // ContentEditable: degraded. Emit codepoint-counted ins_len from event.data
  // (the only reliable numeric we have without walking the DOM tree), and
  // leave pos and del_len as null rather than fabricate an offset.
  sendMutation(entry, {
    op: insertedText.length > 0 ? "insert" : "delete",
    pos: null,
    del_len: null,
    ins_len: codepointCount(insertedText),
    source: sourceFromInputType(inputType),
  });
}

function ambiguousMutation(insertedText: string, inputType: string | null): PendingMutation {
  return {
    op: insertedText.length > 0 ? "insert" : "delete",
    pos: null,
    del_len: null,
    ins_len: codepointCount(insertedText),
    source: sourceFromInputType(inputType),
  };
}

async function sendMutation(entry: FieldEntry, mutation: PendingMutation): Promise<void> {
  if (!entry.session_id) return;
  const response = await chrome.runtime.sendMessage({
    kind: "append_mutation",
    session_id: entry.session_id,
    mutation,
  });
  if (response.kind === "error") {
    setBadge(entry.element, "error", response.reason);
    entry.state = "error";
  }
}

function attachListeners(element: HTMLElement): void {
  element.addEventListener("focus", () => {
    void registerField(element);
  });
  element.addEventListener("beforeinput", (event) => {
    handleBeforeInput(event as InputEvent);
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
  isEligibleElement,
  ambiguousMutation,
};

export const CONTENT_ENTRYPOINT = "capture";
