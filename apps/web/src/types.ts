import type { BufferMutation, RecordManifest, Signal } from "../../../packages/format/src/index.ts";
import type { RecordObservation, RecordStats } from "../../../packages/storage/src/index.ts";

export type RecordApiResponse = {
  manifest: RecordManifest;
  events: BufferMutation[];
  /** Endpoint times supplied separately when history is paged. */
  event_times?: { first: number; last: number };
  stats: RecordStats;
  signals: Signal[];
  observation: RecordObservation;
};

export type VerificationState = {
  ok: boolean;
  pending?: boolean;
  messages: string[];
  computedRecordHash?: string;
};
