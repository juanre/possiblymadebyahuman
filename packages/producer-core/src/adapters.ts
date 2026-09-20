import type { B3Hash } from "../../format/src/index.ts";
import type { IngestRecordInput, IngestRecordResponse, ObservedSessionToken, SessionId, SessionRecord } from "./types.ts";

export interface StorageAdapter {
  read(): Promise<SessionRecord[]>;
  write(snapshot: SessionRecord[]): Promise<void>;
}

export interface UploadAdapter {
  postRecord(payload: IngestRecordInput): Promise<IngestRecordResponse>;
}

/**
 * A rejected `POST /api/records`. `code` is the API's `error` field
 * (`observation_mismatch`, `observation_unavailable`, ...) when the body
 * carried one, so callers can act on it without parsing the message.
 */
export class IngestUploadError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = "IngestUploadError";
    this.status = status;
    this.code = code;
  }
}

export interface ClockAdapter {
  now(): number;
}

export interface UuidAdapter {
  uuid(): SessionId;
}

export interface ClipboardAdapter {
  writeText(value: string): Promise<void>;
}

export type CheckpointRequest = {
  observed_session_id: string;
  event_count: number;
  chain_tip: B3Hash;
  token: ObservedSessionToken | null;
};

export type CheckpointResponse = {
  observed_session_id: string;
  token: ObservedSessionToken;
  checkpoint_id: string;
  event_count: number;
  chain_tip: B3Hash;
  server_t: string;
  created: boolean;
};

export type CheckpointFailureKind =
  | "unavailable"
  | "conflict"
  | "rate_limited"
  | "client_bug"
  | "transient";

export type CheckpointResult =
  | { ok: true; response: CheckpointResponse }
  | { ok: false; kind: CheckpointFailureKind; status: number; reason: string };

export interface CheckpointAdapter {
  postCheckpoint(request: CheckpointRequest): Promise<CheckpointResult>;
}
