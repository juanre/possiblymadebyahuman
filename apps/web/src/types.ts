import type { BufferMutation, RecordManifest, Signal } from "../../../packages/format/src/index.ts";
import type { RecordStats } from "../../../packages/storage/src/index.ts";

export type RecordApiResponse = {
  manifest: RecordManifest;
  events: BufferMutation[];
  stats: RecordStats;
  signals: Signal[];
};

export type VerificationState = {
  ok: boolean;
  messages: string[];
  computedRecordHash?: string;
};
