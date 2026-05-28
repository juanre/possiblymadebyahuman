import type { CaptureContext } from "../../../../packages/format/src/index.ts";
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
    }
  | { kind: "retry_failed_upload"; session_id: SessionId }
  | { kind: "discard_session"; session_id: SessionId };

export type RegisterFieldResult =
  | { kind: "registered"; session_id: SessionId; certainty: SessionRecord["identity_certainty"] }
  | { kind: "ineligible"; reason: "non_empty_field_no_resumable_session" };

export type SignSessionResult =
  | { kind: "uploaded"; response: IngestRecordResponse }
  | { kind: "failed"; reason: string };

export type BackgroundResponse =
  | { kind: "register_field_result"; result: RegisterFieldResult }
  | { kind: "append_mutation_result"; session: SessionRecord }
  | { kind: "list_sessions_result"; sessions: SessionRecord[] }
  | { kind: "sign_session_result"; result: SignSessionResult }
  | { kind: "retry_result"; result: SignSessionResult }
  | { kind: "discard_result"; ok: true }
  | { kind: "error"; reason: string };

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
