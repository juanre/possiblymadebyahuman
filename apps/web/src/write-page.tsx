import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SessionFrozenError,
  SessionRegistry,
  stripQueryAndHash,
  type CheckpointAdapter,
  type CheckpointRequest,
  type CheckpointResponse,
  type CheckpointResult,
  type IngestRecordInput,
  type IngestRecordResponse,
  type ObservationEnvelope,
  type ProducerIdentity,
  type SessionRecord,
  type SignedRecordDraft,
} from "../../../packages/producer-core/src/index.ts";
import { deriveMutationFromMeasuredInput } from "./write-capture.ts";

const STORAGE_KEY = "pmbah.write.sessions.v1";
const PRODUCER: ProducerIdentity = { id: "web-draft", version: "0.1.0", capabilities: ["timing"] };

type WriteStatus = "loading" | "ready" | "signing" | "uploaded" | "error";
type UploadPayload = IngestRecordInput & { observation?: ObservationEnvelope | { state: "unobserved" } };

class LocalSessionStorage {
  async read(): Promise<SessionRecord[]> {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SessionRecord[];
    return Array.isArray(parsed) ? parsed : [];
  }

  async write(snapshot: SessionRecord[]): Promise<void> {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  }
}

class FetchCheckpointAdapter implements CheckpointAdapter {
  async postCheckpoint(request: CheckpointRequest): Promise<CheckpointResult> {
    const body: Record<string, unknown> = {
      event_count: request.event_count,
      chain_tip: request.chain_tip,
    };
    if (request.token !== null) body.token = request.token;
    const response = await fetch(`/api/observed-sessions/${encodeURIComponent(request.observed_session_id)}/checkpoints`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
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

async function uploadRecord(payload: UploadPayload): Promise<IngestRecordResponse> {
  const response = await fetch("/api/records", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = typeof json?.error === "string" ? json.error : `upload_failed_${response.status}`;
    throw new Error(reason);
  }
  return json as IngestRecordResponse;
}

export function WritePage() {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const registry = useMemo(() => new SessionRegistry({
    clock: { now: () => Date.now() },
    uuid: { uuid: () => crypto.randomUUID() },
    storage: new LocalSessionStorage(),
    producer: PRODUCER,
    checkpoint: new FetchCheckpointAdapter(),
  }), []);
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [status, setStatus] = useState<WriteStatus>("loading");
  const [message, setMessage] = useState<string>("Preparing a local writing session…");
  const [uploaded, setUploaded] = useState<IngestRecordResponse | null>(null);
  const signedDraft = useRef<SignedRecordDraft | null>(null);

  const refreshSession = useCallback((sessionId: string) => {
    const next = registry.get(sessionId);
    if (next) setSession(next);
  }, [registry]);

  const createSession = useCallback(async () => {
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
    const record = registry.findOrCreate(origin, descriptor, {
      surface: "web-draft",
      label: "First-party drafting page",
      browser: { url: stripQueryAndHash(window.location.href), field_kind: "textarea" },
    });
    setSession(record);
    setStatus("ready");
    setMessage("Text stays in this browser canvas. Signing uploads only content-opaque process metadata.");
    await registry.persist();
  }, [registry]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await registry.init();
        registry.sweep();
        const retained = registry.list().filter((entry) => entry.capture_context?.surface !== "web-draft" || entry.state === "uploaded");
        registry.load(retained);
        await registry.persist();
        if (cancelled) return;
        await createSession();
      } catch (error) {
        if (!cancelled) {
          setStatus("error");
          setMessage(error instanceof Error ? error.message : String(error));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [createSession, registry]);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element || !session || session.state !== "active") return;

    const onBeforeInput = (event: InputEvent) => {
      const target = event.currentTarget as HTMLTextAreaElement;
      const value = target.value;
      const selectionStart = target.selectionStart;
      const selectionEnd = target.selectionEnd;
      const selectedCodepoints = Array.from(value.slice(selectionStart, selectionEnd)).length;
      const selectionStartCodepoints = Array.from(value.slice(0, selectionStart)).length;
      const beforeCodepoints = selectionStartCodepoints;
      const afterSelectionCodepoints = Array.from(value.slice(selectionEnd)).length;
      const inserted = event.data ?? event.dataTransfer?.getData("text/plain") ?? "";
      const mutation = deriveMutationFromMeasuredInput({
        inputType: event.inputType,
        selectionStartCodepoints,
        selectedCodepoints,
        dataCodepoints: Array.from(inserted).length,
        hasBackwardCodepoint: beforeCodepoints > 0,
        hasForwardCodepoint: afterSelectionCodepoints > 0,
      });
      if (!mutation) return;
      try {
        const updated = registry.appendMutation(session.session_id, mutation);
        setSession(updated);
        setMessage("Capturing content-opaque edit events locally.");
        void registry.persist();
        void registry.awaitObservationIdle(session.session_id).then(() => refreshSession(session.session_id));
      } catch (error) {
        if (error instanceof SessionFrozenError) return;
        setStatus("error");
        setMessage(error instanceof Error ? error.message : String(error));
      }
    };

    element.addEventListener("beforeinput", onBeforeInput);
    return () => element.removeEventListener("beforeinput", onBeforeInput);
  }, [refreshSession, registry, session]);

  const signAndUpload = useCallback(async () => {
    if (!session) return;
    setStatus("signing");
    setMessage("Flushing server-observed checkpoints, then uploading the content-opaque record…");
    try {
      await registry.flushObservation(session.session_id);
      const draft = signedDraft.current ?? registry.sign(session.session_id);
      signedDraft.current = draft;
      const observation = registry.getObservationEnvelope(session.session_id);
      registry.markUploading(session.session_id);
      await registry.persist();
      const response = await uploadRecord({ ...draft, observation: observation ?? { state: "unobserved" } });
      registry.markUploaded(session.session_id, response);
      await registry.persist();
      setUploaded(response);
      setStatus("uploaded");
      setMessage("Record uploaded. The link points to the public writing-process record; it contains no document text.");
      void navigator.clipboard?.writeText(response.url).catch(() => undefined);
      if (textareaRef.current) textareaRef.current.value = "";
      signedDraft.current = null;
      setSession(registry.get(session.session_id) ?? null);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      try {
        registry.markFailedUpload(session.session_id, reason);
        await registry.persist();
        refreshSession(session.session_id);
      } catch {
        // Keep the visible error even if the state transition already happened.
      }
      setStatus("error");
      setMessage(`Upload failed: ${reason}. The local event log is still available for retry.`);
    }
  }, [refreshSession, registry, session]);

  const reset = useCallback(async () => {
    signedDraft.current = null;
    if (textareaRef.current) textareaRef.current.value = "";
    registry.load(registry.snapshot().filter((entry) => entry.session_id !== session?.session_id));
    await registry.persist();
    setUploaded(null);
    await createSession();
  }, [createSession, registry, session]);

  const copyLink = useCallback(async () => {
    if (!uploaded) return;
    await navigator.clipboard?.writeText(uploaded.url);
    setMessage("Link copied.");
  }, [uploaded]);

  const eventCount = session?.events.length ?? 0;
  const elapsed = session && eventCount > 0 ? Math.max(0, session.events.at(-1)?.t ?? 0) : 0;
  const observationState = session?.observation.state ?? "unknown";
  const canSign = status === "ready" && eventCount > 0;
  const canRetry = status === "error" && session?.state === "failed_upload" && signedDraft.current !== null;

  return <main className="page-shell write-page">
    <p className="eyebrow">possiblymadebyahuman</p>
    <h1>Write and sign</h1>
    <p className="write-intro">A no-install drafting page for creating a content-opaque writing-process record. It only captures edits made inside this page.</p>

    <section className="banner" aria-label="Privacy note">
      <strong>Text stays in the browser.</strong>
      <p>PMBAH records event timing and edit shape. Signing uploads the manifest, event log, and server-observed checkpoint binding — not the words in the canvas.</p>
    </section>

    <textarea
      ref={textareaRef}
      id="pmbah-write-canvas"
      className="write-canvas"
      aria-label="Writing canvas"
      placeholder="Start with an empty canvas…"
      disabled={status === "signing" || status === "uploaded"}
      spellCheck="true"
    />

    <section className="card write-status" aria-label="Drafting status">
      <div className="stats-grid">
        <div className="stat"><span>Status</span><strong>{status}</strong></div>
        <div className="stat"><span>Events captured</span><strong>{eventCount}</strong></div>
        <div className="stat"><span>Elapsed edit time</span><strong>{elapsed}ms</strong></div>
        <div className="stat"><span>Checkpoint state</span><strong>{observationState}</strong></div>
      </div>
      <p className={status === "error" ? "error" : "muted"}>{message}</p>
      <div className="write-actions">
        <button className="verify-button" type="button" disabled={!canSign && !canRetry} onClick={signAndUpload}>{canRetry ? "Retry upload" : "Sign and upload"}</button>
        <button className="secondary-button" type="button" onClick={reset}>Discard/reset</button>
        {uploaded ? <button className="secondary-button" type="button" onClick={copyLink}>Copy link</button> : null}
      </div>
      {uploaded ? <p className="write-link">Short URL: <a href={uploaded.url}>{uploaded.url}</a></p> : null}
    </section>
  </main>;
}
