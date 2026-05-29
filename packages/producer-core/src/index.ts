export const PRODUCER_CORE_PACKAGE = "@possiblymadebyahuman/producer-core";

export type {
  CheckpointAdapter,
  CheckpointFailureKind,
  CheckpointRequest,
  CheckpointResponse,
  CheckpointResult,
  ClipboardAdapter,
  ClockAdapter,
  StorageAdapter,
  UploadAdapter,
  UuidAdapter,
} from "./adapters.ts";

export type {
  FieldDescriptor,
  FieldOrigin,
  IdentityCertainty,
  IngestRecordInput,
  IngestRecordResponse,
  ObservationEnvelope,
  ObservationFailure,
  ObservationLocalState,
  ObservationUploadRequest,
  ObservedCommitment,
  ObservedSessionToken,
  PendingMutation,
  ProducerIdentity,
  SessionId,
  SessionObservation,
  SessionRecord,
  SessionState,
  SignedRecordDraft,
  SignOptions,
} from "./types.ts";

export { buildCaptureContext, redactCaptureContext, stripQueryAndHash } from "./capture-context.ts";
export { advanceChain, appendBufferMutation, durationMs } from "./timeline.ts";
export {
  DEFAULT_TTL_MS,
  DEFAULT_UPLOADED_GRACE_MS,
  sweepExpired,
} from "./ttl.ts";
export type { SweepOptions, SweepResult } from "./ttl.ts";
export {
  isExactDescriptorMatch,
  isPartialDescriptorMatch,
  resolveSession,
} from "./session-id.ts";
export type { IdentityResolution } from "./session-id.ts";
export {
  DEFAULT_CADENCE_EVERY_MS,
  DEFAULT_CADENCE_EVERY_N_EVENTS,
  DEFAULT_CHECKPOINT_BACKOFF_INITIAL_MS,
  DEFAULT_CHECKPOINT_BACKOFF_MAX_MS,
  DEFAULT_COMMITMENT_RETENTION,
  SessionFrozenError,
  SessionRegistry,
  UnknownSessionError,
} from "./registry.ts";
export type { CadenceOptions, SessionRegistryOptions } from "./registry.ts";
