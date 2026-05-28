export const PRODUCER_CORE_PACKAGE = "@possiblymadebyahuman/producer-core";

export type {
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
  PendingMutation,
  ProducerIdentity,
  SessionId,
  SessionRecord,
  SessionState,
  SignedRecordDraft,
} from "./types.ts";

export { buildCaptureContext, redactCaptureContext, stripQueryAndHash } from "./capture-context.ts";
export { appendBufferMutation, durationMs } from "./timeline.ts";
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
  SessionFrozenError,
  SessionRegistry,
  UnknownSessionError,
} from "./registry.ts";
export type { SessionRegistryOptions } from "./registry.ts";
