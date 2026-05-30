import type { CaptureContext, TextBinding } from "../../../../packages/format/src/index.ts";
import type {
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
    }
  | {
      kind: "append_mutation";
      session_id: SessionId;
      mutation: PendingMutation;
    }
  | { kind: "list_sessions" }
  | {
      kind: "sign_session";
      session_id: SessionId;
      capture_context_overrides?: Partial<CaptureContext>;
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
  | { kind: "uploaded"; response: IngestRecordResponse }
  | { kind: "failed"; reason: string };

export type BackgroundResponse =
  | { kind: "register_field_result"; result: RegisterFieldResult }
  | { kind: "append_mutation_result" }
  | { kind: "list_sessions_result"; sessions: SessionRecord[] }
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
