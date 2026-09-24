import { NumericTextIndex, applyNumericTextInput, type NumericTextIntent } from "../../../../packages/browser-capture/src/numeric-text-index.ts";
import { measureRichText, richTextIndex, releaseRichTextIndex, richMutation, type RichChange } from "../lib/richtext.ts";
import { codepointCount, codepointOffsetOf, isDeletionInputType, sourceFromInputType } from "../lib/codepoint.ts";
import { deriveMutationFromMeasuredInput, unknownMutation, type MeasuredInputIntent } from "../../../../packages/producer-core/src/measured-input.ts";
import { extractDescriptor, isEligibleTag } from "../lib/descriptor.ts";
import {
  type BackgroundResponse,
  type ComputeBindingResponse,
  type FinishScopePreview,
  type ContentToBackground,
} from "../lib/messages.ts";
import type { PendingMutation } from "../../../../packages/producer-core/src/index.ts";
import { canonicalizeTextForBinding, createTextBinding } from "../../../../packages/format/src/index.ts";

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
  queued_count?: number;
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
type CapturedMutation = { mutation: PendingMutation; captured_at_wall_ms: number };

type FieldTransient = {
  pending: MeasuredInputIntent | null;
  composition: { text?: Omit<MeasuredInputIntent, "inputType" | "dataCodepoints">; rich?: RichChange } | null;
  composition_commit: { length: number | null; caret: number | null } | null;
  text_length: number | null;
  text_index: NumericTextIndex | null;
  text_intent: NumericTextIntent | null;
  text_gap: boolean;
  rich_before: RichChange | null;
  rich_length: number | null;
  rich_gap: boolean;
  cycle: number;
  queue: CapturedMutation[];
};

const transients = new WeakMap<HTMLElement, FieldTransient>();
const listening = new WeakSet<HTMLElement>();

function transientFor(element: HTMLElement): FieldTransient {
  let transient = transients.get(element);
  if (!transient) {
    transient = { pending: null, composition: null, composition_commit: null, text_length: null, text_index: null, text_intent: null, text_gap: false, rich_before: null, rich_length: null, rich_gap: false, cycle: 0, queue: [] };
    transients.set(element, transient);
  }
  return transient;
}

// beforeinput may be canceled, or a no-op delete may never produce input.
// Expire only numeric metadata after that browser task, so finish does not
// mistake an abandoned cycle for an edit in progress. New cycles supersede it.
function expireCaptureCycle(transient: FieldTransient, element: HTMLElement): void {
  const cycle = ++transient.cycle;
  setTimeout(() => {
    if (transient.cycle !== cycle) return;
    transient.pending = null;
    if (!transient.composition) { transient.text_intent = null; if (isContentEditable(element)) richTextIndex(element).clearPending(); }
    transient.rich_before = null;
  }, 0);
}

function releaseCaptureIndex(entry: FieldEntry): void {
  releaseRichTextIndex(entry.element);
  const transient = transients.get(entry.element);
  if (transient) {
    ++transient.cycle; // Cancel cleanup timers without recreating an observer.
    transient.text_index = null;
    transient.text_intent = null;
    transient.pending = null;
    transient.rich_before = null;
    transient.composition = null;
    transient.composition_commit = null;
  }
}
function captureError(entry: FieldEntry): void {
  entry.state = "error";
  releaseCaptureIndex(entry);
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
  transient.text_index = isTextField(element) ? new NumericTextIndex(element.value) : null;
  transient.text_length = transient.text_index?.length ?? null;
  const started_at_wall_ms = Date.now();
  attachListeners(element);
  const response = await chrome.runtime.sendMessage({
    kind: "register_field", tab_id: -1, frame_id: -1,
    origin_url: window.location.origin, page_path: window.location.pathname,
    page_title: document.title, descriptor, field_is_empty: isFieldEmpty(element),
    started_at_wall_ms,
    activation_id, ...(share_session_id ? { share_session_id } : {}), ...(resume_session_id ? { resume_session_id } : {}), ...(continue_session_id ? { continue_session_id } : {}),
  }).catch((error): BackgroundResponse => ({ kind: "error", reason: `The editor could not be started. ${String(error)}` }));
  if (response.kind !== "register_field_result" || response.result.kind !== "registered") {
    captureError(entry);
    transient.queue.length = 0;
    activeEntries.delete(entryRef);
    return { kind: "start_editor_result", reason: response.kind === "error" ? response.reason : "The writing record could not be started. Try again." };
  }
  entry.session_id = response.result.session_id;
  if ((entry.state as string) === "error") {
    transient.queue.length = 0;
    return { kind: "start_editor_result", reason: "Capture stopped because local saving could not keep up. Start a new recording for future edits." };
  }
  for (const mutation of transient.queue.splice(0)) void sendMutation(entry, mutation);
  entry.state = "recording";
  return { kind: "start_editor_result", session_id: entry.session_id };
}

