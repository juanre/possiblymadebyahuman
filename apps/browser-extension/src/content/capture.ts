import {
  buildTextFieldMutation,
  codepointCount,
  codepointOffsetOf,
  collapsedDeletionMutation,
  compositionMutation,
  contentEditableInsertedCodepoints,
  insertedCodepointsForInput,
  isDeletionInputType,
  isNetChangeInputType,
  measuredReplacementMutation,
  netLengthChangeMutation,
  sourceFromInputType,
} from "../lib/codepoint.ts";
import { extractDescriptor, isEligibleTag } from "../lib/descriptor.ts";
import {
  isComputeBindingRequest,
  type BackgroundResponse,
  type ComputeBindingResponse,
  type ContentToBackground,
} from "../lib/messages.ts";
import type { PendingMutation } from "../../../../packages/producer-core/src/index.ts";
import { canonicalizeTextForBinding, createTextBinding, type Source } from "../../../../packages/format/src/index.ts";

declare const chrome: {
  runtime: {
    sendMessage(message: ContentToBackground): Promise<BackgroundResponse>;
    onMessage: {
      addListener(
        listener: (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean | void,
      ): void;
    };
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

// Numeric-only state that has to survive from one DOM event to the next: the
// field's codepoint length before a change whose size is only measurable after
// the browser applies it, the span an IME composition started over, and
// mutations captured while the field's registration round-trip is pending.
// Holding numbers across events is content-blind; holding text is not.
type MeasuredChangeKind = "deletion" | "net_change" | "replacement";

type FieldTransient = {
  measuring: { length_before: number; ins_len: number | null; kind: MeasuredChangeKind; source: Source } | null;
  composition: { pos: number | null; del_len: number | null } | null;
  queue: PendingMutation[];
};

const transients = new WeakMap<HTMLElement, FieldTransient>();
const listening = new WeakSet<HTMLElement>();

function transientFor(element: HTMLElement): FieldTransient {
  let transient = transients.get(element);
  if (!transient) {
    transient = { measuring: null, composition: null, queue: [] };
    transients.set(element, transient);
  }
  return transient;
}

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
  const known = fields.get(element);
  // A field that was ineligible (it had content) or errored is re-evaluated on
  // focus: it may be empty now, or its uploaded session may be resumable.
  if (known && known.state !== "ineligible" && known.state !== "error") return;
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

  const transient = transientFor(element);
  if (response.kind !== "register_field_result") {
    setBadge(element, "error", `register_failed:${response.kind === "error" ? response.reason : "unexpected"}`);
    entry.state = "error";
    transient.queue.length = 0;
    return;
  }
  if (response.result.kind === "ineligible") {
    setBadge(element, "ineligible");
    entry.state = "ineligible";
    transient.queue.length = 0;
    return;
  }
  entry.session_id = response.result.session_id;
  element.setAttribute(SESSION_ATTR, response.result.session_id);
  setBadge(element, "recording", response.result.certainty === "fresh" ? "recording" : `recording (${response.result.certainty})`);
  // Send the queued mutations before accepting live ones so order is kept.
  for (const mutation of transient.queue.splice(0)) void sendMutation(entry, mutation);
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
  if (!entry || (entry.state !== "recording" && entry.state !== "pending")) return;
  const transient = transientFor(target);
  // A new beforeinput means the previous measured change never produced an
  // input event (a Backspace with nothing to delete, or the page cancelled it);
  // its stale measurement must not be applied to this change.
  transient.measuring = null;
  // Composition keystrokes are recorded once, at compositionend.
  if (transient.composition) return;
  const inputType = event.inputType ?? null;
  const insertedText = event.data ?? "";
  const insertedCodepoints = insertedCodepointsForInput(inputType, insertedText);

  if (isTextField(target)) {
    const start = target.selectionStart ?? 0;
    const end = target.selectionEnd ?? 0;
    const collapsed = start === end;
    // Collapsed deletes, undo/redo, formatting and spellcheck replacements are
    // sized by comparing the field length before and after the browser
    // applies them; only the numeric length crosses to the input handler.
    if (isNetChangeInputType(inputType) || (collapsed && isDeletionInputType(inputType)) || inputType === "insertReplacementText") {
      transient.measuring = {
        length_before: codepointCount(target.value),
        ins_len: inputType === "insertReplacementText" ? insertedCodepoints : null,
        kind: inputType === "insertReplacementText" ? "replacement" : isDeletionInputType(inputType) ? "deletion" : "net_change",
        source: sourceFromInputType(inputType),
      };
      return;
    }
    if (insertedCodepoints === 0 && collapsed && !inputType) {
      queueOrSend(entry, ambiguousMutation(insertedText, inputType));
      return;
    }
    queueOrSend(entry, buildTextFieldMutation({
      text: target.value,
      selectionStartUtf16: start,
      selectionEndUtf16: end,
      insertedText,
      inputType,
    }));
    return;
  }

  // ContentEditable: degraded. Positions are never fabricated. Deletions and
  // undo/redo/formatting are sized from the editor's text length before and
  // after; insertions from event.data or the transferred clipboard/drag text.
  if (isDeletionInputType(inputType) || isNetChangeInputType(inputType)) {
    transient.measuring = {
      length_before: codepointCount(target.textContent ?? ""),
      ins_len: null,
      kind: isDeletionInputType(inputType) ? "deletion" : "net_change",
      source: sourceFromInputType(inputType),
    };
    return;
  }
  const transferred = event.dataTransfer?.getData("text/plain") ?? null;
  queueOrSend(entry, {
    op: "insert",
    pos: null,
    del_len: null,
    ins_len: contentEditableInsertedCodepoints(inputType, event.data, transferred),
    source: sourceFromInputType(inputType),
  });
}

// Completes a mutation whose size was only measurable after the browser applied
// it. Reads the field length and caret once, numerically, and discards the
// reference when the handler returns.
function handleInput(event: Event): void {
  const target = event.target as Element | null;
  if (!target || !(target instanceof HTMLElement)) return;
  const entry = fields.get(target);
  const transient = transients.get(target);
  if (!entry || !transient?.measuring) return;
  const { length_before, ins_len, kind, source } = transient.measuring;
  transient.measuring = null;

  if (isTextField(target)) {
    const lengthAfter = codepointCount(target.value);
    const caretAfter = codepointOffsetOf(target.value, target.selectionStart ?? lengthAfter);
    const mutation = kind === "replacement" && ins_len !== null
      ? measuredReplacementMutation({ lengthBefore: length_before, lengthAfter, insLen: ins_len, caretAfterCodepoints: caretAfter, source })
      : kind === "deletion"
        ? collapsedDeletionMutation({ lengthBefore: length_before, lengthAfter, caretAfterCodepoints: caretAfter, source })
        : netLengthChangeMutation({ lengthBefore: length_before, lengthAfter });
    if (mutation) queueOrSend(entry, mutation);
    return;
  }

  const lengthAfter = codepointCount(target.textContent ?? "");
  const mutation = netLengthChangeMutation({ lengthBefore: length_before, lengthAfter });
  if (!mutation) return;
  if (kind === "deletion") mutation.source = source;
  queueOrSend(entry, mutation);
}

function handleCompositionStart(event: CompositionEvent): void {
  const target = event.target as Element | null;
  if (!target || !(target instanceof HTMLElement)) return;
  const entry = fields.get(target);
  if (!entry || (entry.state !== "recording" && entry.state !== "pending")) return;
  const transient = transientFor(target);
  if (isTextField(target)) {
    const start = target.selectionStart ?? 0;
    const end = target.selectionEnd ?? 0;
    transient.composition = {
      pos: codepointOffsetOf(target.value, Math.min(start, end)),
      del_len: codepointCount(target.value.slice(Math.min(start, end), Math.max(start, end))),
    };
    return;
  }
  transient.composition = { pos: null, del_len: null };
}

function handleCompositionEnd(event: CompositionEvent): void {
  const target = event.target as Element | null;
  if (!target || !(target instanceof HTMLElement)) return;
  const entry = fields.get(target);
  const transient = transients.get(target);
  if (!entry || !transient?.composition) return;
  const composition = transient.composition;
  transient.composition = null;
  const mutation = compositionMutation({ ...composition, committedText: event.data ?? "" });
  if (mutation) queueOrSend(entry, mutation);
}

// Mutations captured while the registration round-trip is still pending (the
// service worker may be cold-starting) are held as numeric shapes and flushed
// once the session id arrives, so the first keystrokes are not lost.
function queueOrSend(entry: FieldEntry, mutation: PendingMutation): void {
  if (entry.state === "pending") {
    transientFor(entry.element).queue.push(mutation);
    return;
  }
  void sendMutation(entry, mutation);
}

function ambiguousMutation(insertedText: string, inputType: string | null): PendingMutation {
  const insertedCodepoints = insertedCodepointsForInput(inputType, insertedText);
  return {
    op: insertedCodepoints > 0 ? "insert" : "delete",
    pos: null,
    del_len: null,
    ins_len: insertedCodepoints,
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
    return;
  }
  if (response.kind === "append_mutation_result" && response.session_id && response.session_id !== entry.session_id) {
    entry.session_id = response.session_id;
    entry.element.setAttribute(SESSION_ATTR, response.session_id);
    setBadge(entry.element, "recording", "recording (continues a signed record)");
  }
}

function attachListeners(element: HTMLElement): void {
  // DOM re-parenting re-runs the scan; a field gets one set of listeners.
  if (listening.has(element)) return;
  listening.add(element);
  element.addEventListener("focus", () => {
    void registerField(element);
  });
  element.addEventListener("beforeinput", (event) => {
    handleBeforeInput(event as InputEvent);
  });
  element.addEventListener("input", handleInput);
  element.addEventListener("blur", () => {
    const transient = transients.get(element);
    if (transient) transient.measuring = null;
  });
  element.addEventListener("compositionstart", (event) => {
    handleCompositionStart(event as CompositionEvent);
  });
  element.addEventListener("compositionend", (event) => {
    handleCompositionEnd(event as CompositionEvent);
  });
}

function scan(root: ParentNode): void {
  const fieldsList = root.querySelectorAll("textarea, input, [contenteditable]");
  for (const el of Array.from(fieldsList) as HTMLElement[]) {
    if (isEligibleElement(el)) attachListeners(el);
  }
}

// Read a field's text transiently to compute the content-blind binding. If the
// user has selected text inside the field/editor at sign time, bind that
// selection; otherwise bind all current field/editor content. The text lives
// only in this function's scope and is discarded on return; only the sealed
// {scheme, canonical_length, commitment} object leaves here.
function computeBindingForSession(session_id: string): ComputeBindingResponse {
  const element = document.querySelector(`[${SESSION_ATTR}="${session_id}"]`);
  if (!(element instanceof HTMLElement)) return { kind: "binding_result", text_binding: null };
  const text = bindingTextForElement(element);
  if (canonicalizeTextForBinding(text).length === 0) return { kind: "binding_result", text_binding: null };
  return { kind: "binding_result", text_binding: createTextBinding(text, session_id) };
}

function bindingTextForElement(element: HTMLElement): string {
  return selectedTextForElement(element) ?? allTextForElement(element);
}

function allTextForElement(element: HTMLElement): string {
  if (isTextField(element)) return element.value;
  if (isContentEditable(element)) return element.textContent ?? "";
  return "";
}

function selectedTextForElement(element: HTMLElement): string | null {
  if (isTextField(element)) {
    const start = element.selectionStart;
    const end = element.selectionEnd;
    if (typeof start !== "number" || typeof end !== "number" || start === end) return null;
    return element.value.slice(Math.min(start, end), Math.max(start, end));
  }
  if (!isContentEditable(element)) return null;
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  if (!nodeIsInsideElement(selection.anchorNode, element) || !nodeIsInsideElement(selection.focusNode, element)) return null;
  const text = selection.toString();
  return text.length > 0 ? text : null;
}

function nodeIsInsideElement(node: Node | null, element: HTMLElement): boolean {
  if (!node) return false;
  return node === element || element.contains(node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement);
}

function start(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isComputeBindingRequest(message)) return false;
    try {
      sendResponse(computeBindingForSession(message.session_id));
    } catch (error) {
      sendResponse({ kind: "binding_error", reason: error instanceof Error ? error.message : String(error) });
    }
    return false;
  });
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
  bindingTextForElement,
};

export const CONTENT_ENTRYPOINT = "capture";
