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
import { canonicalizeTextForBinding, createTextBinding, type TextBindingPolicy } from "../../../packages/format/src/index.ts";
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
  const [confirming, setConfirming] = useState(false);
  const [policy, setPolicy] = useState<TextBindingPolicy>("prefix");
  const [bindDocument, setBindDocument] = useState(true);
  const [canBind, setCanBind] = useState(false);

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
    setMessage("Text stays in this browser canvas. Signing uploads only content-blind process metadata.");
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
        setMessage("Capturing content-blind edit events locally.");
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
    setMessage("Flushing server-observed checkpoints, then uploading the content-blind record…");
    try {
      await registry.flushObservation(session.session_id);
      let draft = signedDraft.current;
      if (!draft) {
        let options = {};
        if (bindDocument) {
          const text = textareaRef.current?.value ?? "";
          // The binding is computed locally from the final text and discarded;
          // only the content-blind {scheme, policy, canonical_length, commitment}
          // is sealed into the record and uploaded.
          if (canonicalizeTextForBinding(text).length > 0) {
            options = { textBinding: createTextBinding(text, session.session_id, policy) };
          }
        }
        draft = registry.sign(session.session_id, options);
      }
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
  }, [bindDocument, policy, refreshSession, registry, session]);

  const openSignConfirm = useCallback(() => {
    const text = textareaRef.current?.value ?? "";
    const bindable = canonicalizeTextForBinding(text).length > 0;
    setCanBind(bindable);
    setBindDocument(bindable);
    setConfirming(true);
  }, []);

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
  const canSign = status === "ready" && eventCount > 0;
  const canRetry = status === "error" && session?.state === "failed_upload" && signedDraft.current !== null;
  const canDiscard = eventCount > 0 || !!uploaded;
  const phase = displayPhase(status, eventCount);
  const shortError = status === "error" ? "upload failed — try again" : null;

  // Cmd/Ctrl+Enter triggers sign-or-retry from anywhere on the page.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      if (!(event.metaKey || event.ctrlKey)) return;
      if (confirming) { event.preventDefault(); setConfirming(false); void signAndUpload(); return; }
      if (canRetry) { event.preventDefault(); void signAndUpload(); return; }
      if (canSign) { event.preventDefault(); openSignConfirm(); return; }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canSign, canRetry, confirming, openSignConfirm, signAndUpload]);

  return <div className="write-shell">
    <a className="write-home" href="/">← possiblymadebyahuman</a>

    <div className="write-canvas-wrap">
      <textarea
        ref={textareaRef}
        id="pmbah-write-canvas"
        className="write-canvas"
        aria-label="Writing canvas"
        placeholder=""
        disabled={status === "signing" || status === "uploaded"}
        spellCheck="true"
      />
    </div>

    {uploaded ? (
      <div className="write-result" role="status" aria-live="polite">
        <a className="write-result-link" href={uploaded.url}>{uploaded.url}</a>
        <span className="write-result-arrow">open record →</span>
      </div>
    ) : null}

    {confirming && !uploaded ? (
      <div className="write-sign-sheet" role="dialog" aria-label="Sign this record">
        <p className="write-sign-affirm">I affirm this is the text this record is meant to cover.</p>
        <label className="write-sign-option">
          <input
            type="checkbox"
            checked={bindDocument}
            disabled={!canBind}
            onChange={(event) => setBindDocument(event.target.checked)}
          />
          <span>{canBind ? "Bind the document I wrote" : "Nothing to bind — this text has no letters or digits"}</span>
        </label>
        {bindDocument ? (
          <fieldset className="write-sign-policy">
            <label>
              <input type="radio" name="bind-policy" checked={policy === "prefix"} onChange={() => setPolicy("prefix")} />
              <span>Allow appended text after it (prefix)</span>
            </label>
            <label>
              <input type="radio" name="bind-policy" checked={policy === "exact"} onChange={() => setPolicy("exact")} />
              <span>Exactly this text, nothing after (exact)</span>
            </label>
            <p className="write-sign-note">The check compares wording — letters and digits — not exact text.</p>
          </fieldset>
        ) : (
          <p className="write-sign-note">Signing the writing process only; no document is bound to this record.</p>
        )}
        <div className="write-sign-actions">
          <button className="ml-button" type="button" onClick={() => setConfirming(false)}>cancel</button>
          <button
            className="ml-button ml-primary"
            type="button"
            onClick={() => { setConfirming(false); void signAndUpload(); }}
          >
            sign &amp; upload
          </button>
        </div>
      </div>
    ) : null}

    <footer className="write-modeline" aria-label="Drafting status">
      <span className="ml-left">
        <span className="ml-status" data-state={uploaded ? "saved" : phase} aria-live="polite" aria-atomic="true">
          {uploaded ? "saved" : phase}
        </span>
        {!uploaded ? <>
          <span className="ml-sep">·</span>
          <span className="ml-stat">{eventCount} event{eventCount === 1 ? "" : "s"}</span>
          <span className="ml-sep">·</span>
          <span className="ml-stat">{(elapsed / 1000).toFixed(1)}s</span>
        </> : null}
        {shortError ? <>
          <span className="ml-sep">·</span>
          <span className="ml-error" title={message}>{shortError}</span>
        </> : null}
      </span>
      <span className="ml-right">
        {uploaded ? <button className="ml-button" type="button" onClick={copyLink}>copy link</button> : null}
        {!uploaded ? (
          <button
            className="ml-button ml-primary"
            type="button"
            disabled={!canSign && !canRetry}
            onClick={canRetry ? signAndUpload : openSignConfirm}
            title="sign (⌘↵ / Ctrl↵)"
          >
            {canRetry ? "retry" : "sign"}
          </button>
        ) : null}
        <button className="ml-button" type="button" disabled={!canDiscard} onClick={reset}>discard</button>
      </span>
    </footer>
  </div>;
}

function displayPhase(status: WriteStatus, eventCount: number): string {
  switch (status) {
    case "loading": return "preparing";
    case "signing": return "signing";
    case "uploaded": return "saved";
    case "error":    return "error";
    case "ready":    return eventCount === 0 ? "idle" : "drafting";
    default:         return status;
  }
}
