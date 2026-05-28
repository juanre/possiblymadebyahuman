import type { IngestRecordInput, IngestRecordResponse, SessionId, SessionRecord } from "./types.ts";

export interface StorageAdapter {
  read(): Promise<SessionRecord[]>;
  write(snapshot: SessionRecord[]): Promise<void>;
}

export interface UploadAdapter {
  postRecord(payload: IngestRecordInput): Promise<IngestRecordResponse>;
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
