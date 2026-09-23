import type { CaptureContextRedactions, SessionRecord } from "../../../../packages/producer-core/src/index.ts";
import type { BackgroundResponse, ContentToBackground } from "../lib/messages.ts";
import { copyRecordLink, finishRecord, OperationGuard } from "./finish.ts";

declare const chrome: {
  runtime: { sendMessage(message: ContentToBackground): Promise<BackgroundResponse> };
};

const APP = document.getElementById("app")!;
const REVIEW = document.getElementById("review")!;
const NOTICE = document.getElementById("toast")!;
const START = document.getElementById("start") as HTMLButtonElement;
const SHARE = document.getElementById("share") as HTMLInputElement;
const guard = new OperationGuard();
let selectedId: string | undefined;
let lastWorkerSelectedId: string | undefined;
let sessions: SessionRecord[] = [];
let captureStatus: Record<string, "active" | "stopped" | "legacy"> = {};
let reviewing = false;
let renderPending = false;
let lastStartError: string | undefined;
const copyNotices = new Map<string, string>();
const send = (message: ContentToBackground) => chrome.runtime.sendMessage(message);

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}
function fieldLabel(session: SessionRecord): string {
  return session.descriptor.aria_label ?? session.descriptor.name ?? session.descriptor.id ?? session.descriptor.field_kind;
}
function isActive(session: SessionRecord): boolean {
  return session.state === "active" && captureStatus[session.session_id] === "active";
}
function stateLabel(session: SessionRecord): string {
  if (session.state === "uploaded") return "Saved";
  if (session.state === "failed_upload") return "Upload needs retry";
  if (session.state === "signing" || session.state === "uploading") return "Saving…";
  if (captureStatus[session.session_id] === "legacy") return "Earlier local draft · stopped";
  return isActive(session) ? "Active draft" : "Stopped draft";
}
function notify(message: string, error = false): void {
  NOTICE.textContent = message;
  NOTICE.className = `notice${error ? " error" : ""}`;
  NOTICE.hidden = !message;
}
function updateAvailability(): void {
  START.disabled = guard.busy || reviewing;
  document.getElementById("share-option")!.hidden = !sessions.some(s => s.session_id === selectedId && isActive(s));
  if (document.getElementById("share-option")!.hidden) SHARE.checked = false;
}
async function operation(action: () => Promise<void>): Promise<void> {
  await guard.run(async () => {
    // Keep the form in place and lock all actions until the worker answers.
    const buttons = [...document.querySelectorAll<HTMLButtonElement>("button")];
    const disabled = buttons.map(button => button.disabled);
    buttons.forEach(button => { button.disabled = true; });
    APP.setAttribute("aria-busy", "true");
    try { await action(); }
    catch (error) { notify(`Could not complete that action. ${error instanceof Error ? error.message : "Try again."}`, true); }
    finally {
      buttons.forEach((button, i) => { if (button.isConnected) button.disabled = disabled[i]; });
      APP.removeAttribute("aria-busy");
    }
  });
  if (!guard.busy) render();
}
function button(label: string, action: () => void, secondary = false): HTMLButtonElement {
  const element = document.createElement("button");
  element.textContent = label;
  if (secondary) element.className = "secondary";
  element.addEventListener("click", action);
  return element;
}
function render(): void {
  renderPending = false;
  APP.replaceChildren();
  const title = document.createElement("h2");
  title.textContent = "Your drafts and saved records";
  APP.append(title);
  if (!sessions.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No writing records yet. Choose the editor you want to use, then start explicitly.";
    APP.append(empty);
  }
  for (const session of sessions) APP.append(renderSession(session));
  updateAvailability();
}
function renderSession(session: SessionRecord): HTMLElement {
  const selected = session.session_id === selectedId;
  const wrap = document.createElement("article");
  wrap.className = `session${selected ? " selected" : ""}`;
  wrap.dataset.sessionId = session.session_id;
  const heading = document.createElement("div");
  heading.className = "session-head";
  heading.innerHTML = `<span class="session-title">${escapeHtml(fieldLabel(session))}</span><span class="session-state">${stateLabel(session)}</span>`;
  wrap.append(heading);
  const meta = document.createElement("p");
  meta.className = "session-meta";
  meta.textContent = `${session.origin.origin}${session.origin.path} · ${session.continuation_anchor ? "Saved record link; local event log cleared" : `${session.events.length} editing events`}`;
  wrap.append(meta);
  if (session.parent_record) {
    const continuation = document.createElement("p");
    continuation.className = "session-meta";
    continuation.textContent = "Continues an earlier saved writing record.";
    wrap.append(continuation);
  }
  if (session.observation.state !== "disabled" && session.events.length) {
    const observation = document.createElement("p");
    observation.className = "session-meta";
    const count = session.observation.last_committed_event_count;
    observation.textContent = count > 0
      ? `Server checkpoints cover ${count} of ${session.events.length} events. This describes receipt timing, not authorship.`
      : "No server checkpoint has been confirmed yet. Your edits remain in this local draft.";
    wrap.append(observation);
  }
  const actions = document.createElement("div");
  actions.className = "session-actions";
  if (!selected) {
    actions.append(button("Select this record", () => {
      if (reviewing || guard.busy) return;
      selectedId = session.session_id;
      SHARE.checked = false;
      render();
    }, true));
  } else if (session.state === "active") {
    const finish = button("Finish & get link", () => openReview(session));
    finish.disabled = !session.events.length;
    actions.append(finish);
    if (isActive(session)) actions.append(button("Stop", () => void operation(async () => {
      const response = await send({ kind: "stop_session", session_id: session.session_id });
      if (response.kind === "error") notify(response.reason, true);
      else notify("Capture stopped. Further edits are not included. You can publish its editing activity without a wording commitment, or clear the editor before starting a new record.");
      await refresh();
    }), true));
  } else if (selected && session.state === "failed_upload") {
    actions.append(button("Retry upload", () => void operation(async () => {
      notify("Retrying the same signed record…");
      await reportOutcome(await send({ kind: "retry_failed_upload", session_id: session.session_id }));
    })));
  }
  if (selected && !["signing", "uploading"].includes(session.state)) {
    actions.append(button(session.state === "uploaded" ? "Remove local reference" : "Discard local draft", () => {
      if (!window.confirm(session.state === "uploaded" ? "Remove this local reference? The public record remains available at its link." : "Discard this local draft? Capture will stop and these local events cannot be recovered.")) return;
      void operation(async () => {
        const response = await send({ kind: "discard_session", session_id: session.session_id });
        if (response.kind === "error") notify(response.reason, true);
        else notify("Local draft or reference removed.");
        await refresh();
      });
    }, true));
  }
  if (actions.childElementCount) wrap.append(actions);
  if (session.uploaded_response) wrap.append(savedResult(session));
  if (session.state === "failed_upload") {
    const failure = document.createElement("p");
    failure.className = "notice error";
    failure.textContent = `Upload did not finish. ${session.last_failure_reason ?? "The server could not be reached."} Retry sends the same signed record.`;
    wrap.append(failure);
  }
  if (reviewing || guard.busy) wrap.querySelectorAll("button").forEach(element => { element.disabled = true; });
  return wrap;
}
function savedResult(session: SessionRecord): HTMLElement {
  const saved = document.createElement("section");
  saved.className = "saved-result";
  saved.setAttribute("aria-label", "Saved writing record");
  const url = session.uploaded_response!.url;
  saved.innerHTML = `<h2>Record saved</h2><label class="sign-label-row">Complete record link<input type="url" readonly value="${escapeHtml(url)}" /></label><p class="note">${session.signed_text_binding ? "Includes a wording commitment. Readers can check candidate wording against it." : "Process-only record. No wording commitment is included."}</p>`;
  const actions = document.createElement("div");
  actions.className = "session-actions";
  const open = document.createElement("a");
  open.className = "button secondary";
  open.textContent = "Open record";
  open.href = url;
  open.target = "_blank";
  open.rel = "noopener";
  const copyStatus = document.createElement("p");
  copyStatus.className = "note";
  copyStatus.setAttribute("role", "status");
  copyStatus.textContent = copyNotices.get(session.session_id) ?? "";
  const copy = button("Copy link", () => {
    copy.disabled = true;
    void copyRecordLink(url, navigator.clipboard).then(message => { copyStatus.textContent = message; copyNotices.set(session.session_id, message); }).finally(() => { copy.disabled = false; });
  }, true);
  actions.append(open, copy);
  saved.append(actions, copyStatus);
  return saved;
}
function closeReview(): void {
  REVIEW.replaceChildren();
  reviewing = false;
  render();
}
function openReview(session: SessionRecord): void {
  if (guard.busy || reviewing) return;
  selectedId = session.session_id;
  reviewing = true;
  const context = session.capture_context;
  const url = context.browser?.url ?? "";
  const title = context.browser?.title ?? "";
  const label = context.label ?? "";
  const panel = document.createElement("section");
  panel.className = "sign-confirm";
  panel.innerHTML = `<h2 tabindex="-1">Finish this writing record</h2>
    <p><strong>${escapeHtml(fieldLabel(session))}</strong><br><span class="sign-context-value">${escapeHtml(session.origin.origin + session.origin.path)}</span></p>
    <p class="sign-note">Confirming stops capture and publishes the record. Further edits will not be included. Review the context that will be public:</p>
    <label><input type="checkbox" class="sign-keep-url" ${url ? "checked" : "disabled"} /> Page URL: <span class="sign-context-value">${escapeHtml(url || "none")}</span></label>
    <label><input type="checkbox" class="sign-keep-title" ${title ? "checked" : "disabled"} /> Page title: <span class="sign-context-value">${escapeHtml(title || "none")}</span></label>
    <label class="sign-label-row">Public label<input type="text" class="sign-label" value="${escapeHtml(label)}" maxlength="120" /></label>
    <label><input type="checkbox" class="sign-bind" checked /> Include a wording commitment for the selection in this editor, or the whole editor if nothing is selected.</label>
    <p class="sign-note">The check compares letters and digits, not exact text. No document text is sent. Anyone can test wording guesses against a public commitment; it is not encryption or proof of authorship.</p>
    <p class="binding-error notice error" role="alert" hidden></p>
    <div class="session-actions"><button class="sign-confirm-go">Confirm &amp; publish</button><button class="process-only secondary" hidden>Publish process only</button><button class="sign-confirm-cancel secondary">Cancel</button></div>`;
  REVIEW.replaceChildren(panel);
  render();
  panel.querySelector<HTMLHeadingElement>("h2")!.focus();
  const bind = panel.querySelector<HTMLInputElement>(".sign-bind")!;
  const go = panel.querySelector<HTMLButtonElement>(".sign-confirm-go")!;
  const process = panel.querySelector<HTMLButtonElement>(".process-only")!;
  const error = panel.querySelector<HTMLElement>(".binding-error")!;
  let frozen = false;
  let frozenRedactions: CaptureContextRedactions | undefined;
  function redactions(): CaptureContextRedactions {
    if (frozenRedactions) return frozenRedactions;
    const result: CaptureContextRedactions = {};
    if (url && !panel.querySelector<HTMLInputElement>(".sign-keep-url")!.checked) result.drop_url = true;
    if (title && !panel.querySelector<HTMLInputElement>(".sign-keep-title")!.checked) result.drop_title = true;
    const nextLabel = panel.querySelector<HTMLInputElement>(".sign-label")!.value.trim();
    if (nextLabel !== label) result.replace_label = nextLabel;
    return result;
  }
  async function finish(withBinding: boolean): Promise<void> {
    await operation(async () => {
      frozenRedactions = redactions();
      panel.querySelectorAll("input").forEach(input => { input.disabled = true; });
      frozen = true;
      notify("Finishing the chosen editor and saving its writing record…");
      const outcome = await finishRecord(send, session.session_id, withBinding, frozenRedactions);
      if (outcome.kind === "binding_unavailable") {
        error.textContent = `No record was published. ${outcome.reason} Capture has stopped and this finished snapshot cannot be recomputed after later edits. Cancel, or explicitly publish only the editing process.`;
        error.hidden = false;
        go.hidden = true;
        process.hidden = false;
        notify("");
        return;
      }
      await reportOutcome(outcome.response);
    });
  }
  go.addEventListener("click", () => void finish(bind.checked));
  process.addEventListener("click", () => void finish(false));
  panel.querySelector(".sign-confirm-cancel")!.addEventListener("click", () => {
    if (guard.busy) return;
    closeReview();
    if (frozen) notify("Publishing cancelled. Capture remains stopped; later edits are not included in this draft.");
    void refresh();
  });
}
async function reportOutcome(response: BackgroundResponse): Promise<void> {
  const result = response.kind === "sign_session_result" || response.kind === "retry_result" ? response.result : undefined;
  if (result?.kind === "uploaded") {
    closeReview();
    notify(`Record saved. Use Open record or Copy link below.${result.observation_note ? ` ${result.observation_note}` : ""}`);
  } else {
    closeReview();
    const reason = result?.kind === "failed" ? result.reason : response.kind === "error" ? response.reason : "The extension did not return a saved record.";
    notify(`Record was not saved. ${reason}`, true);
  }
  await refresh();
}
async function refresh(): Promise<void> {
  const response = await send({ kind: "list_sessions" });
  if (response.kind !== "list_sessions_result") {
    notify(response.kind === "error" ? response.reason : "Could not load local drafts. Reopen the panel to try again.", true);
    return;
  }
  if (response.last_start_error && response.last_start_error !== lastStartError) notify(response.last_start_error, true);
  lastStartError = response.last_start_error;
  const changed = JSON.stringify(sessions) !== JSON.stringify(response.sessions) || JSON.stringify(captureStatus) !== JSON.stringify(response.capture_status ?? {});
  sessions = response.sessions;
  captureStatus = response.capture_status ?? {};
  // An explicit context-menu/shortcut start selects its new draft. Ordinary
  // tab changes do not alter worker selection. Keep a confirmation pinned and
  // preserve manual panel selection when the worker's selection is unchanged.
  const previousSelectedId = selectedId;
  if (!reviewing && !guard.busy && response.selected_session_id !== lastWorkerSelectedId) {
    if (response.selected_session_id && sessions.some(s => s.session_id === response.selected_session_id)) selectedId = response.selected_session_id;
    lastWorkerSelectedId = response.selected_session_id;
  }
  if (!selectedId || !sessions.some(s => s.session_id === selectedId)) selectedId = response.selected_session_id ?? sessions[0]?.session_id;
  if (changed || previousSelectedId !== selectedId || !APP.childElementCount) renderPending = true;
  // Read new explicit selections even when an old control retains focus. Only
  // ordinary background refreshes wait, preserving URL selection/keyboard focus.
  const sessionControlHasFocus = document.hasFocus() && APP.contains(document.activeElement);
  if (renderPending && (!sessionControlHasFocus || previousSelectedId !== selectedId)) render();
}
START.addEventListener("click", () => void operation(async () => {
  const response = await send({ kind: "start_focused_editor", ...(SHARE.checked && selectedId ? { share_session_id: selectedId } : {}) });
  if (response.kind === "start_editor_result" && response.session_id) {
    selectedId = response.session_id;
    notify("Writing record started in the chosen editor. Return there to write, then finish here.");
    SHARE.checked = false;
  } else {
    notify(response.kind === "error" || response.kind === "start_editor_result" ? response.reason ?? "Choose an empty editor first." : "Could not start. Right-click the chosen editor and use Start writing record.", true);
  }
  await refresh();
}));
void refresh().catch(error => notify(`Could not load local drafts. ${String(error)}`, true));
// Poll only outside an operation/review; refresh never moves selection or
// replaces a partially completed confirmation or persistent error message.
setInterval(() => { if (!guard.busy && !reviewing && document.visibilityState === "visible") void refresh().catch(() => {}); }, 2000);
