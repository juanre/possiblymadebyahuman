import type { CaptureContext } from "../../../../packages/format/src/index.ts";
import { SessionRegistry, buildCaptureContext } from "../../../../packages/producer-core/src/index.ts";
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
import { isFieldEligible } from "./policy.ts";

export interface DispatcherOptions {
  clock: ClockAdapter;
  uuid: UuidAdapter;
  storage: StorageAdapter;
  upload: UploadAdapter;
  checkpoint: CheckpointAdapter;
  producer: ProducerIdentity;
}

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
    });
    this.#upload = options.upload;
  }

  ensureInitialised(): Promise<void> {
    if (!this.#initPromise) this.#initPromise = this.registry.init();
    return this.#initPromise;
  }

  async handle(message: ContentToBackground): Promise<BackgroundResponse> {
    await this.ensureInitialised();
    try {
      switch (message.kind) {
        case "register_field":
          return this.#handleRegister(message);
        case "append_mutation":
          return this.#handleAppend(message);
        case "list_sessions":
          return { kind: "list_sessions_result", sessions: this.registry.list() };
        case "sign_session":
          return await this.#handleSign(message);
        case "retry_failed_upload":
          return await this.#handleRetry(message);
        case "discard_session":
          return this.#handleDiscard(message);
      }
    } catch (error) {
      return { kind: "error", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  #handleRegister(message: Extract<ContentToBackground, { kind: "register_field" }>): BackgroundResponse {
    const origin = {
      origin: message.origin_url,
      path: message.page_path,
      tab_id: message.tab_id,
      frame_id: message.frame_id,
    };
    const eligibility = isFieldEligible({
      origin,
      descriptor: message.descriptor,
      field_is_empty: message.field_is_empty,
      existing_sessions: this.registry.list(),
    });
    if (!eligibility.eligible) {
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
    const session = this.registry.findOrCreate(origin, message.descriptor, capture);
    void this.registry.persist();
    return {
      kind: "register_field_result",
      result: { kind: "registered", session_id: session.session_id, certainty: session.identity_certainty },
    };
  }

  #handleAppend(message: Extract<ContentToBackground, { kind: "append_mutation" }>): BackgroundResponse {
    const session = this.registry.appendMutation(message.session_id, message.mutation);
    void this.registry.persist();
    return { kind: "append_mutation_result", session };
  }

  async #handleSign(message: Extract<ContentToBackground, { kind: "sign_session" }>): Promise<BackgroundResponse> {
    const result = await this.#runSignUpload(message.session_id, message.capture_context_overrides);
    return { kind: "sign_session_result", result };
  }

  async #handleRetry(message: Extract<ContentToBackground, { kind: "retry_failed_upload" }>): Promise<BackgroundResponse> {
    const existing = this.registry.get(message.session_id);
    if (!existing || existing.state !== "failed_upload") {
      return { kind: "retry_result", result: { kind: "failed", reason: "no_failed_upload_in_session" } };
    }
    // v0 retry is opt-in via discard + fresh start. Producer-core does not
    // memoize the signed draft, so a true in-place retry would require
    // re-signing — but the session is no longer `active` once it has reached
    // `failed_upload`. The popup surfaces this honestly as "Discard and
    // continue typing to start a fresh session" rather than pretending a
    // one-click retry works.
    return { kind: "retry_result", result: { kind: "failed", reason: "retry_requires_discard_and_resign" } };
  }

  #handleDiscard(message: Extract<ContentToBackground, { kind: "discard_session" }>): BackgroundResponse {
    this.registry.discard(message.session_id);
    void this.registry.persist();
    return { kind: "discard_result", ok: true };
  }

  async #runSignUpload(session_id: SessionRecord["session_id"], overrides?: Partial<CaptureContext>): Promise<SignSessionResult> {
    try {
      await this.registry.flushObservation(session_id);
      const draft = this.registry.sign(session_id);
      if (overrides && draft.manifest.capture_context) {
        draft.manifest.capture_context = { ...draft.manifest.capture_context, ...overrides };
      }
      const observation = this.registry.getObservationEnvelope(session_id);
      this.registry.markUploading(session_id);
      const response = await this.#upload.postRecord({
        manifest: draft.manifest,
        events: draft.events,
        ...(observation ? { observation } : {}),
      });
      this.registry.markUploaded(session_id, response);
      await this.registry.persist();
      return { kind: "uploaded", response };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const live = this.registry.get(session_id);
      if (live && live.state === "uploading") this.registry.markFailedUpload(session_id, reason);
      await this.registry.persist();
      return { kind: "failed", reason };
    }
  }

}
