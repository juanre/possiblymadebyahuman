import type { CaptureContextRedactions } from "../../../../packages/producer-core/src/index.ts";
import type { BackgroundResponse, ContentToBackground, CurrentEditor, FinishScopePreview, SessionSummary } from "../lib/messages.ts";
import { copyRecordLink, finishRecord, OperationGuard } from "./finish.ts";

declare const chrome: {
  runtime: { sendMessage(message: ContentToBackground): Promise<BackgroundResponse> };
  windows: { getCurrent(): Promise<{ id?: number }> };
};
const APP = document.getElementById("app")!;
const CURRENT = document.getElementById("current")!;
const DRAFTS = document.getElementById("drafts")!;
const LATEST = document.getElementById("latest")!;
const REVIEW = document.getElementById("review")!;
const NOTICE = document.getElementById("toast")!;
const START = document.getElementById("start") as HTMLButtonElement;
const SHARE = document.getElementById("share") as HTMLInputElement;
const HISTORY = document.getElementById("saved-history") as HTMLDetailsElement;
const HISTORY_ROWS = document.getElementById("history-rows")!;
const SEARCH = document.getElementById("history-search") as HTMLInputElement;
const PREVIOUS = document.getElementById("history-previous") as HTMLButtonElement;
const NEXT = document.getElementById("history-next") as HTMLButtonElement;
const guard = new OperationGuard();
const PAGE_SIZE = 20;
let windowId: number;
let drafts: SessionSummary[] = [];
let saved: SessionSummary[] = [];
let savedCount = 0;
let matchingCount = 0;
let historyOffset = 0;
let selectedId: string | undefined;
let currentEditor: CurrentEditor = { state: "none" };
let currentKey = "";
let reviewing = false;
let renamingId: string | undefined;
let latest: SessionSummary | undefined;
let latestContext: string | undefined;
let lastStartError: string | undefined;
let refreshing = false;
let rerenderPending = false;
let retainedFocus: { sessionId: string; label: string } | undefined;
const expandedHistory = new Set<string>();
const copyNotices = new Map<string, string>();
const send = (message: ContentToBackground) => chrome.runtime.sendMessage(message);

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}
function isActive(session: SessionSummary): boolean { return session.state === "active" && session.capture_status === "active"; }
function stateLabel(session: SessionSummary): string {
  if (session.state === "uploaded") return "Saved";
  if (session.state === "failed_upload") return "Upload needs retry";
  if (session.state === "signing" || session.state === "uploading") return "Saving…";
  return isActive(session) ? "Active draft" : "Stopped draft";
}
function notify(message: string, error = false): void {
  NOTICE.textContent = message;
  NOTICE.className = `notice${error ? " error" : ""}`;
  NOTICE.hidden = !message;
}
function button(label: string, action: () => void, secondary = false): HTMLButtonElement {
  const element = document.createElement("button");
  element.textContent = label;
  if (secondary) element.className = "secondary";
  element.addEventListener("click", action);
  return element;
}
function updateAvailability(): void {
  START.disabled = guard.busy || reviewing || !!renamingId || windowId === undefined;
  const shareAvailable = drafts.some(s => s.session_id === selectedId && isActive(s)) && currentEditor.state !== "tracked";
  document.getElementById("share-option")!.hidden = !shareAvailable;
  if (!shareAvailable) SHARE.checked = false;
  PREVIOUS.disabled = guard.busy || reviewing || historyOffset === 0;
  NEXT.disabled = guard.busy || reviewing || historyOffset + PAGE_SIZE >= matchingCount;
  (document.getElementById("export-history") as HTMLButtonElement).disabled = guard.busy || !savedCount;
  (document.getElementById("clear-history") as HTMLButtonElement).disabled = guard.busy || reviewing || !savedCount;
}
async function operation(action: () => Promise<void>): Promise<void> {
  await guard.run(async () => {
    const buttons = [...document.querySelectorAll<HTMLButtonElement>("button")];
    const disabled = buttons.map(element => element.disabled);
    buttons.forEach(element => { element.disabled = true; });
    APP.setAttribute("aria-busy", "true");
    try { await action(); }
    catch (error) { notify(`Could not complete that action. ${error instanceof Error ? error.message : "Try again."}`, true); }
    finally {
      buttons.forEach((element, i) => { if (element.isConnected) element.disabled = disabled[i]; });
      APP.removeAttribute("aria-busy");
    }
  });
  if (!guard.busy) render();
}
function preserveInteraction(): boolean {
  const element = document.activeElement;
  return !!renamingId || (document.hasFocus() && element instanceof HTMLInputElement && APP.contains(element));
}
function render(): void {
  if (preserveInteraction()) { rerenderPending = true; updateAvailability(); return; }
  rerenderPending = false;
  const focused = document.hasFocus() ? document.activeElement : null;
  const focusedRow = focused?.closest<HTMLElement>("[data-session-id]");
  retainedFocus = focusedRow && focused instanceof HTMLButtonElement ? { sessionId: focusedRow.dataset.sessionId!, label: focused.textContent ?? "" } : undefined;
  const current = currentEditor.state === "tracked" ? drafts.find(s => s.session_id === currentEditor.session_id) : undefined;
  CURRENT.replaceChildren();
  const heading = document.createElement("h2");
  heading.textContent = "This editor";
  CURRENT.append(heading);
  if (current) CURRENT.append(renderDraft(current, true));
  else {
    const empty = document.createElement("p");
    empty.className = "note";
    empty.textContent = currentEditor.state === "unavailable" ? "This page is unavailable to the extension. Choose an editor in another tab."
      : currentEditor.state === "untracked" ? "No writing record is active for this field. Start one explicitly, or choose a stopped draft below to resume."
      : currentEditor.state === "tracked" ? "This editor has no active draft. To keep writing, choose Continue in chosen field in the saved record’s details."
      : "Click in an editor to see its writing record. Opening this panel does not start capture.";
    CURRENT.append(empty);
  }
  DRAFTS.replaceChildren();
  const others = drafts.filter(s => s.session_id !== current?.session_id);
  if (others.length) {
    const title = document.createElement("h2"); title.textContent = `Other drafts (${others.length})`; DRAFTS.append(title);
    for (const draft of others) DRAFTS.append(renderDraft(draft, false));
  }
  LATEST.replaceChildren();
  if (latest) {
    LATEST.append(savedResult(latest));
    LATEST.append(button("Done", () => { latest = undefined; render(); }, true));
  }
  document.getElementById("history-title")!.textContent = `Saved records (${savedCount})`;
  renderHistory();
  updateAvailability();
  if (retainedFocus) {
    const row = [...APP.querySelectorAll<HTMLElement>("[data-session-id]")].find(element => element.dataset.sessionId === retainedFocus!.sessionId);
    [...row?.querySelectorAll<HTMLButtonElement>("button") ?? []].find(element => element.textContent === retainedFocus!.label)?.focus({ preventScroll: true });
  }
}
function renderDraft(session: SessionSummary, current: boolean): HTMLElement {
  const selected = current || (!currentEditor.session_id && selectedId === session.session_id);
  const expanded = current || selectedId === session.session_id || retainedFocus?.sessionId === session.session_id || session.state === "failed_upload";
  const wrap = document.createElement("article");
  wrap.className = `session${selected ? " selected" : ""}${current ? " current" : ""}`;
  wrap.dataset.sessionId = session.session_id;
  if (current) wrap.setAttribute("aria-current", "true");
  const heading = document.createElement("div"); heading.className = "session-head";
  heading.innerHTML = `<span class="session-title">${escapeHtml(session.display_name)}</span><span class="session-state">${stateLabel(session)}</span>`;
  wrap.append(heading);
  const meta = document.createElement("p"); meta.className = "session-meta";
  meta.textContent = `${session.event_count} editing ${session.event_count === 1 ? "event" : "events"}`;
  wrap.append(meta);
  const actions = document.createElement("div"); actions.className = "session-actions";
  if (!expanded) actions.append(button("Choose draft", () => { if (!reviewing && !guard.busy) { selectedId = session.session_id; latest = undefined; render(); } }, true));
  else {
    if (session.state === "active") {
      const finish = button("Finish & get link", () => void openReview(session)); finish.disabled = !session.event_count; actions.append(finish);
      if (isActive(session)) actions.append(button("Stop", () => void operation(async () => {
        const response = await send({ kind: "stop_session", session_id: session.session_id });
        if (response.kind === "error") notify(response.reason, true);
        else notify("Capture stopped. Resume this draft later in its field; its original timeline is kept.");
        await refresh();
      }), true));
      else actions.append(button("Resume in chosen field", () => void activate({ resume_session_id: session.session_id }), true));
    } else if (session.state === "failed_upload") actions.append(button("Retry upload", () => void operation(async () => {
      notify("Retrying the same saved editing activity…");
      await reportOutcome(await send({ kind: "retry_failed_upload", session_id: session.session_id }), session);
    })));
    if (!["signing", "uploading"].includes(session.state)) {
      actions.append(button("Rename", () => rename(session, wrap), true));
      actions.append(button("Discard draft", () => {
        if (!window.confirm(`Discard “${session.display_name}”? Capture will stop and its local editing history cannot be recovered.`)) return;
        void operation(async () => { const result = await send({ kind: "discard_session", session_id: session.session_id }); if (result.kind === "error") notify(result.reason, true); else notify("Draft discarded."); await refresh(); });
      }, true));
    }
  }
  wrap.append(actions);
  if (session.state === "failed_upload") {
    const failure = document.createElement("p"); failure.className = "notice error";
    failure.textContent = `${session.last_failure_reason ?? "The server could not be reached."} Retry preserves the same record.`; wrap.append(failure);
  }
  if (expanded) {
    const details = document.createElement("details"); details.innerHTML = `<summary>Draft details</summary><p class="note">${escapeHtml(session.origin.origin + session.origin.path)}</p>${session.parent_record ? '<p class="note">Continues an earlier saved record. The earlier link stays unchanged.</p>' : ""}${session.format_version === "0.1" ? '<p class="note">This older draft’s timing ends at its last captured edit.</p>' : ""}`; wrap.append(details);
  }
  if (reviewing || guard.busy || renamingId) wrap.querySelectorAll("button").forEach(element => { element.disabled = true; });
  return wrap;
}
function rename(session: SessionSummary, container: HTMLElement): void {
  if (guard.busy || reviewing || renamingId) return;
  renamingId = session.session_id;
  updateAvailability();
  const form = document.createElement("form"); form.className = "rename-form";
  form.innerHTML = `<label class="sign-label-row">Private name<input type="text" maxlength="160" value="${escapeHtml(session.display_name)}" required /></label><p class="note">Only this browser uses this name. It will not become the public label.</p><p class="rename-error notice error" role="alert" hidden></p>`;
  const input = form.querySelector("input")!;
  const actions = document.createElement("div"); actions.className = "session-actions";
  const save = button("Save name", () => {}); save.type = "submit";
  const cancel = button("Cancel rename", () => { form.remove(); renamingId = undefined; render(); }, true); cancel.type = "button";
  actions.append(save, cancel); form.append(actions); container.append(form);
  form.addEventListener("submit", event => {
    event.preventDefault(); if (!input.value.trim()) return;
    void operation(async () => {
      const response = await send({ kind: "rename_session", session_id: session.session_id, name: input.value.trim() });
      if (response.kind === "error") { const error = form.querySelector<HTMLElement>(".rename-error")!; error.hidden = false; error.textContent = response.reason; return; }
      renamingId = undefined;
      form.remove();
      if (latest?.session_id === session.session_id) latest = { ...latest, display_name: input.value.trim() };
      await refresh();
    });
  });
  input.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); form.remove(); renamingId = undefined; render(); } });
  input.focus(); input.select();
}
function savedResult(session: SessionSummary): HTMLElement {
  const section = document.createElement("section"); section.className = "saved-result"; section.setAttribute("aria-label", "Saved writing record");
  section.innerHTML = `<h2>Record saved</h2><p><strong>${escapeHtml(session.display_name)}</strong></p><label class="sign-label-row">Complete record link<input type="url" readonly value="${escapeHtml(session.uploaded_response!.url)}" /></label><p class="note">${session.signed_text_binding ? "Text check included." : "Editing activity saved. No text check included."}</p>`;
  section.append(linkActions(session));
  return section;
}
function linkActions(session: SessionSummary): HTMLElement {
  const group = document.createElement("div");
  const actions = document.createElement("div"); actions.className = "session-actions";
  const url = session.uploaded_response!.url;
  const open = document.createElement("a"); open.className = "button secondary"; open.textContent = "Open record"; open.href = url; open.target = "_blank"; open.rel = "noopener";
  const status = document.createElement("p"); status.className = "note"; status.setAttribute("role", "status"); status.textContent = copyNotices.get(session.session_id) ?? "";
  const copy = button("Copy link", () => {
    copy.disabled = true;
    void copyRecordLink(url, navigator.clipboard).then(message => { status.textContent = message; copyNotices.set(session.session_id, message); }).finally(() => { copy.disabled = false; });
  }, true);
  actions.append(open, copy); group.append(actions, status); return group;
}
function renderHistory(): void {
  HISTORY_ROWS.replaceChildren();
  if (!HISTORY.open) return;
  const status = document.getElementById("history-page")!;
  status.textContent = matchingCount ? `${historyOffset + 1}–${Math.min(historyOffset + PAGE_SIZE, matchingCount)} of ${matchingCount}` : "No saved records match.";
  for (const session of saved) {
    const row = document.createElement("article"); row.className = "saved-row"; row.dataset.sessionId = session.session_id;
    const time = new Date(session.last_edit_wall_ms);
    row.innerHTML = `<div class="session-head"><span class="session-title">${escapeHtml(session.display_name)}</span><time>${Number.isFinite(time.getTime()) ? time.toLocaleDateString() : ""}</time></div>`;
    row.append(linkActions(session));
    const details = document.createElement("details"); details.open = expandedHistory.has(session.session_id);
    details.innerHTML = `<summary>Details</summary><p class="note">${escapeHtml(session.origin.origin)}</p><label class="sign-label-row">Complete record link<input type="url" readonly value="${escapeHtml(session.uploaded_response!.url)}" /></label><p class="note">${session.signed_text_binding ? "Text check included." : "No text check included."}</p>`;
    details.addEventListener("toggle", () => { if (details.open) expandedHistory.add(session.session_id); else expandedHistory.delete(session.session_id); });
    const actions = document.createElement("div"); actions.className = "session-actions";
    actions.append(button("Continue in chosen field", () => void activate({ continue_session_id: session.session_id }), true));
    actions.append(button("Rename", () => rename(session, details), true));
    actions.append(button("Remove saved link", () => {
      if (!window.confirm(`Remove the saved link for “${session.display_name}” from this browser? The public record stays available.`)) return;
      void operation(async () => { const result = await send({ kind: "remove_saved", session_id: session.session_id }); if (result.kind === "error") notify(result.reason, true); else { if (latest?.session_id === session.session_id) latest = undefined; notify("Saved link removed from this browser. The public record remains available."); } await refresh(); });
    }, true));
    details.append(actions); row.append(details); HISTORY_ROWS.append(row);
  }
  if (reviewing || guard.busy || renamingId) HISTORY_ROWS.querySelectorAll("button").forEach(element => { element.disabled = true; });
}
function closeReview(): void { REVIEW.replaceChildren(); reviewing = false; render(); }
async function openReview(session: SessionSummary): Promise<void> {
  if (guard.busy || reviewing || renamingId) return;
  reviewing = true;
  const context = session.capture_context;
  const url = context.browser?.url ?? ""; const title = context.browser?.title ?? ""; const label = context.label ?? "";
  const panel = document.createElement("section"); panel.className = "sign-confirm";
  panel.innerHTML = `<h2 tabindex="-1">Finish this writing record</h2><p><strong>${escapeHtml(session.display_name)}</strong></p>
    <p class="sign-note">Confirming stops capture and publishes this draft. Further edits will not be included.</p>
    <p>Text hash: <span class="binding-scope">Checking text scope…</span></p><p class="sign-note">Your text is not uploaded.</p>
    <details class="public-context" open><summary>Public context</summary><p class="note">Review the details published with this record. Your private name stays in this browser.</p>
    <label><input type="checkbox" class="sign-keep-url" ${url ? "checked" : "disabled"} /> Page URL: <span class="sign-context-value">${escapeHtml(url || "none")}</span></label>
    <label><input type="checkbox" class="sign-keep-title" ${title ? "checked" : "disabled"} /> Page title: <span class="sign-context-value">${escapeHtml(title || "none")}</span></label>
    <label class="sign-label-row">Public label<input type="text" class="sign-label" value="${escapeHtml(label)}" maxlength="120" /></label></details>
    <p class="binding-error notice error" role="alert" hidden></p><div class="session-actions"><button class="sign-confirm-go" disabled>Confirm &amp; publish</button><button class="process-only secondary" hidden>Publish editing activity only</button><button class="sign-confirm-cancel secondary">Cancel</button></div>`;
  REVIEW.replaceChildren(panel); render(); panel.querySelector<HTMLHeadingElement>("h2")!.focus();
  const go = panel.querySelector<HTMLButtonElement>(".sign-confirm-go")!;
  const processOnly = panel.querySelector<HTMLButtonElement>(".process-only")!;
  const error = panel.querySelector<HTMLElement>(".binding-error")!;
  const scopeLabel = panel.querySelector<HTMLElement>(".binding-scope")!;
  let scope: FinishScopePreview = { scope: "unavailable" };
  let frozen = false;
  let frozenRedactions: CaptureContextRedactions | undefined;
  function setScope(preview: FinishScopePreview): void {
    scope = preview;
    scopeLabel.textContent = preview.scope === "selection" ? "Selected text" : preview.scope === "whole_field" ? "Whole field" : "Text check unavailable for this editor.";
    if (preview.scope === "unavailable") {
      scopeLabel.textContent += ` ${preview.reason ?? "Readers can inspect the editing activity, but cannot compare a copy of the text."}`;
    }
    go.hidden = preview.scope === "unavailable";
    processOnly.hidden = preview.scope !== "unavailable";
    go.disabled = false;
  }
  function redactions(): CaptureContextRedactions {
    if (frozenRedactions) return frozenRedactions;
    const result: CaptureContextRedactions = {};
    if (url && !panel.querySelector<HTMLInputElement>(".sign-keep-url")!.checked) result.drop_url = true;
    if (title && !panel.querySelector<HTMLInputElement>(".sign-keep-title")!.checked) result.drop_title = true;
    const next = panel.querySelector<HTMLInputElement>(".sign-label")!.value.trim(); if (next !== label) result.replace_label = next;
    return result;
  }
  async function finish(withBinding: boolean): Promise<void> {
    await operation(async () => {
      const requestedRedactions = redactions();
      panel.querySelectorAll("input").forEach(input => { input.disabled = true; });
      notify("Saving this writing record…");
      const outcome = await finishRecord(send, session.session_id, withBinding, requestedRedactions, scope.scope_token);
      if (outcome.kind === "scope_changed") {
        panel.querySelectorAll<HTMLInputElement>("input").forEach(input => { input.disabled = false; });
        setScope(outcome.preview);
        if (outcome.preview.scope === "unavailable") { go.hidden = true; processOnly.hidden = false; }
        error.textContent = outcome.preview.scope === "unavailable"
          ? "The editor changed and a text check is no longer available. Nothing was published. Cancel, or explicitly publish the editing activity."
          : "The text selection changed. Review the updated scope above, then confirm again. Nothing was published.";
        error.hidden = false; notify(""); return;
      }
      frozen = true; frozenRedactions = requestedRedactions;
      if (outcome.kind === "binding_unavailable") {
        error.textContent = `No record was published. ${outcome.reason} Capture has stopped. Cancel to return to the draft, or publish its editing activity without a text check.`;
        error.hidden = false; go.hidden = true; processOnly.hidden = false; notify(""); return;
      }
      await reportOutcome(outcome.response, session);
    });
  }
  go.addEventListener("click", () => void finish(true));
  processOnly.addEventListener("click", () => void finish(false));
  panel.querySelector(".sign-confirm-cancel")!.addEventListener("click", () => {
    if (guard.busy) return;
    closeReview(); if (frozen) notify("Publishing cancelled. Capture remains stopped; resume the draft to include later edits."); void refresh();
  });
  try {
    const preview = await send({ kind: "inspect_finish", session_id: session.session_id });
    if (!panel.isConnected) return;
    if (preview.kind === "finish_scope_result") setScope(preview);
    else { error.textContent = preview.kind === "error" ? preview.reason : "Could not inspect this editor. Cancel and try again."; error.hidden = false; }
  } catch { if (panel.isConnected) { error.textContent = "Could not inspect this editor. Cancel and try again."; error.hidden = false; } }
}
async function reportOutcome(response: BackgroundResponse, session: SessionSummary): Promise<void> {
  const result = response.kind === "sign_session_result" || response.kind === "retry_result" ? response.result : undefined;
  if (result?.kind === "uploaded") {
    latest = { ...session, state: "uploaded", uploaded_response: result.response, signed_text_binding: result.text_binding };
    latestContext = undefined;
    closeReview(); notify(`Record saved. Open it or copy its link below.${result.observation_note ? ` ${result.observation_note}` : ""}`);
  } else {
    closeReview(); const reason = result?.kind === "failed" ? result.reason : response.kind === "error" ? response.reason : "The extension did not return a saved record.";
    notify(`Record was not saved. ${reason}`, true);
  }
  await refresh();
}
async function activate(options: { resume_session_id?: string; continue_session_id?: string; share_session_id?: string } = {}): Promise<void> {
  await operation(async () => {
    const response = await send({ kind: "start_focused_editor", window_id: windowId, ...options });
    if (response.kind === "start_editor_result" && response.session_id) {
      selectedId = response.session_id; latest = undefined; SHARE.checked = false;
      notify(options.resume_session_id ? "Draft resumed in the chosen field. The original timeline is kept; edits made while capture was stopped are unknown."
        : options.continue_session_id ? "A new draft continues this saved record. Its earlier link stays unchanged."
        : "Writing record started. Edits from now on will be included. Return to the field to write, then finish here.");
    } else notify(response.kind === "error" || response.kind === "start_editor_result" ? response.reason ?? "Choose an editor first." : "Could not start this editor.", true);
    await refresh();
  });
}
async function refresh(): Promise<void> {
  if (refreshing || windowId === undefined) return;
  refreshing = true;
  try {
    const query = SEARCH.value.trim(), offset = historyOffset;
    const response = await send({ kind: "list_panel_sessions", window_id: windowId, history_query: query, history_offset: offset, history_limit: PAGE_SIZE });
    if (query !== SEARCH.value.trim() || offset !== historyOffset) return;
    if (response.kind !== "panel_sessions_result") { notify(response.kind === "error" ? response.reason : "Could not load your writing records.", true); return; }
    if (response.last_start_error && response.last_start_error !== lastStartError) notify(response.last_start_error, true);
    lastStartError = response.last_start_error;
    const key = `${response.current_editor.state}:${response.current_editor.session_id ?? ""}`;
    const moved = key !== currentKey;
    if (moved && !reviewing && !renamingId) {
      if (response.current_editor.state === "tracked") selectedId = response.current_editor.session_id;
      if (latest && latestContext !== undefined && latestContext !== key) latest = undefined;
    }
    if (latestContext === undefined && latest) latestContext = key;
    const changed = JSON.stringify([drafts, saved, savedCount, matchingCount, currentEditor]) !== JSON.stringify([response.drafts, response.saved, response.saved_count, response.matching_saved_count, response.current_editor]);
    drafts = response.drafts; saved = response.saved; savedCount = response.saved_count; matchingCount = response.matching_saved_count; historyOffset = response.history_offset;
    currentEditor = response.current_editor; currentKey = key;
    if (latest) latest = saved.find(s => s.session_id === latest?.session_id) ?? latest;
    if (!selectedId && drafts.length) selectedId = drafts[0]!.session_id;
    if (changed || !CURRENT.childElementCount) render();
    if (moved && !reviewing && !preserveInteraction() && !document.hasFocus()) CURRENT.scrollIntoView({ block: "nearest" });
  } finally { refreshing = false; }
}
START.addEventListener("click", () => void activate(SHARE.checked && selectedId ? { share_session_id: selectedId } : {}));
HISTORY.addEventListener("toggle", () => { if (HISTORY.open) { renderHistory(); updateAvailability(); } else HISTORY_ROWS.replaceChildren(); });
let searchTimer: ReturnType<typeof setTimeout>;
SEARCH.addEventListener("input", () => { historyOffset = 0; clearTimeout(searchTimer); searchTimer = setTimeout(() => { void refresh().then(() => { renderHistory(); updateAvailability(); }); }, 150); });
PREVIOUS.addEventListener("click", () => { historyOffset = Math.max(0, historyOffset - PAGE_SIZE); void refresh().then(() => { renderHistory(); updateAvailability(); }); });
NEXT.addEventListener("click", () => { historyOffset += PAGE_SIZE; void refresh().then(() => { renderHistory(); updateAvailability(); }); });
document.getElementById("export-history")!.addEventListener("click", () => void operation(async () => {
  const result = await send({ kind: "export_saved" });
  if (result.kind !== "export_saved_result") { notify(result.kind === "error" ? result.reason : "Could not export saved links.", true); return; }
  const url = URL.createObjectURL(new Blob([JSON.stringify(result.links, null, 2)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = `pmbah-saved-links-${new Date().toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  notify(`Exported ${result.links.length} saved links. Your local history is unchanged.`);
}));
document.getElementById("clear-history")!.addEventListener("click", () => {
  if (!window.confirm(`Remove all ${savedCount} saved links from this browser? Public records and unfinished drafts stay available. Export your links first if you need a backup.`)) return;
  void operation(async () => { const result = await send({ kind: "clear_saved" }); if (result.kind === "error") notify(result.reason, true); else { latest = undefined; historyOffset = 0; notify("Saved links removed from this browser. Public records and unfinished drafts were kept."); } await refresh(); });
});
APP.addEventListener("focusout", () => { if (rerenderPending) setTimeout(() => { if (!preserveInteraction()) render(); }, 0); });
void chrome.windows.getCurrent().then(async current => {
  if (current.id === undefined) throw new Error("Could not identify this browser window.");
  windowId = current.id; await refresh();
}).catch(error => notify(`Could not load your writing records. ${String(error)}`, true));
setInterval(() => { if (!guard.busy && !reviewing && document.visibilityState === "visible") void refresh().catch(() => {}); }, 500);