// Text is inspected only within this call; only numeric facts survive.
function measureTextField(target: HTMLInputElement | HTMLTextAreaElement): Omit<MeasuredInputIntent, "inputType" | "dataCodepoints"> {
  const transient = transientFor(target);
  const index = transient.text_index ??= new NumericTextIndex(target.value);
  if (index.utf16Length !== target.value.length) index.reset(target.value);
  const start = target.selectionStart, end = target.selectionEnd;
  return { lengthBefore: index.length, selectionStartCodepoints: start === null ? null : index.offset(start),
    selectedCodepoints: start === null || end === null ? null : index.offset(Math.max(start, end)) - index.offset(Math.min(start, end)) };
}
function beginTextIndex(target: HTMLInputElement | HTMLTextAreaElement, transient: FieldTransient, inputType: string, dataLength: number | null): void {
  transient.text_intent = { length: target.value.length, start: target.selectionStart, end: target.selectionEnd, inputType, dataLength };
}
function applyTextIndex(target: HTMLInputElement | HTMLTextAreaElement, transient: FieldTransient): void {
  const index = transient.text_index ??= new NumericTextIndex(target.value);
  applyNumericTextInput(index, target.value, target.selectionStart, transient.text_intent);
  transient.text_intent = null;
}

function handleBeforeInput(event: InputEvent): void {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const entry = fields.get(target);
  if (!entry || (entry.state !== "recording" && entry.state !== "pending")) return;
  const transient = transientFor(target);
  transient.pending = null;
  transient.rich_before = null;
  expireCaptureCycle(transient, target);
  if (transient.composition) return;
  if (transient.composition_commit && event.inputType?.includes("Composition")) return;
  transient.composition_commit = null;
  const inputType = event.inputType ?? "";
  if (isTextField(target)) {
    const measured = measureTextField(target);
    if (transient.text_length !== null && measured.lengthBefore !== transient.text_length) transient.text_gap = true;
    beginTextIndex(target, transient, inputType, typeof event.data === "string" ? event.data.length : null);
    transient.pending = { ...measured, inputType,
      dataCodepoints: typeof event.data === "string" ? codepointCount(event.data) : null };
    return;
  }
  const ranges = event.getTargetRanges?.() ?? [];
  const range = ranges.length === 1 ? ranges[0] : undefined;
  const before = measureRichText(target, range);
  const selection = target.ownerDocument.getSelection();
  richTextIndex(target).prepare(range ?? (selection?.rangeCount === 1 ? selection.getRangeAt(0) : null), inputType, typeof event.data === "string" ? event.data.length : null);
  transient.rich_gap ||= transient.rich_length !== null && before.length !== transient.rich_length;
  transient.rich_before = {
    ...before,
    source: sourceFromInputType(inputType),
    kind: inputType.startsWith("format") ? "format" : inputType.startsWith("history") ? "history"
      : isDeletionInputType(inputType) ? "delete" : inputType.startsWith("insert") ? "insert" : "unknown",
  };
}

function handleInput(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const entry = fields.get(target);
  const transient = transients.get(target);
  if (!entry || !transient || transient.composition || (entry.state !== "recording" && entry.state !== "pending")) return;
  const inputEvent = event as InputEvent;
  if (transient.composition_commit && (inputEvent.inputType?.includes("Composition") || inputEvent.isComposing)) {
    const after = isTextField(target) ? measureTextField(target) : null;
    const rich = after ? null : measureRichText(target);
    const matches = transient.composition_commit.length === (after?.lengthBefore ?? rich?.length) &&
      transient.composition_commit.caret === (after ? after.selectionStartCodepoints : rich?.start);
    transient.composition_commit = null;
    transient.pending = null;
    if (matches) return;
  } else transient.composition_commit = null;
  if (!isTextField(target)) {
    const after = measureRichText(target);
    richTextIndex(target).clearPending();
    const mutation = transient.rich_before ? richMutation(transient.rich_before, after) : unknownMutation();
    transient.rich_before = null;
    transient.rich_length = after.length;
    if (mutation) {
      queueOrSend(entry, transient.rich_gap ? { ...mutation, pos: null } : mutation);
      transient.rich_gap = false;
    }
    return;
  }
  const intent = transient.pending;
  transient.pending = null;
  applyTextIndex(target, transient);
  const after = measureTextField(target);
  const mutation = intent ? deriveMutationFromMeasuredInput(intent, after.lengthBefore, after.selectionStartCodepoints) : unknownMutation();
  emitTextMutation(entry, transient, mutation, after.lengthBefore);
}

function emitTextMutation(entry: FieldEntry, transient: FieldTransient, mutation: PendingMutation | null, lengthAfter: number): void {
  if (mutation) {
    queueOrSend(entry, transient.text_gap ? { ...mutation, pos: null } : mutation);
    transient.text_gap = false;
  }
  transient.text_length = lengthAfter;
}

