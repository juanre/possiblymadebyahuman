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

export type ObservedSessionToken = string;

export type ObservationLocalState =
  | "disabled"
  | "unknown"
  | "known"
  | "partial"
  | "diverged";

export type ObservedCommitment = {
  checkpoint_id: string;
  event_count: number;
  chain_tip: B3Hash;
  observed_at: string;
};

export type ObservationFailure = {
  reason: string;
  status_or_kind: string;
};

export type SessionObservation = {
  state: ObservationLocalState;
  commitments: ObservedCommitment[];
  observed_session_id: string | null;
  last_observed_token: ObservedSessionToken | null;
  last_committed_event_count: number;
  last_attempt_at_wall_ms: number | null;
  last_failure: ObservationFailure | null;
  in_flight: boolean;
  queued: boolean;
  next_backoff_ms: number;
};

export type ObservationEnvelope = {
  observed_session_id: string;
  token: ObservedSessionToken;
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
  last_event_chain_tip: B3Hash | null;
  state: SessionState;
  uploaded_response?: IngestRecordResponse;
  last_failure_reason?: string;
  observation: SessionObservation;
};

export type SignedRecordDraft = {
  manifest: RecordManifest;
  events: BufferMutation[];
};
