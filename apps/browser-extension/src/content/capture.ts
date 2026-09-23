import { measureRichText, richMutation, type RichChange } from "../lib/richtext.ts";
import {
  buildTextFieldMutation,
  codepointCount,
  codepointOffsetOf,
  collapsedDeletionMutation,
  compositionMutation,
  insertedCodepointsForInput,
  isDeletionInputType,
  isNetChangeInputType,
  measuredReplacementMutation,
  netLengthChangeMutation,
  sourceFromInputType,
} from "../lib/codepoint.ts";
import { extractDescriptor, isEligibleTag } from "../lib/descriptor.ts";
import {
  type BackgroundResponse,
  type ComputeBindingResponse,
  type FinishScopePreview,
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
  sending: Promise<void>;
  finish_binding?: ComputeBindingResponse;
};

// Element/session references are private to this isolated world; nothing is
// injected into the host page, including attributes or floating controls.
const fields = new WeakMap<HTMLElement, FieldEntry>();
const activeEntries = new Set<WeakRef<FieldEntry>>();
function entries(): FieldEntry[] {
  const result: FieldEntry[] = [];
  for (const ref of activeEntries) { const entry = ref.deref(); if (entry) result.push(entry); else activeEntries.delete(ref); }
  return result;
}
let contextTarget: WeakRef<HTMLElement> | null = null;
let focusedTarget: WeakRef<HTMLElement> | null = null;

// Numeric-only state that has to survive from one DOM event to the next: the
// field's codepoint length before a change whose size is only measurable after
// the browser applies it, the span an IME composition started over, and
// mutations captured while the field's registration round-trip is pending.
// Holding numbers across events is content-blind; holding text is not.
type MeasuredChangeKind = "deletion" | "net_change" | "replacement";

type FieldTransient = {
  pending: PendingMutation | null;
  measuring: { length_before: number; ins_len: number | null; kind: MeasuredChangeKind; source: Source } | null;
  composition: { pos: number | null; del_len: number | null; rich?: RichChange } | null;
  rich_before: RichChange | null;
  rich_length: number | null;
  rich_gap: boolean;
  cycle: number;
  queue: PendingMutation[];
};

const transients = new WeakMap<HTMLElement, FieldTransient>();
const listening = new WeakSet<HTMLElement>();

function transientFor(element: HTMLElement): FieldTransient {
  let transient = transients.get(element);
  if (!transient) {
    transient = { pending: null, measuring: null, composition: null, rich_before: null, rich_length: null, rich_gap: false, cycle: 0, queue: [] };
    transients.set(element, transient);
  }
  return transient;
}

// beforeinput may be canceled, or a no-op delete may never produce input.
// Expire only numeric metadata after that browser task, so finish does not
// mistake an abandoned cycle for an edit in progress. New cycles supersede it.
function expireCaptureCycle(transient: FieldTransient): void {
  const cycle = ++transient.cycle;
  setTimeout(() => {
    if (transient.cycle !== cycle) return;
    transient.pending = null;
    transient.measuring = null;
    transient.rich_before = null;
  }, 0);
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
  if (isContentEditable(element)) return measureRichText(element).length === 0;
  return true;
}