function handleCompositionStart(event: CompositionEvent): void {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const entry = fields.get(target);
  if (!entry || (entry.state !== "recording" && entry.state !== "pending")) return;
  const transient = transientFor(target);
  transient.pending = null;
  transient.composition_commit = null;
  if (isTextField(target)) {
    const measured = measureTextField(target);
    if (transient.text_length !== null && measured.lengthBefore !== transient.text_length) transient.text_gap = true;
    beginTextIndex(target, transient, "insertFromComposition", null);
    transient.composition = { text: measured };
    return;
  }
  const before = measureRichText(target);
  transient.rich_gap ||= transient.rich_length !== null && before.length !== transient.rich_length;
  transient.rich_before = null;
  const selection = target.ownerDocument.getSelection();
  richTextIndex(target).prepare(selection?.rangeCount === 1 ? selection.getRangeAt(0) : null, "insertFromComposition", null, true);
  transient.composition = { rich: { ...before, source: "ime", kind: "insert" } };
}

function handleCompositionEnd(event: CompositionEvent): void {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const entry = fields.get(target);
  const transient = transients.get(target);
  if (!entry || !transient?.composition || (entry.state !== "recording" && entry.state !== "pending")) return;
  const composition = transient.composition;
  transient.composition = null;
  transient.pending = null;
  let mutation: PendingMutation | null = null;
  if (composition.rich) {
    const after = measureRichText(target);
    richTextIndex(target).clearPending();
    transient.composition_commit = { length: after.length, caret: after.start };
    mutation = event.data === "" && after.length === composition.rich.length ? null : richMutation(composition.rich, after);
    transient.rich_length = after.length;
  } else if (composition.text && isTextField(target)) {
    applyTextIndex(target, transient);
    const after = measureTextField(target);
    transient.composition_commit = { length: after.lengthBefore, caret: after.selectionStartCodepoints };
    const inserted = codepointCount(event.data ?? "");
    if (inserted !== 0 || after.lengthBefore !== composition.text.lengthBefore) {
      mutation = deriveMutationFromMeasuredInput({ ...composition.text, inputType: "insertFromComposition", dataCodepoints: inserted },
        after.lengthBefore, after.selectionStartCodepoints);
    }
    emitTextMutation(entry, transient, mutation, after.lengthBefore);
    return;
  }
  if (mutation) {
    queueOrSend(entry, transient.rich_gap ? { ...mutation, pos: null } : mutation);
    transient.rich_gap = false;
  }
}

// Mutations captured while the registration round-trip is still pending (the
// service worker may be cold-starting) are held as numeric shapes and flushed
// once the session id arrives, so the first keystrokes are not lost.
function queueOrSend(entry: FieldEntry, mutation: PendingMutation): void {
  if (entry.state !== "recording" && entry.state !== "pending") return;
  const captured = { mutation, captured_at_wall_ms: Date.now() };
  if (entry.state === "pending") {
    if (transientFor(entry.element).queue.length >= 4096) { captureError(entry); return; }
    transientFor(entry.element).queue.push(captured);
    return;
  }
  void sendMutation(entry, captured);
}

function sendMutation(entry: FieldEntry, captured: CapturedMutation): Promise<void> {
  if ((entry.queued_count ?? 0) >= 4096) {
    captureError(entry);
    const failed = Promise.reject(new Error("Capture stopped because local saving cannot keep up. Finish is disabled; restart capture to record future edits."));
    void failed.catch(() => undefined);
    entry.sending = failed;
    return failed;
  }
  entry.queued_count = (entry.queued_count ?? 0) + 1;
  entry.sending = entry.sending.then(async () => {
    if (!entry.session_id) return;
    const response = await chrome.runtime.sendMessage({ kind: "append_mutation", session_id: entry.session_id, ...captured });
    if (response.kind === "error") { captureError(entry); throw new Error(response.reason); }
  });
  entry.sending = entry.sending.finally(() => { entry.queued_count = Math.max(0, (entry.queued_count ?? 1) - 1); });
  // Retain the rejection for finish/flush, while handling it here to avoid an
  // unhandled rejection when capture is sending without an open panel.
  void entry.sending.catch(() => { captureError(entry); });
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
  releaseCaptureIndex(entry);
  if (transient) transient.rich_gap = false;
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
  const transient = transients.get(element);
  if (transient) {
    if (isTextField(element)) transient.text_gap ||= codepointCount(element.value) !== transient.text_length;
    else transient.rich_gap ||= measureRichText(element).length !== transient.rich_length;
    if (transient.text_gap || transient.rich_gap) {
      return { kind: "binding_error", reason: "Capture has a gap. The record has stopped; a text binding is unavailable. You can publish its recorded editing activity without a text binding." };
    }
  }
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
  bindingTextForElement,
};

export const CONTENT_ENTRYPOINT = "capture";
