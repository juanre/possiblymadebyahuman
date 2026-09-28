import { uploadJournal } from "../../../packages/browser-storage/src/upload.ts";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IngestUploadError,
  SessionFrozenError,
  SessionRegistry,
  sessionEventCount,
  sessionLastEventTime,
  type IngestRecordResponse,
  type SessionRecord,
  type SignedRecordDraft,
} from "../../../packages/producer-core/src/index.ts";
import { canonicalizeTextForBinding, createTextBinding } from "../../../packages/format/src/index.ts";
import { attachWriteCapture } from "./write-capture.ts";
import { createCoalescingWriter, draftTitle, type DraftRow, type DraftStore } from "./drafts.ts";

type WriteStatus = "loading" | "ready" | "signing" | "uploaded" | "error" | "storage_error";
type SaveState = { kind: "saved" } | { kind: "saving" } | { kind: "failed"; reason: string };
type SavedText = { text: string; tag: DraftRow["text_tag"] };

export type DraftEditorProps = {
  registry: SessionRegistry;
  store: DraftStore;
  draft: DraftRow;
  /** Starts a fresh writing session for this draft, e.g. when its saved session is missing. */
  createSession: (options: { initial_content_unknown: boolean }) => Promise<SessionRecord>;
  onDraftChange: (draft: DraftRow) => void;
  onDelete: (draft: DraftRow) => Promise<void>;
  onRetryStorage: () => void;
  navigate: (path: string) => void;
};

