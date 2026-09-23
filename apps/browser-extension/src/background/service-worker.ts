import type { ProducerIdentity } from "../../../../packages/producer-core/src/index.ts";
import type { TextBinding } from "../../../../packages/format/src/index.ts";
import { createChromeStorageAdapter, createCryptoUuidAdapter, createDateClockAdapter, createFetchCheckpointAdapter, createFetchUploadAdapter, type ChromeStorageLocalSlice, type CryptoSlice, type FetchLike } from "../lib/adapters.ts";
import { BackgroundDispatcher } from "../lib/dispatcher.ts";
import { isContentMessage, type ContentToBackground, type BackgroundResponse, type ComputeBindingResponse } from "../lib/messages.ts";
import { API_BASE_URL, EXTENSION_VERSION, RECORDS_ENDPOINT } from "../lib/config.ts";

export const BACKGROUND_ENTRYPOINT = "service-worker";
type Sender = { id?: string; tab?: { id?: number }; frameId?: number; documentId?: string; url?: string };
type Route = { tab: number; frame: number; document?: string; session: string; active: boolean };
type Snapshot = { binding: TextBinding | null; reason?: string };
type Routing = { routes: Route[]; snapshots: Record<string, Snapshot>; shared?: Record<string, boolean>; selected?: string; last_start_error?: string };
declare const chrome: {
  storage: { local: ChromeStorageLocalSlice };
  runtime: { id: string; onMessage: { addListener(listener: (message: unknown, sender: Sender, reply: (response: unknown) => void) => boolean | void): void }; onInstalled: { addListener(listener: () => void): void } };
  tabs: { query(query: object): Promise<Array<{ id?: number }>>; sendMessage(tab: number, message: object, options: { frameId?: number; documentId?: string }): Promise<unknown>; onRemoved: { addListener(listener: (tabId: number) => void): void } };
  webNavigation: { getAllFrames(details: { tabId: number }): Promise<Array<{ frameId: number; documentId?: string }> | null>; onCommitted: { addListener(listener: (details: { tabId: number; frameId: number }) => void): void } };
  contextMenus: { create(options: object): void; removeAll(): Promise<void>; onClicked: { addListener(listener: (info: { menuItemId: string | number; frameId?: number }, tab?: { id?: number }) => void): void } };
  sidePanel: { setPanelBehavior(options: { openPanelOnActionClick: boolean }): Promise<void>; open(options: { tabId: number }): Promise<void> };
  action: { setBadgeText(options: { text: string; tabId?: number }): Promise<void>; setBadgeBackgroundColor(options: { color: string }): Promise<void> };
  commands: { onCommand: { addListener(listener: (command: string, tab?: { id?: number }) => void): void } };
  alarms: { create(name: string, info: { periodInMinutes: number }): void; onAlarm: { addListener(listener: (alarm: { name: string }) => void): void } };
};
const cryptoRef = globalThis.crypto as CryptoSlice;
const fetchRef: FetchLike = (input, init) => fetch(input, init);
const producer: ProducerIdentity = { id: "browser-extension", version: EXTENSION_VERSION, capabilities: ["timing", "source_attribution"] };
const dispatcher = new BackgroundDispatcher({ clock: createDateClockAdapter(), uuid: createCryptoUuidAdapter(cryptoRef), storage: createChromeStorageAdapter(chrome.storage.local), upload: createFetchUploadAdapter({ records_endpoint: RECORDS_ENDPOINT, fetch: fetchRef }), checkpoint: createFetchCheckpointAdapter({ base_url: API_BASE_URL, fetch: fetchRef }), producer });
const ROUTING_KEY = "pmbah:explicit-capture:v1";
let routing: Routing = { routes: [], snapshots: {} };
let routingSerialized = JSON.stringify(routing);
let persistTail = Promise.resolve();
const ready = Promise.all([dispatcher.ensureInitialised(), chrome.storage.local.get([ROUTING_KEY]).then((stored) => { if (stored[ROUTING_KEY]) routing = stored[ROUTING_KEY] as Routing; routingSerialized = JSON.stringify(routing); })]);
const grants = new Map<string, { tab: number; frame: number; document?: string; share?: string; resume?: string }>();
const finishing = new Map<string, Promise<Snapshot>>();
const signing = new Set<string>();
const starting = new Set<string>();
const resuming = new Set<string>();
async function persist(): Promise<void> {
  const snapshot = JSON.stringify(routing);
  persistTail = persistTail.catch(() => {}).then(async () => {
    if (snapshot === routingSerialized) return;
    await chrome.storage.local.set({ [ROUTING_KEY]: JSON.parse(snapshot) });
    routingSerialized = snapshot;
  });
  await persistTail;
}
function target(route: Route): { frameId: number; documentId?: string } { return { frameId: route.frame, ...(route.document ? { documentId: route.document } : {}) }; }
function isOwnUI(sender: Sender): boolean { return sender.id === chrome.runtime.id && !!sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`); }
async function badge(tab: number): Promise<void> { await chrome.action.setBadgeText({ tabId: tab, text: routing.routes.some((route) => route.tab === tab && route.active) ? "ON" : "" }).catch(() => {}); }
async function startEditor(tab: number, frame: number, mode: "context" | "focused", share?: string, resume?: string): Promise<BackgroundResponse> {
  await ready;
  if (resume && (share || resuming.has(resume) || signing.has(resume) || finishing.has(resume) || dispatcher.registry.get(resume)?.state !== "active" || routing.routes.some(route => route.session === resume && route.active))) return { kind: "start_editor_result", reason: "Stop this draft in its current editor before resuming it." };
  if (share && (!routing.routes.some((route) => route.session === share && route.active) || finishing.has(share))) return { kind: "start_editor_result", reason: "That writing record is no longer active." };
  const frameInfo = (await chrome.webNavigation.getAllFrames({ tabId: tab }))?.find((candidate) => candidate.frameId === frame);
  if (!frameInfo) return { kind: "start_editor_result", reason: "The selected editor is no longer available." };
  if (share && routing.routes.some((route) => route.session === share && route.tab === tab && route.frame === frame && route.document === frameInfo.documentId)) return { kind: "start_editor_result", reason: "This document already participates in that writing record. Choose another tab to share it." };
  const activation_id = cryptoRef.randomUUID();
  if (resume && resuming.has(resume)) return { kind: "start_editor_result", reason: "This draft is already being resumed." };
  if (resume) resuming.add(resume);
  grants.set(activation_id, { tab, frame, document: frameInfo.documentId, share, resume });
  starting.add(`${tab}:${frame}`);
  try {
    const result = await chrome.tabs.sendMessage(tab, { kind: "start_editor", target: mode, activation_id, ...(share ? { share_session_id: share } : {}), ...(resume ? { resume_session_id: resume } : {}) }, { frameId: frame, ...(frameInfo.documentId ? { documentId: frameInfo.documentId } : {}) }) as BackgroundResponse;
    routing.last_start_error = result.kind === "start_editor_result" ? result.reason : undefined;
    if (result.kind === "start_editor_result" && result.session_id && routing.routes.some((route) => route.active && route.session === result.session_id && route.tab === tab && route.frame === frame && route.document === frameInfo.documentId)) routing.selected = result.session_id;
    await persist();
    return result;
  } catch { return { kind: "start_editor_result", reason: "This page is unavailable. Reload it, click the editor and try again." }; }
  finally { grants.delete(activation_id); starting.delete(`${tab}:${frame}`); if (resume) resuming.delete(resume); }
}
async function focusedEditor(share?: string, resume?: string): Promise<BackgroundResponse> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return { kind: "start_editor_result", reason: "Choose a browser tab containing an editor." };
  const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id }) ?? [];
  const probes = await Promise.all(frames.map(async (frame) => {
    try { const reply = await chrome.tabs.sendMessage(tab.id!, { kind: "probe_editor" }, { frameId: frame.frameId }) as { focused?: boolean }; return reply.focused ? frame.frameId : null; } catch { return null; }
  }));
  const candidates = probes.filter((frame): frame is number => frame !== null);
  // The page retains its activeElement when the side panel takes focus.
  // Exactly one frame must identify that editor; reject ambiguous targets.
  if (candidates.length !== 1) return { kind: "start_editor_result", reason: "Click inside the editor, then use Alt+Shift+W or right-click → Start writing record." };
  return startEditor(tab.id, candidates[0]!, "focused", share, resume);
}
async function freeze(session: string, bind = false): Promise<Snapshot> {
  if (routing.snapshots[session]) return routing.snapshots[session]!;
  const pending = finishing.get(session); if (pending) return pending;
  const task = (async (): Promise<Snapshot> => {
    const allRoutes = routing.routes.filter((route) => route.session === session);
    const shared = routing.shared?.[session] === true || allRoutes.length > 1;
    const routes = allRoutes.filter((route) => route.active);
    // Keep append authorization until each content frame acknowledges draining;
    // no new routes are permitted while this session is finishing.
    const results = await Promise.all(routes.map(async (route): Promise<ComputeBindingResponse> => {
      try { return await chrome.tabs.sendMessage(route.tab, { kind: "freeze_session", session_id: session, bind: bind && !shared }, target(route)) as ComputeBindingResponse; }
      catch { return { kind: "binding_error", reason: "The selected editor is no longer available. You can still save its captured editing activity." }; }
      finally { route.active = false; }
    }));
    // Multiple deliberately shared surfaces can differ; never choose one
    // silently for a wording binding.
    let snapshot: Snapshot = { binding: null, reason: "The editor is no longer available for text binding." };
    if (shared) snapshot = { binding: null, reason: "This record spans multiple editors. Save editing activity without a text binding." };
    else if (results.length === 1) snapshot = results[0]!.kind === "binding_result" ? { binding: (results[0] as Extract<ComputeBindingResponse, {kind:"binding_result"}>).text_binding } : { binding: null, reason: (results[0] as Extract<ComputeBindingResponse, {kind:"binding_error"}>).reason };
    if (bind && dispatcher.registry.get(session)?.pending_observation_gap) snapshot = { binding: null, reason: "This draft has no captured edits since it was resumed. Resume it and make an edit before including the current text, or publish only its earlier editing activity." };
    routing.snapshots[session] = snapshot;
    await persist();
    await Promise.all(routes.map((route) => badge(route.tab)));
    return snapshot;
  })();
  finishing.set(session, task);
  try { return await task; } finally { finishing.delete(session); }
}
async function routeMessage(message: ContentToBackground, sender: Sender): Promise<BackgroundResponse> {
  await ready;
  if (sender.tab && !isOwnUI(sender)) {
    const tab = sender.tab.id; const frame = sender.frameId ?? 0;
    if (sender.id !== chrome.runtime.id || tab === undefined) return { kind: "error", reason: "unauthorised_sender" };
    if (message.kind === "register_field") {
      const grant = message.activation_id ? grants.get(message.activation_id) : undefined;
      if (!grant || grant.tab !== tab || grant.frame !== frame || grant.document !== sender.documentId || grant.share !== message.share_session_id || grant.resume !== message.resume_session_id) return { kind: "error", reason: "explicit_start_required" };
      grants.delete(message.activation_id!);
      let url: URL; try { url = new URL(sender.url!); } catch { return { kind: "error", reason: "invalid_sender_url" }; }
      if (grant.resume && (signing.has(grant.resume) || finishing.has(grant.resume) || routing.routes.some(route => route.session === grant.resume && route.active))) return { kind: "error", reason: "This draft is busy in another editor." };
      const response = await dispatcher.handle({ ...message, tab_id: tab, frame_id: frame, origin_url: url.origin, page_path: url.pathname });
      if (response.kind === "register_field_result" && response.result.kind === "registered") {
        const session = response.result.session_id;
        if (grant.share && (finishing.has(session) || routing.snapshots[session] || !routing.routes.some((route) => route.session === session && route.active))) return { kind: "error", reason: "That writing record finished before this editor could join it." };
        if (grant.resume) {
          if (routing.routes.filter(route => route.session === session).length > 1) (routing.shared ??= {})[session] = true;
          routing.routes = routing.routes.filter(route => route.session !== session);
          delete routing.snapshots[session];
        }
        if (grant.share) (routing.shared ??= {})[session] = true;
        routing.routes.push({ tab, frame, document: sender.documentId, session, active: true }); routing.selected = session;
        await persist(); await badge(tab);
      }
      return response;
    }
    if (message.kind === "append_mutation" && routing.routes.some((route) => route.active && route.tab === tab && route.frame === frame && route.document === sender.documentId && route.session === message.session_id)) return dispatcher.handle(message);
    return { kind: "error", reason: "unauthorised_content_message" };
  }
  if (!isOwnUI(sender)) return { kind: "error", reason: "unauthorised_sender" };
  if (message.kind === "start_focused_editor") return focusedEditor(message.share_session_id, message.resume_session_id);
  if (message.kind === "register_field" || message.kind === "append_mutation") return { kind: "error", reason: "content_sender_required" };
  if (message.kind === "list_sessions") {
    await Promise.all(routing.routes.filter((route) => route.active && !finishing.has(route.session) && !starting.has(`${route.tab}:${route.frame}`)).map(async (route) => {
      try { const status = await chrome.tabs.sendMessage(route.tab, { kind: "capture_status", session_id: route.session }, target(route)) as { active?: boolean }; if (!status.active && !finishing.has(route.session) && !starting.has(`${route.tab}:${route.frame}`)) route.active = false; }
      catch { if (!finishing.has(route.session) && !starting.has(`${route.tab}:${route.frame}`)) route.active = false; }
      if (!route.active) await badge(route.tab);
    }));
    await persist();
    const result = await dispatcher.handle(message);
    if (result.kind !== "list_sessions_result") return result;
    return { ...result, selected_session_id: routing.selected, last_start_error: routing.last_start_error, capture_status: Object.fromEntries(result.sessions.map((session) => [session.session_id, routing.routes.some((route) => route.session === session.session_id && route.active) ? "active" : routing.routes.some((route) => route.session === session.session_id) || routing.snapshots[session.session_id] ? "stopped" : "legacy"])) };
  }
  if ("session_id" in message && resuming.has(message.session_id)) return { kind: "error", reason: "This draft is being resumed. Try again when it is ready." };
  if (message.kind === "prepare_finish" || message.kind === "stop_session") {
    const snapshot = await freeze(message.session_id, message.kind === "prepare_finish" && message.bind);
    if (message.kind === "stop_session") return { kind: "stop_session_result", ok: true };
    return { kind: "prepare_finish_result", text_binding: message.bind ? snapshot.binding : null, ...(message.bind && (!snapshot.binding || snapshot.reason) ? { reason: snapshot.reason ?? "The editor has no text to bind. Choose editing activity only to continue." } : {}) };
  }
  if (message.kind === "sign_session") {
    const snapshot = routing.snapshots[message.session_id];
    if (!snapshot) return { kind: "error", reason: "Finish preparation is required." };
    if (message.text_binding && JSON.stringify(message.text_binding) !== JSON.stringify(snapshot.binding)) return { kind: "error", reason: "The requested binding is not the frozen editor snapshot." };
  }
  if (message.kind === "discard_session") await freeze(message.session_id);
  if (message.kind === "sign_session" || message.kind === "retry_failed_upload") {
    if (signing.has(message.session_id)) return { kind: "error", reason: "This record is already being saved." };
    signing.add(message.session_id);
    try { return await dispatcher.handle(message); } finally { signing.delete(message.session_id); }
  }
  const result = await dispatcher.handle(message);
  if (message.kind === "discard_session") await pruneRoutes();
  return result;
}
async function pruneRoutes(): Promise<void> {
  const sessions = new Set(dispatcher.registry.list().map((session) => session.session_id));
  routing.routes = routing.routes.filter((route) => sessions.has(route.session));
  for (const session of Object.keys(routing.snapshots)) if (!sessions.has(session)) delete routing.snapshots[session];
  for (const session of Object.keys(routing.shared ?? {})) if (!sessions.has(session)) delete routing.shared![session];
  if (routing.selected && !sessions.has(routing.selected)) delete routing.selected;
  await persist();
}
void ready.then(() => pruneRoutes());
chrome.tabs.onRemoved.addListener((tab) => { void ready.then(async () => { for (const route of routing.routes) if (route.tab === tab) route.active = false; await persist(); }); });
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!isContentMessage(message)) { reply({ kind: "error", reason: "unrecognised_message" }); return false; }
  void routeMessage(message, sender).then(reply).catch((error) => reply({ kind: "error", reason: String(error) })); return true;
});
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
chrome.runtime.onInstalled.addListener(() => { void chrome.contextMenus.removeAll().then(() => chrome.contextMenus.create({ id: "pmbah-start", title: "Start writing record", contexts: ["editable"] })); });
async function reportStart(result: BackgroundResponse): Promise<void> {
  await ready;
  routing.last_start_error = result.kind === "start_editor_result" ? result.reason : result.kind === "error" ? result.reason : undefined;
  await persist();
}
async function reportStartFailure(): Promise<void> {
  // A failure obtaining the tab/frame is actionable in the panel; browser
  // event callbacks have no direct response channel. Storage failures cannot
  // themselves be persisted, so consume that rejection rather than loop.
  try { await reportStart({ kind: "start_editor_result", reason: "Could not access the chosen editor. Reload the page, click inside it and try again." }); } catch { /* panel refresh separately reports storage failure */ }
}
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "pmbah-start" || tab?.id === undefined) return;
  void chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  void startEditor(tab.id, info.frameId ?? 0, "context").then(reportStart).catch(reportStartFailure);
});
chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== "start-writing-record") return;
  if (tab?.id !== undefined) void chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  void focusedEditor().then(reportStart).catch(reportStartFailure);
});
chrome.webNavigation.onCommitted.addListener((details) => { void ready.then(async () => {
  for (const route of routing.routes) if (route.tab === details.tabId && (details.frameId === 0 || route.frame === details.frameId)) route.active = false;
  await persist(); await badge(details.tabId);
}); });
chrome.alarms.create("pmbah-ttl-sweep", { periodInMinutes: 60 });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === "pmbah-ttl-sweep") void ready.then(async () => { await dispatcher.sweepExpired(); await pruneRoutes(); }); });