async function registerField(element: HTMLElement, activation_id: string, share_session_id?: string, resume_session_id?: string, continue_session_id?: string): Promise<BackgroundResponse> {
  const known = fields.get(element);
  if (known?.state === "recording" && ((resume_session_id && known.session_id !== resume_session_id) || continue_session_id)) return { kind: "start_editor_result", reason: "This editor already has an active draft. Stop it first." };
  if (known?.state === "recording") return { kind: "start_editor_result", session_id: known.session_id! };
  if (known?.state === "pending") return { kind: "start_editor_result", reason: "Start is already in progress." };
  if (!element.isConnected || !isEligibleElement(element)) return { kind: "start_editor_result", reason: "Choose an editable text field first." };
  const descriptor = extractDescriptor({
    tagName: element.tagName,
    getAttribute: (name) => element.getAttribute(name),
    closest: (selector) => element.closest(selector) as { getAttribute(name: string): string | null } | null,
    parentElement: parentSlice(element),
  });
  for (const ref of activeEntries) if (ref.deref() === known) activeEntries.delete(ref);
  const entry: FieldEntry = { element, session_id: null, state: "pending", sending: Promise.resolve() };
  fields.set(element, entry);
  const entryRef = new WeakRef(entry);
  activeEntries.add(entryRef);
  transients.delete(element);
  const transient = transientFor(element);
  transient.rich_length = isContentEditable(element) ? measureRichText(element).length : null;
  attachListeners(element);
  const response = await chrome.runtime.sendMessage({
    kind: "register_field", tab_id: -1, frame_id: -1,
    origin_url: window.location.origin, page_path: window.location.pathname,
    page_title: document.title, descriptor, field_is_empty: isFieldEmpty(element),
    activation_id, ...(share_session_id ? { share_session_id } : {}), ...(resume_session_id ? { resume_session_id } : {}), ...(continue_session_id ? { continue_session_id } : {}),
  }).catch((error): BackgroundResponse => ({ kind: "error", reason: `The editor could not be started. ${String(error)}` }));
  if (response.kind !== "register_field_result" || response.result.kind !== "registered") {
    entry.state = "error";
    transient.queue.length = 0;
    activeEntries.delete(entryRef);
    return { kind: "start_editor_result", reason: response.kind === "error" ? response.reason : "Start in an empty editor. Existing text is not imported into a writing record." };
  }
  entry.session_id = response.result.session_id;
  for (const mutation of transient.queue.splice(0)) void sendMutation(entry, mutation);
  entry.state = "recording";
  return { kind: "start_editor_result", session_id: entry.session_id };
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
  transient.pending = null;
  transient.rich_before = null;
  expireCaptureCycle(transient);
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
      transient.pending = ambiguousMutation(insertedText, inputType);
      return;
    }
    transient.pending = buildTextFieldMutation({
      text: target.value,
      selectionStartUtf16: start,
      selectionEndUtf16: end,
      insertedText,
      inputType,
    });
    return;
  }

  const ranges = event.getTargetRanges?.() ?? [];
  const before = measureRichText(target, ranges.length === 1 ? ranges[0] : undefined);
  transient.rich_gap = transient.rich_length !== null && before.length !== transient.rich_length;
  transient.rich_before = {
    ...before,
    source: sourceFromInputType(inputType),
    kind: inputType?.startsWith("format") ? "format" : inputType?.startsWith("history") ? "history"
      : isDeletionInputType(inputType) ? "delete" : inputType?.startsWith("insert") ? "insert" : "unknown",
  };
}

// Completes a mutation whose size was only measurable after the browser applied
// it. Reads the field length and caret once, numerically, and discards the
// reference when the handler returns.
function handleInput(event: Event): void {
  const target = event.target as Element | null;
  if (!target || !(target instanceof HTMLElement)) return;
  const entry = fields.get(target);
  const transient = transients.get(target);
  if (!entry || !transient || transient.composition || (entry.state !== "recording" && entry.state !== "pending")) return;
  if (!isTextField(target)) {
    const after = measureRichText(target);
    if (transient.rich_gap) queueOrSend(entry, { op: "replace", pos: null, del_len: null, ins_len: null, source: "unknown" });
    const mutation = transient.rich_before ? richMutation(transient.rich_before, after)
      : { op: "replace" as const, pos: null, del_len: null, ins_len: null, source: "unknown" as const };
    transient.rich_before = null;
    transient.rich_gap = false;
    transient.rich_length = after.length;
    if (mutation) queueOrSend(entry, mutation);
    return;
  }
  if (transient.pending) {
    const mutation = transient.pending;
    transient.pending = null;
    queueOrSend(entry, mutation);
    return;
  }
  if (!transient.measuring) return;
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
  const before = measureRichText(target);
  transient.rich_gap = transient.rich_length !== null && before.length !== transient.rich_length;
  transient.rich_before = null;
  transient.composition = {
    pos: before.start,
    del_len: before.start !== null && before.end !== null ? before.end - before.start : null,
    rich: { ...before, source: "ime", kind: "insert" },
  };
}

function handleCompositionEnd(event: CompositionEvent): void {
  const target = event.target as Element | null;
  if (!target || !(target instanceof HTMLElement)) return;
  const entry = fields.get(target);
  const transient = transients.get(target);
  if (!entry || !transient?.composition || (entry.state !== "recording" && entry.state !== "pending")) return;
  const composition = transient.composition;
  transient.composition = null;
  let mutation: PendingMutation | null;
  if (composition.rich) {
    const after = measureRichText(target);
    if (transient.rich_gap) queueOrSend(entry, { op: "replace", pos: null, del_len: null, ins_len: null, source: "unknown" });
    mutation = richMutation(composition.rich, after);
    transient.rich_length = after.length;
    transient.rich_gap = false;
  } else mutation = compositionMutation({ ...composition, committedText: event.data ?? "" });
  if (mutation) queueOrSend(entry, mutation);
}

