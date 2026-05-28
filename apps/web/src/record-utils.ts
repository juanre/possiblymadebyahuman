import { verifyRecord, type BufferMutation } from "../../../packages/format/src/index.ts";
import type { RecordApiResponse, VerificationState } from "./types.ts";

export type ReplayPoint = {
  seq: number;
  t: number;
  pos: number | null;
  del_len: number | null;
  ins_len: number | null;
  source: string;
  documentLength: number | null;
  isLargeInsert: boolean;
  isLongPause: boolean;
  delayFromPreviousMs: number;
};

export const LARGE_INSERT_CODEPOINTS = 50;
export const LONG_PAUSE_MS = 30_000;

export function verifyRecordChain(record: RecordApiResponse): VerificationState {
  const result = verifyRecord({ manifest: record.manifest, events: record.events });
  return {
    ok: result.valid,
    messages: result.valid ? ["Hash chain verified against the full record hash."] : result.errors,
    computedRecordHash: result.computedRecordHash,
  };
}

export function buildReplayPoints(events: BufferMutation[]): ReplayPoint[] {
  let documentLength: number | null = 0;
  let previousT = 0;
  return events.map((event) => {
    const delayFromPreviousMs = event.seq === 0 ? 0 : event.t - previousT;
    previousT = event.t;
    documentLength =
      documentLength === null || event.del_len === null || event.ins_len === null
        ? null
        : Math.max(0, documentLength - event.del_len + event.ins_len);
    return {
      seq: event.seq,
      t: event.t,
      pos: event.pos,
      del_len: event.del_len,
      ins_len: event.ins_len,
      source: event.source,
      documentLength,
      isLargeInsert: (event.ins_len ?? 0) >= LARGE_INSERT_CODEPOINTS,
      isLongPause: delayFromPreviousMs >= LONG_PAUSE_MS,
      delayFromPreviousMs,
    };
  });
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

export function sourceClass(source: string): string {
  return `source-${source.replace(/[^a-z0-9_-]/gi, "-")}`;
}
