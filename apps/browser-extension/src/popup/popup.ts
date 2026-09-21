import type { CaptureContextRedactions, SessionRecord } from "../../../../packages/producer-core/src/index.ts";
import type { TextBinding } from "../../../../packages/format/src/index.ts";
import type { BackgroundResponse, ComputeBindingRequest, ComputeBindingResponse, ContentToBackground } from "../lib/messages.ts";

declare const chrome: {
  runtime: { sendMessage(message: ContentToBackground): Promise<BackgroundResponse> };
  tabs: { sendMessage(tabId: number, message: ComputeBindingRequest): Promise<unknown> };
};

const APP = document.getElementById("app")!;
const TOAST = document.getElementById("toast")!;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "\"": return "&quot;";
      case "'": return "&#39;";
      default: return ch;
    }
  });
}

function groupByOrigin(sessions: SessionRecord[]): Record<string, SessionRecord[]> {
  const groups: Record<string, SessionRecord[]> = {};
  for (const session of sessions) {
    const key = session.origin.origin;
    if (!groups[key]) groups[key] = [];
    groups[key].push(session);
  }
  return groups;
}

function fieldLabel(session: SessionRecord): string {
  return (
    session.descriptor.aria_label
    ?? session.descriptor.name
    ?? session.descriptor.id
    ?? session.descriptor.field_kind
  );
}

function summary(session: SessionRecord): string {
  const events = session.events.length;
  const observation = session.observation;
  const obsPiece = observation.state === "disabled"
    ? ""
    : observation.last_committed_event_count > 0
    ? ` · ${observation.last_committed_event_count}/${events} committed`
    : ` · ${observation.state}`;
  return `${events} event${events === 1 ? "" : "s"}${obsPiece}`;
}

function render(sessions: SessionRecord[]): void {
  APP.innerHTML = "";
  if (sessions.length === 0) {
    APP.innerHTML = `<p class="empty">No sessions yet. Focus a textarea or plain text input on any page to start recording.</p>`;
    return;
  }
  const groups = groupByOrigin(sessions);
  for (const origin of Object.keys(groups).sort()) {
    const heading = document.createElement("p");
    heading.className = "group-origin";
    heading.textContent = origin;
    APP.appendChild(heading);
    for (const session of groups[origin]) {
      APP.appendChild(renderSession(session));
    }
  }
}

function renderSession(session: SessionRecord): HTMLElement {
  const wrap = document.createElement("article");
  wrap.className = "session";
  const head = document.createElement("div");
  head.className = "session-head";
  head.innerHTML = `<span class="session-title">${escapeHtml(fieldLabel(session))}</span><span class="session-state ${session.state}">${session.state}</span>`;
  wrap.appendChild(head);

  const meta = document.createElement("div");
  meta.className = "session-meta";
  meta.textContent = `${session.origin.path} · ${summary(session)}`;
  wrap.appendChild(meta);
  if (session.parent_record) {
    const parent = document.createElement("p");
    parent.className = "session-meta";
    parent.textContent = "continues a record you already signed in this field";
    wrap.appendChild(parent);
  }

  const actions = document.createElement("div");
  actions.className = "session-actions";
  const canSign = session.state === "active" && session.events.length > 0;
  const signBtn = document.createElement("button");
  signBtn.textContent = session.state === "uploaded" ? "uploaded" : session.state === "failed_upload" ? "Retry upload" : "Sign & upload";
  signBtn.disabled = !(canSign || session.state === "failed_upload");
  signBtn.addEventListener("click", () => {
    if (session.state === "failed_upload") void performRetry(session);
    else onSign(session);
  });
  actions.appendChild(signBtn);
  const discardBtn = document.createElement("button");
  discardBtn.className = "secondary";
  discardBtn.textContent = "Discard";
  discardBtn.addEventListener("click", () => void onDiscard(session));
  actions.appendChild(discardBtn);
  wrap.appendChild(actions);

  if (session.uploaded_response) {
    const link = document.createElement("p");
    link.className = "session-meta";
    link.innerHTML = `<a href="${escapeHtml(session.uploaded_response.url)}" target="_blank" rel="noopener">${escapeHtml(session.uploaded_response.short_signature)}</a>`;
    wrap.appendChild(link);
  }
  if (session.state === "failed_upload" && session.last_failure_reason) {
    const fail = document.createElement("p");
    fail.className = "session-meta";
    fail.textContent = `upload failed: ${session.last_failure_reason}. Retry uploads the same signed record; Discard drops it.`;
    wrap.appendChild(fail);
  }
  return wrap;
}

function onSign(session: SessionRecord): void {
  openSignConfirm(session);
}

