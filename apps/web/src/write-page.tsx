import { IndexedDbSessionStorage } from "../../../packages/browser-storage/src/index.ts";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SessionRegistry,
  type CheckpointAdapter,
  type CheckpointRequest,
  type CheckpointResponse,
  type CheckpointResult,
  type ProducerIdentity,
  type SessionRecord,
} from "../../../packages/producer-core/src/index.ts";
import { DraftEditor } from "./draft-editor.tsx";
import { DraftList } from "./draft-list.tsx";
import { DraftStore, adoptSessions, type DraftRow } from "./drafts.ts";
import "./write.css";

const STORAGE_KEY = "pmbah.write.sessions.v1";
const PRODUCER: ProducerIdentity = { id: "web-draft", version: "0.1.0", capabilities: ["timing"] };

class LocalSessionStorage extends IndexedDbSessionStorage {
  constructor(ownsStorage: () => boolean) {
    super({
      name: "pmbah.write.journal.v1",
      assertOwnership() { if (!ownsStorage()) throw new Error("Your drafts are open in another tab."); },
      async legacyRead() {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error("Stored writing sessions have an unrecognized shape; they have been preserved.");
        return parsed;
      },
      async legacyRemove() { window.localStorage.removeItem(STORAGE_KEY); },
    });
  }
}

