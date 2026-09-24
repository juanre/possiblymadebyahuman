import { IndexedDbSessionStorage } from "../../../packages/browser-storage/src/index.ts";
import { uploadJournal } from "../../../packages/browser-storage/src/upload.ts";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IngestUploadError,
  SessionFrozenError,
  SessionRegistry,
  sessionEventCount,
  sessionLastEventTime,
  stripQueryAndHash,
  type CheckpointAdapter,
  type CheckpointRequest,
  type CheckpointResponse,
  type CheckpointResult,
  type IngestRecordResponse,
  type ProducerIdentity,
  type SessionRecord,
  type SignedRecordDraft,
} from "../../../packages/producer-core/src/index.ts";
import { canonicalizeTextForBinding, createTextBinding } from "../../../packages/format/src/index.ts";
import { attachWriteCapture } from "./write-capture.ts";

const STORAGE_KEY = "pmbah.write.sessions.v1";
const PRODUCER: ProducerIdentity = { id: "web-draft", version: "0.1.0", capabilities: ["timing"] };

type WriteStatus = "loading" | "ready" | "signing" | "uploaded" | "error" | "storage_error";
class LocalSessionStorage extends IndexedDbSessionStorage {
  constructor(ownsStorage: () => boolean) {
    super({
      name: "pmbah.write.journal.v1",
      assertOwnership() { if (!ownsStorage()) throw new Error("This tab no longer owns the local writing session."); },
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

function currentBindingText(textarea: HTMLTextAreaElement | null): string {
  if (!textarea) return "";
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  if (typeof start === "number" && typeof end === "number" && start !== end) {
    return textarea.value.slice(Math.min(start, end), Math.max(start, end));
  }
  return textarea.value;
}

export function WritePage() {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
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
  const storageLoaded = useRef(false);
  const [initializationAttempt, setInitializationAttempt] = useState(0);
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [status, setStatus] = useState<WriteStatus>("loading");
  const [message, setMessage] = useState<string>("Preparing a local writing session…");
  const [uploaded, setUploaded] = useState<IngestRecordResponse | null>(null);
  const signedDraft = useRef<SignedRecordDraft | null>(null);
  const capturePending = useRef<(() => boolean) | null>(null);
  const captureGap = useRef<(() => boolean) | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmArmed, setConfirmArmed] = useState(false);
  const [bindDocument, setBindDocument] = useState(true);
  const [canBind, setCanBind] = useState(false);
  const signSheetRef = useRef<HTMLDivElement | null>(null);

  const refreshSession = useCallback((sessionId: string) => {
    const next = registry.get(sessionId);
    if (next) setSession(next);
  }, [registry]);

  const createSession = useCallback(async (clearCanvas = false) => {
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
    }, { fresh: true, initial_content_unknown: !clearCanvas && !!textareaRef.current?.value.length });
    try { await registry.persist(); }
    catch (error) {
      // A failed clear keeps the writing visible. A later successful save must
      // not imply that this retained text was captured by the empty new log.
      if (clearCanvas && textareaRef.current?.value.length) {
        setSession(registry.resume(record.session_id, record.origin, record.descriptor, { field_is_empty: false }));
      } else setSession(record);
      throw error;
    }
    if (clearCanvas && textareaRef.current) textareaRef.current.value = "";
    setSession(record);
    setStatus("ready");
    setMessage("Text stays in this browser canvas. Signing uploads only content-blind process metadata.");
  }, [registry]);

  useEffect(() => {
    let cancelled = false;
    let release: (() => void) | undefined;
    const owner = Symbol("write storage owner");
    const previousAttempt = ownershipAttempt.current;
    const showStorageError = (error: unknown) => {
      if (cancelled) return;
      setStatus("storage_error");
      setMessage(`Local session storage is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    };
    const attempt = (async () => {
      // StrictMode cleanup can cancel the first effect before it requests a
      // lock. On retries, wait until the preceding lock has actually released.
      await previousAttempt.catch(() => undefined);
      if (cancelled) return;
      if (!navigator.locks) throw new Error("This browser cannot coordinate writing-session storage between tabs.");
      await navigator.locks.request("pmbah.write.sessions.v1.owner", { ifAvailable: true }, async lock => {
        if (cancelled) return;
        if (!lock) throw new Error("Another writing tab owns this local session. Close that tab, then retry saving here.");
        storageOwner.current = owner;
        storageLoaded.current = false;
        const released = new Promise<void>(resolve => { release = resolve; });
        try {
          await registry.init();
          storageLoaded.current = true;
          registry.sweep({ ttl_ms: Infinity, retain_uploaded_anchors: true });
          if (!cancelled) {
            const saved = registry.list().filter(entry => entry.capture_context?.surface === "web-draft");
            const recoverable = saved.filter(entry => entry.state === "failed_upload" || entry.state === "active")
              .sort((a, b) => b.last_edit_wall_ms - a.last_edit_wall_ms)[0];
            const previous = recoverable ?? saved.filter(entry => entry.state === "uploaded")
              .sort((a, b) => b.last_edit_wall_ms - a.last_edit_wall_ms)[0];
            if (previous) {
              if (previous.state === "active") registry.resume(previous.session_id, previous.origin, previous.descriptor, { field_is_empty: true });
              setSession(registry.get(previous.session_id) ?? previous);
              await registry.persist();
              setUploaded(previous.uploaded_response ?? null);
              setStatus(previous.state === "uploaded" ? "uploaded" : previous.state === "failed_upload" ? "error" : "ready");
              setMessage(previous.state === "failed_upload"
                ? "A frozen record was recovered. Retry uploads the same record; your writing was not stored."
                : previous.state === "uploaded" ? "Your saved record link was recovered. Your writing was not stored."
                  : "The local event log was recovered. Your writing was not stored; further edits begin after a capture gap.");
            } else await createSession();
          }
        } catch (error) { showStorageError(error); }
        await released;
      });
    })().catch(showStorageError);
    ownershipAttempt.current = attempt;
    return () => {
      cancelled = true;
      if (storageOwner.current === owner) storageOwner.current = null;
      release?.();
    };
  }, [createSession, registry, initializationAttempt]);

  // Put the cursor in the canvas as soon as the session is ready, so landing
  // on /write means you can start typing without clicking it first.
  useEffect(() => {
    if (status === "ready") textareaRef.current?.focus();
  }, [status]);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element || !session || session.state !== "active") return;

    const capture = attachWriteCapture(element, (mutation) => {
      try {
        const updated = registry.appendMutation(session.session_id, mutation);
        setSession(updated);
        setMessage("Capturing content-blind edit events locally.");
        void registry.persist().catch(error => {
          if (registry.get(session.session_id)?.state !== "active") return;
          setStatus("storage_error");
          setMessage(`The event log could not be saved locally: ${error instanceof Error ? error.message : String(error)}. Keep this page open and retry saving. Copy your writing before closing.`);
        });
        void registry.awaitObservationIdle(session.session_id).then(() => refreshSession(session.session_id));
      } catch (error) {
        if (error instanceof SessionFrozenError) return;
        // The DOM edit already occurred. Preserve that gap and pause capture
        // before another edit can be presented as a continuous sequence.
        registry.resume(session.session_id, session.origin, session.descriptor, { field_is_empty: false });
        setStatus("storage_error");
        setMessage(error instanceof Error ? error.message : String(error));
      }
    });
    capturePending.current = capture.isPending;
    captureGap.current = capture.hasGap;
    return () => { capturePending.current = null; captureGap.current = null; capture(); };
  }, [refreshSession, registry, session?.session_id, session?.state]);

  const signAndUpload = useCallback(async () => {
    if (!session) return;
    if (capturePending.current?.()) {
      setMessage("Finish the current edit or composition before signing.");
      return;
    }
    if (session.state === "active" && bindDocument && (captureGap.current?.() || registry.get(session.session_id)?.pending_observation_gap)) {
      setStatus("ready");
      setMessage("Capture has a gap. Make a recorded edit before binding text, or sign without a text binding.");
      return;
    }
    setStatus("signing");
    setMessage("Flushing server-observed checkpoints, then uploading the content-blind record…");
    try {
      let draft = signedDraft.current;
      if (!draft) {
        let options = {};
        if (bindDocument) {
          const text = currentBindingText(textareaRef.current);
          // The binding is computed locally from selected text, or all canvas
          // content when nothing is selected, then discarded; only the
          // content-blind {scheme, canonical_length, commitment} is sealed into
          // the record and uploaded.
          if (canonicalizeTextForBinding(text).length > 0) {
            options = { textBinding: createTextBinding(text, session.session_id) };
          }
        }
        draft = registry.sign(session.session_id, options);
      }
      signedDraft.current = draft;
      // Freeze and durably save before any awaited checkpoint/network work.
      await registry.persist();
      await registry.flushObservation(session.session_id);
      const observation = registry.getObservationEnvelope(session.session_id);
      registry.markUploading(session.session_id);
      await registry.persist();
      if (!draft.upload_id) throw new Error("Journal publication identity is missing");
      const response = await uploadJournal({ endpoint: "/api/record-uploads", fetch,
        payload: { upload_id: draft.upload_id, manifest: draft.manifest, observation: observation ?? { state: "unobserved" } },
        readEvents: (start, count) => registry.readEvents(session.session_id, start, count),
      });
      registry.markUploaded(session.session_id, response);
      setUploaded(response);
      setStatus("uploaded");
      setMessage(registry.getObservationState(session.session_id) === "diverged"
        ? "Record uploaded without server observation: the server's checkpoints for this session diverged. The link points to the public writing-process record; it contains no document text."
        : "Record uploaded. The link points to the public writing-process record; it contains no document text.");
      void navigator.clipboard?.writeText(response.url).catch(() => undefined);
      signedDraft.current = null;
      setSession(registry.get(session.session_id) ?? null);
      try { await registry.persist(); }
      catch (error) {
        setStatus("storage_error");
        setMessage(`Record uploaded, but its link could not be saved locally. Copy the displayed link and retry saving. ${error instanceof Error ? error.message : String(error)}`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      try {
        registry.markFailedUpload(session.session_id, reason);
        if (error instanceof IngestUploadError && (error.code === "observation_mismatch" || error.code === "observation_unavailable")) {
          registry.markObservationRejected(session.session_id, error.code);
        }
        await registry.persist();
      } catch {
        // Keep the visible error even if the state transition already happened.
      }
      refreshSession(session.session_id);
      setStatus("error");
      setMessage(`Record not uploaded: ${reason}. The frozen record is available in this page for retry; keep the page open until it is saved.`);
    }
  }, [bindDocument, refreshSession, registry, session]);

  const openSignConfirm = useCallback(() => {
    const text = currentBindingText(textareaRef.current);
    const bindable = canonicalizeTextForBinding(text).length > 0;
    setCanBind(bindable);
    setBindDocument(bindable);
    setConfirmArmed(false);
    setConfirming(true);
    window.setTimeout(() => setConfirmArmed(true), 50);
  }, []);

  const reset = useCallback(async () => {
    const hasText = (textareaRef.current?.value ?? "").length > 0;
    if (hasText && !window.confirm(`Clear the canvas and start a new draft? Your writing will be removed from the page. Use "copy text" first if you want to keep it.`)) {
      return;
    }
    setStatus("loading");
    try {
      if (session) await registry.discardPersisted([session.session_id]);
      signedDraft.current = null;
      setUploaded(null);
      await createSession(true);
    } catch (error) {
      setStatus("storage_error");
      setMessage(`Could not save the session change: ${error instanceof Error ? error.message : String(error)}. Your writing remains in the canvas.`);
    }
  }, [createSession, registry, session]);

  const keepEditing = useCallback(async () => {
    if (!session) return;
    try {
      const next = registry.continueFrom(session.session_id);
      setSession(next);
      await registry.persist();
      signedDraft.current = null;
      setUploaded(null);
      setStatus("ready");
      setMessage("Further edits will form a new record linked to your saved record.");
      textareaRef.current?.focus();
    } catch (error) {
      setStatus("storage_error");
      setMessage(`The continuation could not be saved locally: ${error instanceof Error ? error.message : String(error)}. Retry saving before editing.`);
    }
  }, [registry, session]);

  const retrySaving = useCallback(async () => {
    if (!storageOwner.current || !storageLoaded.current) { setInitializationAttempt(attempt => attempt + 1); return; }
    try {
      await registry.persist();
      if (!session) { await createSession(); return; }
      const current = registry.get(session.session_id);
      if (!current) { await createSession(); return; }
      setSession(current);
      setUploaded(current.uploaded_response ?? null);
      setStatus(current.state === "uploaded" ? "uploaded" : current.state === "failed_upload" ? "error" : "ready");
      setMessage("The local event log is saved. Your writing still needs to be copied before closing.");
    } catch (error) {
      setMessage(`Local saving still failed: ${error instanceof Error ? error.message : String(error)}. Keep this page open and copy your writing.`);
    }
  }, [createSession, registry, session]);

  const copyLink = useCallback(async () => {
    if (!uploaded) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard_unavailable");
      await navigator.clipboard.writeText(uploaded.url);
      setMessage("Record link copied to the clipboard.");
    } catch {
      setMessage("The record link could not be copied. Select and copy the displayed link manually.");
    }
  }, [uploaded]);

  const copyText = useCallback(async () => {
    const text = textareaRef.current?.value ?? "";
    if (!text) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard_unavailable");
      await navigator.clipboard.writeText(text);
      setMessage("Your writing was copied to the clipboard.");
    } catch {
      setMessage("Your writing could not be copied. Select it in the canvas and copy it manually.");
    }
  }, []);

  const eventCount = session ? sessionEventCount(session) : 0;
  const elapsed = session && eventCount > 0 ? Math.max(0, sessionLastEventTime(session)) : 0;
  const canSign = status === "ready" && eventCount > 0;
  const canRetry = status === "error" && session?.state === "failed_upload";
  const canDiscard = eventCount > 0 || !!uploaded;
  const phase = displayPhase(status, eventCount);
  const shortError = status === "storage_error" ? "local save failed" : status === "error" ? "record not uploaded" : null;

  // Cmd/Ctrl+Enter triggers sign-or-retry from anywhere on the page.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      if (!(event.metaKey || event.ctrlKey)) return;
      if (confirming && confirmArmed) { event.preventDefault(); setConfirming(false); setConfirmArmed(false); void signAndUpload(); return; }
      if (canRetry) { event.preventDefault(); void signAndUpload(); return; }
      if (canSign) { event.preventDefault(); openSignConfirm(); return; }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canSign, canRetry, confirmArmed, confirming, openSignConfirm, signAndUpload]);

  // Move focus into the sign sheet when it opens, so keyboard and screen-reader
  // users land on the first actionable control rather than the modeline button.
  useEffect(() => {
    if (!confirming) return;
    const focusable = signSheetRef.current?.querySelector<HTMLElement>("input:not(:disabled), button");
    focusable?.focus();
  }, [confirming]);

  return <div className="write-shell">
    <header className="write-header">
      <a className="write-home" href="/">← possiblymadebyahuman</a>
      <p className="write-notice">Your text is not saved. Copy it before closing or refreshing.</p>
    </header>
    <div className="write-canvas-wrap">
      <textarea
        ref={textareaRef}
        id="pmbah-write-canvas"
        className="write-canvas"
        aria-label="Writing canvas"
        placeholder="Write here. Your text stays in this browser; only the shape of the editing, when each edit happened and how large it was, is recorded and signed."
        disabled={status === "signing"}
        readOnly={status !== "ready"}
        spellCheck="true"
      />
    </div>

    {uploaded ? (
      <div className="write-result" role="status" aria-live="polite">
        <a className="write-result-link" href={uploaded.url} target="_blank" rel="noopener noreferrer">{uploaded.url}</a>
        <a className="write-result-arrow" href={uploaded.url} target="_blank" rel="noopener noreferrer">open record →</a>
      </div>
    ) : null}

    {confirming && !uploaded ? (
      <div className="write-sign-sheet" role="dialog" aria-label="Sign this record" ref={signSheetRef}>
        <label className="write-sign-option">
          <input
            type="checkbox"
            checked={bindDocument}
            disabled={!canBind}
            onChange={(event) => setBindDocument(event.target.checked)}
          />
          <span>{canBind ? "Bind selected text, or all canvas content if nothing is selected" : "Nothing to bind; this text has no letters or digits"}</span>
        </label>
        {bindDocument ? <p className="write-sign-note">A public binding lets anyone test guesses at the wording. Binding is not encryption.</p> : (
          <p className="write-sign-note">Signing the writing process only; no document is bound to this record.</p>
        )}
        <div className="write-sign-actions">
          <button className="ml-button" type="button" onClick={() => { setConfirming(false); setConfirmArmed(false); }}>cancel</button>
          <button
            className="ml-button ml-primary"
            type="button"
            disabled={!confirmArmed}
            onClick={() => { setConfirming(false); setConfirmArmed(false); void signAndUpload(); }}
          >
            sign &amp; upload
          </button>
        </div>
      </div>
    ) : null}

    <p className="write-message" data-state={status} role="status" aria-label="Drafting message">{message}</p>

    <footer className="write-modeline" aria-label="Drafting status">
      <span className="ml-left">
        <span className="ml-status" data-state={uploaded ? "saved" : phase}>
          {uploaded ? "record uploaded" : phase}
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
        {canDiscard ? <button className="ml-button" type="button" onClick={copyText}>copy text</button> : null}
        {uploaded ? <button className="ml-button" type="button" onClick={copyLink}>copy record link</button> : null}
        {uploaded && status === "uploaded" ? <button className="ml-button" type="button" onClick={keepEditing}>keep editing</button> : null}
        {status === "storage_error" ? <button className="ml-button ml-primary" type="button" onClick={retrySaving}>retry saving</button> : !uploaded ? (
          <button
            className="ml-button ml-primary"
            type="button"
            disabled={!canSign && !canRetry}
            onClick={canRetry ? signAndUpload : () => { window.setTimeout(openSignConfirm, 0); }}
            title="sign (⌘↵ / Ctrl↵)"
          >
            {canRetry ? "retry" : "sign"}
          </button>
        ) : null}
        <button className="ml-button" type="button" disabled={!canDiscard || status === "signing"} onClick={reset}>discard</button>
      </span>
    </footer>
  </div>;
}

function displayPhase(status: WriteStatus, eventCount: number): string {
  switch (status) {
    case "loading": return "preparing";
    case "signing": return "signing";
    case "uploaded": return "saved";
    case "storage_error": return "local save failed";
    case "error":    return "error";
    case "ready":    return eventCount === 0 ? "idle" : "drafting";
    default:         return status;
  }
}
