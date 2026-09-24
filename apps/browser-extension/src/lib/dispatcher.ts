import type { TextBinding } from "../../../../packages/format/src/index.ts";
import { IngestUploadError, SessionFrozenError, SessionRegistry, buildCaptureContext } from "../../../../packages/producer-core/src/index.ts";
import type {
  ClockAdapter,
  CheckpointAdapter,
  ProducerIdentity,
  SessionRecord,
  StorageAdapter,
  UploadAdapter,
  UuidAdapter,
} from "../../../../packages/producer-core/src/index.ts";
import type {
  BackgroundResponse,
  ContentToBackground,
  SignSessionResult,
} from "./messages.ts";
import { findResumableSession, isFieldEligible } from "./policy.ts";

export interface DispatcherOptions {
  clock: ClockAdapter;
  uuid: UuidAdapter;
  storage: StorageAdapter;
  upload: UploadAdapter;
  checkpoint: CheckpointAdapter;
  producer: ProducerIdentity;
}

/** Shown to the signer when the server's checkpoints stopped matching the session and the record went up unobserved. */
export const DIVERGED_OBSERVATION_NOTE =
  "server observation of this session diverged, so the record is saved without server-observed commitments";

export class BackgroundDispatcher {
  readonly registry: SessionRegistry;
  readonly #upload: UploadAdapter;
  #initPromise: Promise<void> | null = null;

  constructor(options: DispatcherOptions) {
    this.registry = new SessionRegistry({
      clock: options.clock,
      uuid: options.uuid,
      storage: options.storage,
      producer: options.producer,
      checkpoint: options.checkpoint,
      signedFinishTime: true,
    });
    this.#upload = options.upload;
  }

  ensureInitialised(): Promise<void> {
    if (!this.#initPromise) this.#initPromise = this.registry.init().then(() => this.sweepExpired());
    return this.#initPromise;
  }

  /** Clears uploaded event logs after their grace period; drafts and saved links never expire. */
  async sweepExpired(): Promise<void> {
    if (this.registry.list().length === 0) return;
    this.registry.sweep({ ttl_ms: Infinity, retain_uploaded_anchors: true });
    await this.registry.persist();
  }

  async handle(message: ContentToBackground): Promise<BackgroundResponse> {
    await this.ensureInitialised();
    try {
      switch (message.kind) {
        case "list_panel_sessions":
        case "rename_session":
        case "remove_saved":
        case "clear_saved":
        case "export_saved":
        case "inspect_finish":
        case "start_focused_editor":
        case "prepare_finish":
        case "stop_session":
          return { kind: "error", reason: "browser_routing_required" };
        case "register_field":
          return await this.#handleRegister(message);
        case "append_mutation":
          return await this.#handleAppend(message);
        case "list_sessions":
          return { kind: "list_sessions_result", sessions: this.registry.list() };
        case "sign_session":
          return await this.#handleSign(message);
        case "retry_failed_upload":
          return await this.#handleRetry(message);
        case "discard_session":
          return await this.#handleDiscard(message);
      }
    } catch (error) {
      return { kind: "error", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async #handleRegister(message: Extract<ContentToBackground, { kind: "register_field" }>): Promise<BackgroundResponse> {
    await this.sweepExpired();
    const origin = {
      origin: message.origin_url,
      path: message.page_path,
      tab_id: message.tab_id,
      frame_id: message.frame_id,
    };
    if (message.continue_session_id) {
      const parent = this.registry.get(message.continue_session_id);
      if (!parent || parent.state !== "uploaded" || parent.origin.origin !== origin.origin) return { kind: "error", reason: "Continue this saved record in a field on its original site." };
      if (this.registry.list().some(session => session.state !== "uploaded" && session.parent_record === parent.uploaded_response?.record_hash)) {
        return { kind: "error", reason: "An unfinished draft already continues this record. Choose that draft and resume it instead." };
      }
      const continuation = this.registry.continueFrom(parent.session_id, { origin, descriptor: message.descriptor });
      await this.registry.persist();
      return { kind: "register_field_result", result: { kind: "registered", session_id: continuation.session_id, certainty: "fresh" } };
    }
    if (message.resume_session_id) {
      const existing = this.registry.get(message.resume_session_id);
      if (!existing || existing.state !== "active" || existing.origin.origin !== origin.origin) {
        return { kind: "error", reason: "This draft cannot be resumed in that site." };
      }
      const resumed = this.registry.resume(existing.session_id, origin, message.descriptor, { field_is_empty: message.field_is_empty });
      await this.registry.persist();
      return { kind: "register_field_result", result: { kind: "registered", session_id: resumed.session_id, certainty: "resumed" } };
    }
    if (message.share_session_id) {
      const shared = this.registry.get(message.share_session_id);
      if (!shared || shared.state !== "active" || shared.origin.origin !== origin.origin) return { kind: "error", reason: "shared_session_unavailable" };
      return { kind: "register_field_result", result: { kind: "registered", session_id: shared.session_id, certainty: "resumed" } };
    }
    const eligibility = isFieldEligible({
      origin,
      descriptor: message.descriptor,
      field_is_empty: message.field_is_empty,
      existing_sessions: message.activation_id ? [] : this.registry.list(),
    });
    // Explicit Start records only future edits, even when the field already
    // contains writing. Legacy descriptor-based callers keep their policy.
    if (!message.activation_id && !eligibility.eligible) {
      return {
        kind: "register_field_result",
        result: { kind: "ineligible", reason: eligibility.reason },
      };
    }
    const capture = buildCaptureContext({
      origin,
      descriptor: message.descriptor,
      page_title: message.page_title,
    });
    // Legacy registration may continue a matching uploaded session. Explicit
    // Start is independent; only Continue may link it to a saved record.
    const resumable = message.activation_id || message.field_is_empty ? null : findResumableSession(origin, message.descriptor, this.registry.list());
    const session = resumable?.state === "uploaded"
      ? this.registry.continueFrom(resumable.session_id, { origin, descriptor: message.descriptor })
      : this.registry.findOrCreate(origin, message.descriptor, capture, { fresh: !!message.activation_id, initial_content_unknown: !!message.activation_id && !message.field_is_empty });
    await this.registry.persist();
    return {
      kind: "register_field_result",
      result: { kind: "registered", session_id: session.session_id, certainty: session.identity_certainty },
    };
  }

  async #handleAppend(message: Extract<ContentToBackground, { kind: "append_mutation" }>): Promise<BackgroundResponse> {
    // The full SessionRecord stays inside the service worker. The response
    // returned to the content script is a pure ack — sending the session
    // record would leak `observation.last_observed_token` (the bearer token)
    // into the page's content-script context, where it has no business being.
    try {
      this.registry.appendMutation(message.session_id, message.mutation);
    } catch (error) {
      // Editing a field after its session was signed and uploaded starts a
      // continuation session that names the uploaded record as its parent.
      if (!(error instanceof SessionFrozenError) || error.state !== "uploaded") throw error;
      const continuation = this.registry.continueFrom(message.session_id);
      this.registry.appendMutation(continuation.session_id, message.mutation);
      await this.registry.persist();
      return { kind: "append_mutation_result", session_id: continuation.session_id };
    }
    await this.registry.persist();
    return { kind: "append_mutation_result" };
  }

  async #handleSign(message: Extract<ContentToBackground, { kind: "sign_session" }>): Promise<BackgroundResponse> {
    if (message.text_binding && this.registry.get(message.session_id)?.pending_observation_gap) {
      return { kind: "error", reason: "This draft has no captured edits since it was resumed. Make an edit before including the current text, or publish only its earlier editing activity." };
    }
    if (message.capture_context_redactions) {
      this.registry.redactCaptureContext(message.session_id, message.capture_context_redactions);
    }
    const result = await this.#runSignUpload(message.session_id, message.text_binding);
    return { kind: "sign_session_result", result };
  }

  async #handleRetry(message: Extract<ContentToBackground, { kind: "retry_failed_upload" }>): Promise<BackgroundResponse> {
    const existing = this.registry.get(message.session_id);
    if (!existing || existing.state !== "failed_upload") {
      return { kind: "retry_result", result: { kind: "failed", reason: "no_failed_upload_in_session" } };
    }
    const result = await this.#runSignUpload(message.session_id, existing.signed_text_binding);
    return { kind: "retry_result", result };
  }

