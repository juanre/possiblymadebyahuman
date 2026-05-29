import {
  verifyRecord,
  type BufferMutation,
  type TextBindingVerificationResult,
} from "../../../packages/format/src/index.ts";
import type { RecordApiResponse, VerificationState } from "./types.ts";

export type TimelinePoint = {
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

export function buildTimelinePoints(events: BufferMutation[]): TimelinePoint[] {
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

export function formatUtcMinute(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min} UTC`;
}

export function formatServerObservedSpan(ms: number): string {
  if (ms < 60_000) {
    const seconds = Math.max(1, Math.round(ms / 1000));
    return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  }
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes} ${totalMinutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (minutes === 0) return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  return `${hours} ${hours === 1 ? "hour" : "hours"} ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

// A prefix match over a very short bound text is weak evidence — many
// documents share a short opening — so the checker warns below this length.
export const SHORT_BINDING_CANONICAL_LENGTH = 64;

export const TEXT_BINDING_DISCLAIMER =
  "Compares letters and digits in order; ignores spacing, punctuation, case, and number formatting — it is not a check of exact text.";

export type BindingMatchSummary = {
  ok: boolean;
  headline: string;
  appendedCanonicalLength: number;
  short: boolean;
};

export function describeBindingMatch(result: TextBindingVerificationResult): BindingMatchSummary {
  if (!result.valid) {
    return { ok: false, headline: "These letters don't match what the author signed.", appendedCanonicalLength: 0, short: false };
  }
  const appended = result.appendedCanonicalLength ?? 0;
  const headline =
    appended > 0
      ? `Same wording as the signed text, followed by ${appended} more ${appended === 1 ? "character" : "characters"}.`
      : "Same wording as the signed text.";
  const short = result.policy === "prefix" && result.canonicalLength < SHORT_BINDING_CANONICAL_LENGTH;
  return { ok: true, headline, appendedCanonicalLength: appended, short };
}