class FetchCheckpointAdapter implements CheckpointAdapter {
  async postCheckpoint(request: CheckpointRequest, signal?: AbortSignal): Promise<CheckpointResult> {
    const body: Record<string, unknown> = {
      event_count: request.event_count,
      chain_tip: request.chain_tip,
    };
    if (request.token !== null) body.token = request.token;
    const response = await fetch(`/api/observed-sessions/${encodeURIComponent(request.observed_session_id)}/checkpoints`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const json = await response.json().catch(() => ({})) as { error?: string };
    if (response.ok) return { ok: true, response: json as CheckpointResponse };
    if (response.status === 404 && json.error === "observation_unavailable") {
      return { ok: false, kind: "unavailable", status: response.status, reason: json.error };
    }
    if (response.status === 409) return { ok: false, kind: "conflict", status: response.status, reason: json.error ?? "conflict" };
    if (response.status === 400) return { ok: false, kind: "client_bug", status: response.status, reason: json.error ?? "invalid_checkpoint" };
    if (response.status === 429) return { ok: false, kind: "rate_limited", status: response.status, reason: json.error ?? "rate_limited" };
    return { ok: false, kind: "transient", status: response.status, reason: json.error ?? `checkpoint_failed_${response.status}` };
  }
}

type Route = { view: "list" } | { view: "editor"; draft_id: string };
type Loaded = { state: "loading" } | { state: "failed"; reason: string } | { state: "ready"; drafts: DraftRow[] };

function routeFromLocation(): Route {
  const match = /^\/write\/([^/]+)\/?$/.exec(window.location.pathname);
  return match ? { view: "editor", draft_id: decodeURIComponent(match[1]) } : { view: "list" };
}

export const draftPath = (draft_id: string) => `/write/${encodeURIComponent(draft_id)}`;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * The /write drafting app. One tab at a time owns this browser's drafts, so
 * two tabs never write conflicting histories; the owner lists drafts and
 * edits one at a time.
 */
export function WritePage() {
  const storageOwner = useRef<symbol | null>(null);
  const ownershipAttempt = useRef<Promise<void>>(Promise.resolve());
  const registry = useMemo(() => new SessionRegistry({
    clock: { now: () => Date.now() },
    uuid: { uuid: () => crypto.randomUUID() },
    storage: new LocalSessionStorage(() => storageOwner.current !== null),
    producer: PRODUCER,
    signedFinishTime: true,
    checkpoint: new FetchCheckpointAdapter(),
  }), []);
  const store = useMemo(() => new DraftStore(), []);
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [route, setRoute] = useState<Route>(routeFromLocation);
  const [persistent, setPersistent] = useState<boolean | null>(null);

  const navigate = useCallback((path: string, options: { replace?: boolean } = {}) => {
    if (options.replace) window.history.replaceState(null, "", path);
    else window.history.pushState(null, "", path);
    setRoute(routeFromLocation());
  }, []);

  useEffect(() => {
    const onPop = () => setRoute(routeFromLocation());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const newSession = useCallback(async (options: { initial_content_unknown: boolean }): Promise<SessionRecord> => {
    const origin = { origin: window.location.origin, path: "/write", tab_id: 0, frame_id: 0 };
    const descriptor = {
      tag_name: "TEXTAREA" as const,
      field_kind: "first-party-draft",
      name: null,
      id: "pmbah-write-canvas",
      aria_label: "Writing canvas",
      nearest_form_id: null,
      dom_signature: "pmbah-write-canvas-v1",
      index_among_similar: 0,
    };
    const record = registry.findOrCreate(origin, descriptor, { surface: "web-draft" }, { fresh: true, initial_content_unknown: options.initial_content_unknown });
    await registry.persist();
    return record;
  }, [registry]);

  const createDraft = useCallback(async (): Promise<DraftRow> => {
    const record = await newSession({ initial_content_unknown: false });
    const now = Date.now();
    const row: DraftRow = { draft_id: crypto.randomUUID(), name: null, text: "",
      text_tag: { session_id: record.session_id, event_count: 0, chain_tip: null },
      session_ids: [record.session_id], created_ms: now, updated_ms: now };
    await store.put(row);
    void navigator.storage?.persist?.().then(setPersistent, () => setPersistent(false));
    return row;
  }, [newSession, store]);

  useEffect(() => {
    let cancelled = false;
    let release: (() => void) | undefined;
    const owner = Symbol("write storage owner");
    const previousAttempt = ownershipAttempt.current;
    const fail = (error: unknown) => { if (!cancelled) setLoaded({ state: "failed", reason: errorText(error) }); };
    setLoaded({ state: "loading" });
    const run = (async () => {
      // StrictMode cleanup can cancel the first effect before it requests a
      // lock. On retries, wait until the preceding lock has actually released.
      await previousAttempt.catch(() => undefined);
      if (cancelled) return;
      if (!navigator.locks) throw new Error("This browser cannot keep drafts safe between tabs.");
      await navigator.locks.request("pmbah.write.sessions.v1.owner", { ifAvailable: true }, async lock => {
        if (cancelled) return;
        if (!lock) throw new Error("Your drafts are open in another tab. Close that tab, then try again here.");
        storageOwner.current = owner;
        const released = new Promise<void>(resolve => { release = resolve; });
        try {
          await registry.init();
          registry.sweep({ ttl_ms: Infinity, retain_uploaded_anchors: true });
          await registry.persist();
          const adopted = adoptSessions(await store.list(), registry.list(), () => crypto.randomUUID());
          if (adopted.length) await store.put(...adopted);
          let drafts = await store.list();
          // A first visit goes straight to an empty draft.
          if (!drafts.length && routeFromLocation().view === "list") {
            const created = await createDraft();
            drafts = [created];
            if (!cancelled) navigate(draftPath(created.draft_id), { replace: true });
          }
          if (!cancelled) setLoaded({ state: "ready", drafts });
          void navigator.storage?.persisted?.().then(value => { if (!cancelled) setPersistent(value); }, () => undefined);
        } catch (error) { fail(error); }
        await released;
      });
    })().catch(fail);
    ownershipAttempt.current = run;
    return () => {
      cancelled = true;
      if (storageOwner.current === owner) storageOwner.current = null;
      release?.();
    };
  }, [attempt, createDraft, navigate, registry, store]);

  const replaceDraft = useCallback((draft: DraftRow) => {
    setLoaded(current => current.state !== "ready" ? current : {
      state: "ready",
      drafts: [draft, ...current.drafts.filter(row => row.draft_id !== draft.draft_id)].sort((a, b) => b.updated_ms - a.updated_ms),
    });
  }, []);

  const startDraft = useCallback(async () => {
    try {
      const created = await createDraft();
      replaceDraft(created);
      navigate(draftPath(created.draft_id));
    } catch (error) { setLoaded({ state: "failed", reason: errorText(error) }); }
  }, [createDraft, navigate, replaceDraft]);

  // Local writing history goes first: a draft row whose sessions are gone
  // resumes with a fresh session, never with another draft's history.
  const deleteDraft = useCallback(async (draft: DraftRow) => {
    await registry.discardPersisted(draft.session_ids.filter(id => registry.get(id)));
    await store.delete(draft.draft_id);
    setLoaded(current => current.state !== "ready" ? current : { state: "ready", drafts: current.drafts.filter(row => row.draft_id !== draft.draft_id) });
    if (routeFromLocation().view === "editor") navigate("/write");
  }, [navigate, registry, store]);

  const editorDraftId = route.view === "editor" ? route.draft_id : null;
  const editorDraft = loaded.state === "ready" && editorDraftId ? loaded.drafts.find(row => row.draft_id === editorDraftId) : undefined;
  const editorDraftRef = useRef(editorDraft);
  editorDraftRef.current = editorDraft;
  const addSession = useCallback(async (options: { initial_content_unknown: boolean }) => {
    const draft = editorDraftRef.current;
    if (!draft) throw new Error("This draft is no longer in this browser.");
    const record = await newSession(options);
    const changes = { session_ids: [...draft.session_ids, record.session_id], text_tag: null };
    if (!(await store.update(draft.draft_id, changes))) throw new Error("This draft is no longer in this browser.");
    replaceDraft({ ...draft, ...changes });
    return record;
  }, [newSession, replaceDraft, store]);
  const retryStorage = useCallback(() => setAttempt(value => value + 1), []);

  useEffect(() => { if (!editorDraft) document.title = "Drafts · possiblymadebyahuman"; }, [editorDraft]);

  if (loaded.state === "loading") return <div className="write-shell" aria-busy="true" />;
  if (loaded.state === "failed") {
    return <main className="drafts-page">
      <p className="drafts-home"><a href="/"><span aria-hidden="true">← </span>possiblymadebyahuman</a></p>
      <h1 className="drafts-heading">Drafts</h1>
      <p className="drafts-problem" role="alert">{loaded.reason}</p>
      <button className="write-button write-button-primary" type="button" onClick={retryStorage}>Try again</button>
    </main>;
  }
  if (editorDraft) {
    return <DraftEditor key={editorDraft.draft_id} registry={registry} store={store} draft={editorDraft}
      createSession={addSession} onDraftChange={replaceDraft} onDelete={deleteDraft}
      onRetryStorage={retryStorage} navigate={navigate} />;
  }
  return <DraftList drafts={loaded.drafts} registry={registry} persistent={persistent}
    missing={editorDraftId !== null} onNew={startDraft} onDelete={deleteDraft} navigate={navigate} />;
}