  async #handleDiscard(message: Extract<ContentToBackground, { kind: "discard_session" }>): Promise<BackgroundResponse> {
    await this.registry.discardPersisted([message.session_id]);
    return { kind: "discard_result", ok: true };
  }

  async #runSignUpload(session_id: SessionRecord["session_id"], textBinding?: TextBinding): Promise<SignSessionResult> {
    try {
      const draft = this.registry.sign(session_id, textBinding ? { textBinding } : {});
      // Persist the confirmed finish before any checkpoint network await.
      await this.registry.persist();
      await this.registry.flushObservation(session_id);
      const observation = this.registry.getObservationEnvelope(session_id);
      const diverged = this.registry.getObservationState(session_id) === "diverged";
      this.registry.markUploading(session_id);
      // Save the frozen events and binding before a request can reach the
      // server. A terminated worker must retry this exact record, never offer
      // its already-submitted session for further editing.
      await this.registry.persist();
      const response = await this.#upload.postRecord({
        manifest: draft.manifest,
        events: draft.events,
        ...(observation ? { observation } : {}),
      });
      this.registry.markUploaded(session_id, response);
      await this.registry.persist();
      return {
        kind: "uploaded",
        response,
        ...(draft.manifest.text_binding ? { text_binding: draft.manifest.text_binding } : {}),
        ...(diverged ? { observation_note: DIVERGED_OBSERVATION_NOTE } : {}),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const live = this.registry.get(session_id);
      if (live && (live.state === "uploading" || live.state === "signing")) {
        this.registry.markFailedUpload(session_id, reason);
        if (error instanceof IngestUploadError && (error.code === "observation_mismatch" || error.code === "observation_unavailable")) {
          this.registry.markObservationRejected(session_id, error.code);
        }
      }
      await this.registry.persist();
      return { kind: "failed", reason };
    }
  }

}
