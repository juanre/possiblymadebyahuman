import type {
  B3Hash,
  BufferMutation,
  Capability,
  CaptureContext,
  FormatVersion,
  Operation,
  RecordManifest,
  Source,
} from "../../format/src/index.ts";

export type SessionId = string;

export type IdentityCertainty = "fresh" | "resumed" | "degraded" | "collision";

export type SessionState =
  | "active"
  | "signing"
  | "uploading"
  | "uploaded"
  | "failed_upload";

export type FieldOrigin = {
  origin: string;
  path: string;
  tab_id: number;
  frame_id: number;
};

export type FieldDescriptor = {
  tag_name: "TEXTAREA" | "INPUT" | "CONTENTEDITABLE";
  field_kind: string;
  name: string | null;
  id: string | null;
  aria_label: string | null;
  nearest_form_id: string | null;
  dom_signature: string;
  index_among_similar: number;
};

export type PendingMutation = {
  op: Operation;
  pos: number | null;
  del_len: number | null;
  ins_len: number | null;
  source: Source;
};

export type IngestRecordResponse = {
  record_hash: B3Hash;
  short_signature: string;
  url: string;
  created: boolean;
};

export type IngestRecordInput = {
  manifest: RecordManifest;
  events: BufferMutation[];
};

export type ProducerIdentity = {
  id: string;
  version: string;
  capabilities: Capability[];
};

export type SessionRecord = {
  session_id: SessionId;
  format_version: FormatVersion;
  base_wall_ms: number;
  last_edit_wall_ms: number;
  origin: FieldOrigin;
  descriptor: FieldDescriptor;
  identity_certainty: IdentityCertainty;
  producer: ProducerIdentity;
  capture_context: CaptureContext;
  events: BufferMutation[];
  state: SessionState;
  uploaded_response?: IngestRecordResponse;
  last_failure_reason?: string;
};

export type SignedRecordDraft = {
  manifest: RecordManifest;
  events: BufferMutation[];
};