function currentBindingText(textarea: HTMLTextAreaElement | null): string {
  if (!textarea) return "";
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  if (typeof start === "number" && typeof end === "number" && start !== end) {
    return textarea.value.slice(Math.min(start, end), Math.max(start, end));
  }
  return textarea.value;
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Why publishing failed, in words; the service's error code stays visible for reports. */
function publishFailure(error: unknown): string {
  if (error instanceof IngestUploadError) {
    const code = error.code ?? `HTTP ${error.status}`;
    if (error.status === 429 || error.code === "server_busy") return `the service is busy (${code}); wait a minute, then retry`;
    if (error.status === 413) return `this record is larger than the service accepts (${code})`;
    if (error.status >= 500) return `the service is unavailable right now (${code})`;
    return `the service did not accept the record (${code})`;
  }
  if (error instanceof TypeError) return "the service could not be reached; check your connection";
  if (error instanceof SyntaxError) return "the service sent a reply this page could not read";
  return errorText(error);
}

export function DraftEditor({ registry, store, draft, createSession, onDraftChange, onDelete, onRetryStorage, navigate }: DraftEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const currentSessionId = draft.session_ids.at(-1) ?? null;
  const [session, setSession] = useState<SessionRecord | null>(null);
  // The canvas stays read-only until the draft's session is attached, so no
  // keystroke can reach the page before capture records it.
  const [status, setStatus] = useState<WriteStatus>("loading");
  const [message, setMessage] = useState<string>("");
  const [uploaded, setUploaded] = useState<IngestRecordResponse | null>(null);
  const [saveState, setSaveState] = useState<SaveState>({ kind: "saved" });
  const [renaming, setRenaming] = useState(false);
  const restored = useRef(false);
  const signedDraft = useRef<SignedRecordDraft | null>(null);
  const capturePending = useRef<(() => boolean) | null>(null);
  const captureGap = useRef<(() => boolean) | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [bindDocument, setBindDocument] = useState(true);
  const [canBind, setCanBind] = useState(false);
  const signDialogRef = useRef<HTMLDialogElement | null>(null);

  // Draft text is written after the events it corresponds to, so a saved
  // tag never names events that are not durable. If the journal cannot be
  // saved, the text is still kept, untagged, and resumes after a gap.
  const textWriter = useMemo(() => createCoalescingWriter<SavedText>(async ({ text, tag }) => {
    let savedTag = tag;
    try { await registry.persist(); }
    catch { savedTag = null; }
    const changes = { text, text_tag: savedTag, updated_ms: Date.now() };
    if (!(await store.update(draftRef.current.draft_id, changes))) return;
    draftRef.current = { ...draftRef.current, ...changes };
    onDraftChange(draftRef.current);
  }), [onDraftChange, registry, store]);

  const saveText = useCallback((snapshot: SavedText) => {
    setSaveState({ kind: "saving" });
    textWriter.schedule(snapshot).then(
      () => { if (!textWriter.hasPending()) setSaveState({ kind: "saved" }); },
      error => setSaveState({ kind: "failed", reason: errorText(error) }),
    );
  }, [textWriter]);

  const currentSnapshot = useCallback((record: SessionRecord | undefined): SavedText => ({
    text: textareaRef.current?.value ?? "",
    tag: record ? { session_id: record.session_id, event_count: sessionEventCount(record), chain_tip: record.last_event_chain_tip } : null,
  }), []);

  const showSession = useCallback((record: SessionRecord) => {
    setSession(record);
    setUploaded(record.uploaded_response ?? null);
    setStatus(record.state === "uploaded" ? "uploaded" : record.state === "failed_upload" ? "error" : "ready");
    setMessage(record.state === "failed_upload"
      ? "This draft's signed record was not published yet. Retry publishes the same signed record."
      : "");
  }, []);

  // Restore the saved text before capture attaches, then reattach the
  // session: continuous only when the text matches the recorded chain.
  useEffect(() => {
    let cancelled = false;
    const element = textareaRef.current;
    if (element && !restored.current) element.value = draftRef.current.text;
    restored.current = true;
    void (async () => {
      try {
        const saved = currentSessionId ? registry.get(currentSessionId) : undefined;
        let record: SessionRecord;
        if (!saved) {
          record = await createSession({ initial_content_unknown: draftRef.current.text.length > 0 });
        } else if (saved.state === "active") {
          const tag = draftRef.current.text_tag;
          record = registry.resume(saved.session_id, saved.origin, saved.descriptor, {
            field_is_empty: draftRef.current.text.length === 0,
            ...(tag && tag.session_id === saved.session_id ? { continuity: { event_count: tag.event_count, chain_tip: tag.chain_tip } } : {}),
          });
          await registry.persist();
        } else record = saved;
        if (!cancelled) showSession(record);
      } catch (error) {
        if (cancelled) return;
        setStatus("storage_error");
        setMessage(`This draft's writing history could not be saved in this browser: ${errorText(error)}`);
      }
    })();
    return () => { cancelled = true; };
  }, [createSession, currentSessionId, registry, showSession]);

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
        saveText(currentSnapshot(updated));
        void registry.persist().catch(error => {
          if (registry.get(session.session_id)?.state !== "active") return;
          setStatus("storage_error");
          setMessage(`The writing history could not be saved in this browser: ${errorText(error)}. Keep this page open and retry saving.`);
        });
        void registry.awaitObservationIdle(session.session_id).then(() => {
          const next = registry.get(session.session_id);
          if (next) setSession(next);
        });
      } catch (error) {
        if (error instanceof SessionFrozenError) return;
        // The DOM edit already occurred. Preserve that gap and pause capture
        // before another edit can be presented as a continuous sequence.
        registry.resume(session.session_id, session.origin, session.descriptor, { field_is_empty: false });
        saveText({ text: element.value, tag: null });
        setStatus("storage_error");
        setMessage(errorText(error));
      }
    });
    capturePending.current = capture.isPending;
    captureGap.current = capture.hasGap;
    return () => { capturePending.current = null; captureGap.current = null; capture(); };
  }, [currentSnapshot, registry, saveText, session?.session_id, session?.state]);

  // Saving is asynchronous; leaving while text or a publication is in
  // flight asks the browser to confirm, and hiding the page flushes.
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!textWriter.hasPending() && status !== "signing") return;
      event.preventDefault();
      event.returnValue = "";
    };
    const hidden = () => { if (document.visibilityState === "hidden") void textWriter.flush().catch(() => undefined); };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [status, textWriter]);

  // Leaving the editor for the drafts list saves at once.
  useEffect(() => () => { void textWriter.flush().catch(() => undefined); }, [textWriter]);

  const signAndPublish = useCallback(async () => {
    if (!session) return;
    if (capturePending.current?.()) {
      setMessage("Finish the current edit or composition before signing.");
      return;
    }
    if (session.state === "active" && bindDocument && (captureGap.current?.() || registry.get(session.session_id)?.pending_observation_gap)) {
      setStatus("ready");
      setMessage("Part of this draft was written while it was not being recorded. Make one more edit before binding the text, or sign without binding it.");
      return;
    }
    setStatus("signing");
    setMessage("Publishing the signed record…");
    try {
      let signed = signedDraft.current;
      if (!signed) {
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
        signed = registry.sign(session.session_id, options);
      }
      signedDraft.current = signed;
      // Freeze and durably save before any awaited checkpoint/network work.
      await registry.persist();
      await textWriter.flush().catch(() => undefined);
      await registry.flushObservation(session.session_id);
      const observation = registry.getObservationEnvelope(session.session_id);
      registry.markUploading(session.session_id);
      await registry.persist();
      if (!signed.upload_id) throw new Error("Journal publication identity is missing");
      const response = await uploadJournal({ endpoint: "/api/record-uploads", fetch,
        payload: { upload_id: signed.upload_id, manifest: signed.manifest, observation: observation ?? { state: "unobserved" } },
        readEvents: (start, count) => registry.readEvents(session.session_id, start, count),
      });
      registry.markUploaded(session.session_id, response);
      setUploaded(response);
      setStatus("uploaded");
      setMessage(registry.getObservationState(session.session_id) === "diverged"
        ? "Published without server-confirmed timing: the server's checkpoints for this draft did not match its history."
        : "");
      signedDraft.current = null;
      setSession(registry.get(session.session_id) ?? null);
      try { await registry.persist(); }
      catch (error) {
        setStatus("storage_error");
        setMessage(`Published, but the link could not be saved in this browser. Copy the link now, then retry saving. ${errorText(error)}`);
      }
    } catch (error) {
      const reason = publishFailure(error);
      try {
        registry.markFailedUpload(session.session_id, reason);
        if (error instanceof IngestUploadError && (error.code === "observation_mismatch" || error.code === "observation_unavailable")) {
          registry.markObservationRejected(session.session_id, error.code);
        }
        await registry.persist();
      } catch {
        // Keep the visible error even if the state transition already happened.
      }
      const next = registry.get(session.session_id);
      if (next) setSession(next);
      setStatus("error");
      setMessage(`Not published: ${reason}. The signed record is saved in this browser; retry publishes exactly the same record.`);
    }
  }, [bindDocument, registry, session, textWriter]);

  const openSignDialog = useCallback(() => {
    const text = currentBindingText(textareaRef.current);
    const bindable = canonicalizeTextForBinding(text).length > 0;
    setCanBind(bindable);
    setBindDocument(bindable);
    setConfirming(true);
  }, []);

  // Closing the native dialog returns focus to the control that opened it.
  const closeSignDialog = useCallback(() => setConfirming(false), []);

  useEffect(() => {
    const dialog = signDialogRef.current;
    if (!dialog) return;
    if (confirming && !dialog.open) dialog.showModal();
    if (!confirming && dialog.open) dialog.close();
  }, [confirming]);

  const keepWriting = useCallback(async () => {
    if (!session) return;
    try {
      const next = registry.continueFrom(session.session_id);
      await registry.persist();
      const changes = { session_ids: [...draftRef.current.session_ids, next.session_id], updated_ms: Date.now() };
      if (!(await store.update(draftRef.current.draft_id, changes))) throw new Error("this draft is no longer in this browser");
      draftRef.current = { ...draftRef.current, ...changes };
      onDraftChange(draftRef.current);
      signedDraft.current = null;
    } catch (error) {
      setStatus("storage_error");
      setMessage(`Could not start the next record in this browser: ${errorText(error)}. Retry saving before writing more.`);
    }
  }, [onDraftChange, registry, session, store]);

  const retrySaving = useCallback(async () => {
    try {
      await registry.persist();
      await textWriter.flush();
      if (!session) { onRetryStorage(); return; }
      const current = registry.get(session.session_id);
      if (!current) { onRetryStorage(); return; }
      showSession(current);
      setMessage("Saved in this browser.");
    } catch (error) {
      setMessage(`Saving in this browser still failed: ${errorText(error)}. Keep this page open and copy your writing.`);
    }
  }, [onRetryStorage, registry, session, showSession, textWriter]);

  const copyLink = useCallback(async () => {
    if (!uploaded) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard_unavailable");
      await navigator.clipboard.writeText(uploaded.url);
      setMessage("Link copied.");
    } catch {
      setMessage("The link could not be copied. Select it and copy it yourself.");
    }
  }, [uploaded]);

  const copyText = useCallback(async () => {
    const text = textareaRef.current?.value ?? "";
    if (!text) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard_unavailable");
      await navigator.clipboard.writeText(text);
      setMessage("Your writing was copied.");
    } catch {
      setMessage("Your writing could not be copied. Select it and copy it yourself.");
    }
  }, []);

  const rename = useCallback(async (value: string) => {
    setRenaming(false);
    const name = value.trim() || null;
    try {
      if (!(await store.update(draftRef.current.draft_id, { name }))) return;
      draftRef.current = { ...draftRef.current, name };
      onDraftChange(draftRef.current);
    } catch (error) {
      setSaveState({ kind: "failed", reason: errorText(error) });
    }
  }, [onDraftChange, store]);

  const deleteDraft = useCallback(async () => {
    const published = draft.session_ids.some(id => registry.get(id)?.uploaded_response);
    const question = published
      ? "Delete this draft from this browser? Its published records stay online; their links will no longer be listed here."
      : "Delete this draft? Its writing and editing history will be removed from this browser.";
    if (!window.confirm(question)) return;
    try {
      // A save still in flight must land before deletion, never after it.
      await textWriter.flush().catch(() => undefined);
      await onDelete(draftRef.current);
    }
    catch (error) {
      setStatus("storage_error");
      setMessage(`The draft could not be deleted: ${errorText(error)}. Your writing is still here.`);
    }
  }, [draft.session_ids, onDelete, registry, textWriter]);

  const eventCount = session ? sessionEventCount(session) : 0;
  const elapsed = session && eventCount > 0 ? Math.max(0, sessionLastEventTime(session)) : 0;
  const canSign = status === "ready" && eventCount > 0;
  const canRetry = status === "error" && session?.state === "failed_upload";
  const parent = session?.parent_record && session.state === "active"
    ? draft.session_ids.map(id => registry.get(id)).find(entry => entry?.uploaded_response?.record_hash === session.parent_record)?.uploaded_response
    : undefined;

  const title = draftTitle(draft);
  useEffect(() => { document.title = `${title} · possiblymadebyahuman`; }, [title]);

  // Cmd/Ctrl+Enter opens the sign dialog, confirms it, or retries.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
      if (confirming) { event.preventDefault(); setConfirming(false); void signAndPublish(); return; }
      if (canRetry) { event.preventDefault(); void signAndPublish(); return; }
      if (canSign) { event.preventDefault(); openSignDialog(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canSign, canRetry, confirming, openSignDialog, signAndPublish]);

  return <div className="write-shell">
    <header className="write-header">
      <a className="write-back" href="/write" onClick={event => { event.preventDefault(); navigate("/write"); }}><span aria-hidden="true">← </span>Drafts</a>
      {renaming ? (
        <input
          className="write-title-input"
          aria-label="Draft name"
          defaultValue={draft.name ?? ""}
          placeholder={draftTitle({ name: null, text: textareaRef.current?.value ?? "" })}
          autoFocus
          onBlur={event => void rename(event.currentTarget.value)}
          onKeyDown={event => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") setRenaming(false);
          }}
        />
      ) : (
        <button className="write-title" type="button" onClick={() => setRenaming(true)} title="Rename this draft">
          <span className="write-title-text">{title}</span>
        </button>
      )}
      <span className="write-save" data-state={saveState.kind} role="status" aria-label="Save state">
        {saveState.kind === "saved" ? "Saved in this browser" : saveState.kind === "saving" ? "Saving…" : `Not saved: ${saveState.reason}`}
      </span>
    </header>
    {parent ? <p className="write-continues">Continues <a href={parent.url} target="_blank" rel="noopener noreferrer">{parent.url.replace(/^https?:\/\//, "")}</a></p> : null}

    <div className="write-canvas-wrap">
      <textarea
        ref={textareaRef}
        id="pmbah-write-canvas"
        className="write-canvas"
        aria-label="Writing canvas"
        placeholder="Write here. Your draft is saved in this browser and never uploaded. When you sign, only the shape of your editing is published."
        disabled={status === "signing"}
        readOnly={status !== "ready"}
        spellCheck="true"
      />
    </div>

    {uploaded ? (
      <section className="write-published" aria-label="Published record">
        <p className="write-published-title">Published</p>
        <div className="write-published-link">
          <input className="write-link-field" readOnly value={uploaded.url} aria-label="Record link" onFocus={event => event.currentTarget.select()} />
          <button className="write-button" type="button" onClick={copyLink}>Copy link</button>
          <a className="write-button write-button-primary" href={uploaded.url} target="_blank" rel="noopener noreferrer">Open record</a>
        </div>
        {status === "uploaded" ? <p className="write-published-next">
          Keep writing to add to this draft; your next edits become a new record linked to this one.
          <button className="write-button" type="button" onClick={keepWriting}>Keep writing</button>
        </p> : null}
      </section>
    ) : null}

    <dialog className="write-sign-dialog" ref={signDialogRef} aria-labelledby="sign-dialog-title"
      onCancel={event => { event.preventDefault(); closeSignDialog(); }}
      onClick={event => { if (event.target === event.currentTarget) closeSignDialog(); }}>
      <form method="dialog" onSubmit={event => { event.preventDefault(); setConfirming(false); void signAndPublish(); }}>
        <h2 id="sign-dialog-title">Sign and publish this draft?</h2>
        <p className="write-sign-note">Publishing creates a public record of how this draft was written. Your words stay in this browser.</p>
        <label className="write-sign-option">
          <input type="checkbox" checked={bindDocument} disabled={!canBind} onChange={event => setBindDocument(event.target.checked)} />
          <span>{canBind ? "Let readers check a copy of the text against this record" : "There is no text to check against: this draft has no letters or digits"}</span>
        </label>
        <p className="write-sign-note">{bindDocument
          ? "Uses the selected text, or the whole draft if nothing is selected. Anyone can test guesses of the wording against it, so short or predictable text can be guessed."
          : "Only the editing process is signed; no text can be checked against this record."}</p>
        <div className="write-sign-actions">
          <button className="write-button" type="button" onClick={closeSignDialog}>Cancel</button>
          <button className="write-button write-button-primary" type="submit">Sign &amp; publish</button>
        </div>
      </form>
    </dialog>

    <p className="write-message" data-state={status} role="status" aria-label="Drafting message">{message}</p>

    <footer className="write-modeline" aria-label="Drafting status">
      <span className="ml-left">
        <span className="ml-stat">{eventCount} edit{eventCount === 1 ? "" : "s"}</span>
        <span className="ml-sep">·</span>
        <span className="ml-stat">{formatElapsed(elapsed)}</span>
      </span>
      <span className="ml-right">
        <button className="ml-button" type="button" onClick={copyText}>Copy text</button>
        <button className="ml-button" type="button" disabled={status === "signing"} onClick={deleteDraft}>Delete draft</button>
        {status === "storage_error" ? <button className="write-button write-button-primary" type="button" onClick={retrySaving}>Retry saving</button> : !uploaded ? (
          <button
            className="write-button write-button-primary"
            type="button"
            disabled={!canSign && !canRetry}
            onClick={canRetry ? signAndPublish : openSignDialog}
            title="Sign (⌘↵ / Ctrl↵)"
          >
            {canRetry ? "Retry publishing" : status === "signing" ? "Publishing…" : "Sign"}
          </button>
        ) : null}
      </span>
    </footer>
  </div>;
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
