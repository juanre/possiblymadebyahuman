import type { TextBinding } from "../../../../packages/format/src/index.ts";
import type {
  CaptureContextRedactions,
  FieldDescriptor,
  FieldOrigin,
  IngestRecordResponse,
  PendingMutation,
  SessionId,
  SessionRecord,
} from "../../../../packages/producer-core/src/index.ts";

export type ContentToBackground =
  | {
      kind: "register_field";
      tab_id: number;
      frame_id: number;
      origin_url: string;
      page_path: string;
      page_title: string;
      descriptor: FieldDescriptor;
      field_is_empty: boolean;
      activation_id?: string;
      share_session_id?: string;
    }
  | {
      kind: "append_mutation";
      session_id: SessionId;
      mutation: PendingMutation;
    }
  | { kind: "list_sessions" }
  | { kind: "start_focused_editor"; share_session_id?: string }
  | { kind: "prepare_finish"; session_id: string; bind: boolean }
  | { kind: "stop_session"; session_id: string }
  | {
      kind: "sign_session";
      session_id: SessionId;
      // The signer's review of what provenance context to publish.
      capture_context_redactions?: CaptureContextRedactions;
      // Content-blind binding object computed in the content script (the only
      // context that holds field text). Never the text itself.
      text_binding?: TextBinding;
    }
  | { kind: "retry_failed_upload"; session_id: SessionId }
  | { kind: "discard_session"; session_id: SessionId };

/**
 * Popup -> content-script channel (via chrome.tabs.sendMessage), used at sign
 * time to compute the content-blind text binding in the only context that can
 * read the field. The request carries no text; the response carries only the
 * sealed binding object (or null when the field has nothing bindable). The
 * field text is read transiently inside the content-script handler and never
 * retained, messaged onward, or stored.
 */
export type ComputeBindingRequest = {
  kind: "compute_binding";
  session_id: SessionId;
};

export type ComputeBindingResponse =
  | { kind: "binding_result"; text_binding: TextBinding | null }
  | { kind: "binding_error"; reason: string };

export function isComputeBindingRequest(value: unknown): value is ComputeBindingRequest {
  return !!value && typeof value === "object" && (value as { kind?: unknown }).kind === "compute_binding";
}

export type RegisterFieldResult =
  | { kind: "registered"; session_id: SessionId; certainty: SessionRecord["identity_certainty"] }
  | { kind: "ineligible"; reason: "non_empty_field_no_resumable_session" };

export type SignSessionResult =
  // observation_note explains, for the signer, when the record was uploaded
  // without server observation although observation had been requested.
  | { kind: "uploaded"; response: IngestRecordResponse; observation_note?: string }
  | { kind: "failed"; reason: string };

export type BackgroundResponse =
  | { kind: "register_field_result"; result: RegisterFieldResult }
  // session_id is present when the edit started a continuation session and the
  // content script must record further edits under that id.
  | { kind: "append_mutation_result"; session_id?: SessionId }
  | { kind: "list_sessions_result"; sessions: SessionRecord[]; capture_status?: Record<string, "active" | "stopped" | "legacy">; selected_session_id?: string; last_start_error?: string }
  | { kind: "start_editor_result"; session_id?: string; reason?: string }
  | { kind: "prepare_finish_result"; text_binding: TextBinding | null; reason?: string }
  | { kind: "stop_session_result"; ok: true }
  | { kind: "sign_session_result"; result: SignSessionResult }
  | { kind: "retry_result"; result: SignSessionResult }
  | { kind: "discard_result"; ok: true }
  | { kind: "error"; reason: string };

/**
 * Responses that may be returned to a content-script context. These MUST NOT
 * carry the bearer `observation.last_observed_token` or any field from
 * `SessionRecord.observation`. The content script forwards only register_field
 * and append_mutation messages, so only these two response kinds are reachable
 * from a content-script context. A recursive regression test
 * (`tests/browser-extension-canary.test.mjs`) asserts that no string equal to
 * the bearer token and no key named `last_observed_token` ever appears in a
 * response of one of these kinds.
 */
export const CONTENT_SCRIPT_REACHABLE_RESPONSE_KINDS = [
  "register_field_result",
  "append_mutation_result",
  "error",
] as const satisfies ReadonlyArray<BackgroundResponse["kind"]>;

export const MESSAGE_KINDS = [
  "register_field",
  "append_mutation",
  "start_focused_editor",
  "prepare_finish",
  "stop_session",
  "list_sessions",
  "sign_session",
  "retry_failed_upload",
  "discard_session",
] as const satisfies ReadonlyArray<ContentToBackground["kind"]>;

export function isContentMessage(value: unknown): value is ContentToBackground {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === "string" && (MESSAGE_KINDS as readonly string[]).includes(kind);
}

export type FieldOriginInput = Pick<FieldOrigin, "origin" | "path" | "tab_id" | "frame_id">;