// Mutations captured while the registration round-trip is still pending (the
// service worker may be cold-starting) are held as numeric shapes and flushed
// once the session id arrives, so the first keystrokes are not lost.
function queueOrSend(entry: FieldEntry, mutation: PendingMutation): void {
  if (entry.state !== "recording" && entry.state !== "pending") return;
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

function sendMutation(entry: FieldEntry, mutation: PendingMutation): Promise<void> {
  entry.sending = entry.sending.then(async () => {
    if (!entry.session_id) return;
    const response = await chrome.runtime.sendMessage({ kind: "append_mutation", session_id: entry.session_id, mutation });
    if (response.kind === "error") { entry.state = "error"; throw new Error(response.reason); }
  });
  // Retain the rejection for finish/flush, while handling it here to avoid an
  // unhandled rejection when capture is sending without an open panel.
  void entry.sending.catch(() => { entry.state = "error"; });
  return entry.sending;
}

function attachListeners(element: HTMLElement): void {
  if (listening.has(element)) return;
  listening.add(element);
  element.addEventListener("beforeinput", (event) => handleBeforeInput(event as InputEvent));
  element.addEventListener("input", handleInput);
  element.addEventListener("compositionstart", (event) => handleCompositionStart(event as CompositionEvent));
  element.addEventListener("compositionend", (event) => handleCompositionEnd(event as CompositionEvent));
}

function editorFor(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null;
  if (isTextField(target)) return isEligibleElement(target) ? target : null;
  if (!target.isContentEditable) return null;
  let root = target;
  while (root.parentElement?.isContentEditable) root = root.parentElement;
  return root;
}

async function freezeSession(session_id: string, bind = false, expected_scope_token?: string): Promise<ComputeBindingResponse> {
  const entry = entries().find((candidate) => candidate.session_id === session_id);
  if (!entry) return { kind: "binding_error", reason: "The selected editor is no longer available." };
  if (entry.finish_binding) return entry.finish_binding;
  if (bind && expected_scope_token !== undefined) {
    const preview = bindingScopeForSession(session_id);
    if (preview.scope_token !== expected_scope_token) return { kind: "binding_scope_changed", ...preview };
  }
  const transient = transients.get(entry.element);
  const wasError = entry.state === "error";
  entry.state = "signed"; // Terminal locally: never pretend to capture edits after finish/stop.
  let result: ComputeBindingResponse;
  // A runtime message cannot interrupt the browser's synchronous
  // beforeinput/default-action/input transaction. Leftover numeric metadata
  // therefore describes an unconfirmed/canceled edit, not one in flight.
  // A framework edit applied asynchronously after this finish is outside the
  // stopped record. Only IME composition actually spans browser tasks.
  if (wasError || transient?.composition) {
    result = { kind: "binding_error", reason: "An edit was still incomplete. The record has stopped; a text binding is unavailable." };
  } else if (!entry.element.isConnected) {
    result = { kind: "binding_error", reason: "The selected editor was closed." };
  } else if (!bind) {
    result = { kind: "binding_result", text_binding: null };
  } else {
    try { result = computeBindingForSession(session_id); }
    catch (error) { result = { kind: "binding_error", reason: String(error) }; }
  }
  if (transient) { transient.pending = null; transient.measuring = null; transient.composition = null; transient.rich_before = null; transient.rich_gap = false; }
  try { await entry.sending; }
  catch { result = { kind: "binding_error", reason: "An edit could not be saved. Text binding is unavailable." }; }
  entry.finish_binding = result;
  return result;
}

// Read a field's text transiently to compute the content-blind binding. If the
// user has selected text inside the field/editor at sign time, bind that
// selection; otherwise bind all current field/editor content. The text lives
// only in this function's scope and is discarded on return; only the sealed
// {scheme, canonical_length, commitment} object leaves here.
function computeBindingForSession(session_id: string): ComputeBindingResponse {
  const element = entries().find((entry) => entry.session_id === session_id)?.element;
  if (!(element instanceof HTMLElement)) return { kind: "binding_result", text_binding: null };
  const text = bindingTextForElement(element);
  if (canonicalizeTextForBinding(text).length === 0) return { kind: "binding_result", text_binding: null };
  return { kind: "binding_result", text_binding: createTextBinding(text, session_id) };
}

// Scope inspection reads selection coordinates only, never the field's words.
// Node identities stay in this isolated context and invalidate replaced ranges.
const scopeNodes = new WeakMap<Node, number>();
let scopeNodeSequence = 0;
function scopeNodeId(node: Node): number {
  let id = scopeNodes.get(node);
  if (id === undefined) { id = ++scopeNodeSequence; scopeNodes.set(node, id); }
  return id;
}
function bindingScopeForSession(session_id: string): FinishScopePreview {
  const entry = entries().find(candidate => candidate.session_id === session_id);
  if (!entry?.element.isConnected || entry.state !== "recording") return { scope: "unavailable", reason: "The editor is not active. Readers can still inspect its saved editing activity." };
  const element = entry.element;
  const revision = transients.get(element)?.cycle ?? 0;
  let range = "whole";
  if (isTextField(element)) {
    const start = element.selectionStart, end = element.selectionEnd;
    if (start !== null && end !== null && start !== end) range = `${Math.min(start, end)}:${Math.max(start, end)}`;
  } else {
    const selection = window.getSelection?.();
    if (selection && !selection.isCollapsed && selection.rangeCount > 0 && nodeIsInsideElement(selection.anchorNode, element) && nodeIsInsideElement(selection.focusNode, element)) {
      const selected = selection.getRangeAt(0);
      range = `${scopeNodeId(selected.startContainer)}:${selected.startOffset}:${scopeNodeId(selected.endContainer)}:${selected.endOffset}`;
    }
  }
  return { scope: range === "whole" ? "whole_field" : "selection", scope_token: `${scopeNodeId(element)}:${revision}:${range}` };
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
  // Dormant target tracking reads no text, registers no sessions and sends no
  // messages. The browser menu supplies the frame; this remembers its exact
  // DOM target, including keyboard-generated context menus.
  document.addEventListener("contextmenu", (event) => { if (!event.isTrusted) return; const target = editorFor(event.composedPath()[0] ?? event.target); contextTarget = target ? new WeakRef(target) : null; }, true);
  document.addEventListener("focusin", (event) => { const target = editorFor(event.composedPath()[0] ?? event.target); focusedTarget = target ? new WeakRef(target) : null; }, true);
  chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
    const message = raw as { kind?: string; target?: string; activation_id?: string; share_session_id?: string; resume_session_id?: string; continue_session_id?: string; session_id?: string; bind?: boolean; expected_scope_token?: string };
    // Only extension-owned contexts can drive capture or read a binding.
    const source = sender as { id?: string; tab?: unknown; url?: string };
    if (source.tab || (source.id && source.id !== chrome.runtime.id) || (source.url && !source.url.startsWith(`chrome-extension://${chrome.runtime.id}/`))) return false;
    if (message.kind === "capture_status") {
      const entry = entries().find((candidate) => candidate.session_id === message.session_id);
      sendResponse({ active: entry?.state === "recording" && entry.element.isConnected });
      return false;
    }
    if (message.kind === "probe_editor") {
      const focused = focusedTarget?.deref();
      const isFocused = !!focused?.isConnected && (document.activeElement === focused || focused.contains(document.activeElement));
      const entry = isFocused ? fields.get(focused!) : undefined;
      sendResponse({ kind: "editor_probe", focused: isFocused, ...(entry?.session_id ? { session_id: entry.session_id } : {}) });
      return false;
    }
    if (message.kind === "start_editor" && message.activation_id) {
      const target = (message.target === "context" ? contextTarget : focusedTarget)?.deref();
      contextTarget = null;
      if (!target) { sendResponse({ kind: "start_editor_result", reason: "Click inside the editor, then choose Start writing record." }); return false; }
      void registerField(target, message.activation_id, message.share_session_id, message.resume_session_id, message.continue_session_id).then(sendResponse).catch((error) => sendResponse({ kind: "start_editor_result", reason: String(error) }));
      return true;
    }
    if (message.kind === "inspect_finish" && message.session_id) {
      sendResponse(bindingScopeForSession(message.session_id));
      return false;
    }
    if (message.kind === "freeze_session" && message.session_id) {
      void freezeSession(message.session_id, message.bind === true, message.expected_scope_token).then(sendResponse);
      return true;
    }
    return false;
  });
}

start();

export const __test = {
  isEligibleElement,
  ambiguousMutation,
  bindingTextForElement,
};

export const CONTENT_ENTRYPOINT = "capture";