// Sign confirmation: the signer reviews the capture context that will be
// published (page URL, page title, label) and can drop or rename it, and
// chooses whether to bind the text. The binding is computed in the field's
// content script (the only context with the text); the popup receives only
// the commitment object.
function openSignConfirm(session: SessionRecord): void {
  const context = session.capture_context;
  const url = context.browser?.url ?? "";
  const title = context.browser?.title ?? "";
  const label = context.label ?? "";
  const panel = document.createElement("div");
  panel.className = "sign-confirm";
  panel.innerHTML = `
    <p class="sign-affirm">What the record will say about where this was written</p>
    <label><input type="checkbox" class="sign-keep-url" ${url ? "checked" : "disabled"} /> Page URL: <span class="sign-context-value">${escapeHtml(url || "none")}</span></label>
    <label><input type="checkbox" class="sign-keep-title" ${title ? "checked" : "disabled"} /> Page title: <span class="sign-context-value">${escapeHtml(title || "none")}</span></label>
    <label class="sign-label-row">Label <input type="text" class="sign-label" value="${escapeHtml(label)}" maxlength="120" /></label>
    <label><input type="checkbox" class="sign-bind" checked /> Bind selected text, or all field content if nothing is selected</label>
    <p class="sign-note">The check compares wording — letters and digits — not exact text. No document text is sent to PMBAH. A public binding lets anyone test guesses at the wording; it is not encryption.</p>
    <div class="session-actions">
      <button class="sign-confirm-go">Sign &amp; upload</button>
      <button class="secondary sign-confirm-cancel">Cancel</button>
    </div>`;
  APP.prepend(panel);
  const bindCb = panel.querySelector(".sign-bind") as HTMLInputElement;
  const keepUrl = panel.querySelector(".sign-keep-url") as HTMLInputElement;
  const keepTitle = panel.querySelector(".sign-keep-title") as HTMLInputElement;
  const labelInput = panel.querySelector(".sign-label") as HTMLInputElement;
  (panel.querySelector(".sign-confirm-cancel") as HTMLElement).addEventListener("click", () => void refresh());
  (panel.querySelector(".sign-confirm-go") as HTMLElement).addEventListener("click", () => {
    const redactions: CaptureContextRedactions = {};
    if (url && !keepUrl.checked) redactions.drop_url = true;
    if (title && !keepTitle.checked) redactions.drop_title = true;
    const nextLabel = labelInput.value.trim();
    if (nextLabel !== label) redactions.replace_label = nextLabel;
    void performSign(session, bindCb.checked, redactions);
  });
}

async function requestBinding(session: SessionRecord): Promise<TextBinding | undefined> {
  const tabId = session.origin.tab_id;
  if (typeof tabId !== "number" || tabId < 0) return undefined;
  try {
    const res = (await chrome.tabs.sendMessage(tabId, {
      kind: "compute_binding",
      session_id: session.session_id,
    })) as ComputeBindingResponse | undefined;
    return res && res.kind === "binding_result" && res.text_binding ? res.text_binding : undefined;
  } catch {
    // Content script gone / tab closed — fall back to signing without a binding.
    return undefined;
  }
}

async function performSign(session: SessionRecord, bind: boolean, redactions: CaptureContextRedactions): Promise<void> {
  showToast("uploading…");
  const text_binding = bind ? await requestBinding(session) : undefined;
  if (bind && !text_binding) showToast("couldn't read the field to bind — signing the process only", true);
  const hasRedactions = Object.keys(redactions).length > 0;
  const response = await chrome.runtime.sendMessage({
    kind: "sign_session",
    session_id: session.session_id,
    ...(text_binding ? { text_binding } : {}),
    ...(hasRedactions ? { capture_context_redactions: redactions } : {}),
  });
  await reportUploadOutcome(response, "sign failed");
}

async function performRetry(session: SessionRecord): Promise<void> {
  showToast("retrying upload…");
  const response = await chrome.runtime.sendMessage({ kind: "retry_failed_upload", session_id: session.session_id });
  await reportUploadOutcome(response, "retry failed");
}

async function reportUploadOutcome(response: BackgroundResponse, failurePrefix: string): Promise<void> {
  const result = response.kind === "sign_session_result" || response.kind === "retry_result" ? response.result : null;
  if (result?.kind === "uploaded") {
    let copied = false;
    try {
      await navigator.clipboard.writeText(result.response.url);
      copied = true;
    } catch {
      // clipboard may be denied; the URL stays visible as the popup link.
    }
    const saved = copied ? `record saved · link copied (${result.response.short_signature})` : `record saved · ${result.response.short_signature} (copy the link below)`;
    showToast(result.observation_note ? `${saved} · ${result.observation_note}` : saved);
  } else {
    const reason = result?.kind === "failed" ? result.reason : response.kind === "error" ? response.reason : "unknown";
    showToast(`${failurePrefix}: ${reason}`, true);
  }
  await refresh();
}

async function onDiscard(session: SessionRecord): Promise<void> {
  const response = await chrome.runtime.sendMessage({ kind: "discard_session", session_id: session.session_id });
  if (response.kind === "discard_result") showToast("discarded");
  await refresh();
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function showToast(message: string, isError = false): void {
  TOAST.textContent = message;
  TOAST.hidden = false;
  TOAST.className = `toast${isError ? " error" : ""}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { TOAST.hidden = true; }, isError ? 6000 : 3000);
}

async function refresh(): Promise<void> {
  const response = await chrome.runtime.sendMessage({ kind: "list_sessions" });
  if (response.kind === "list_sessions_result") render(response.sessions);
  else if (response.kind === "error") render([]);
}

void refresh();
