import {
  verifyRecord,
  verifyTextBindingCandidate,
  type BufferMutation,
  type TextBinding,
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

export type ActivityBin = { start: number; end: number; count: number };

// Activity is independent of document-length inference. A bounded histogram
// remains useful for legacy rich-text records and very dense event logs.
export function buildActivityBins(events: BufferMutation[], durationMs: number, maxBins = 80): ActivityBin[] {
  if (events.length === 0) return [];
  const duration = Math.max(1, durationMs, events.at(-1)?.t ?? 0);
  const count = Math.max(1, Math.min(200, Math.floor(maxBins) || 1));
  const bins = Array.from({ length: count }, (_, i) => ({
    start: duration * i / count, end: duration * (i + 1) / count, count: 0,
  }));
  for (const event of events) {
    const index = Math.min(count - 1, Math.max(0, Math.floor(event.t / duration * count)));
    bins[index]!.count++;
  }
  return bins;
}

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
    // Mirrors computeObservedLength in packages/format: once an event reaches
    // beyond the length inferable from the captured events (a capture that
    // started inside a non-empty buffer), the length is unknown from then on.
    if (documentLength === null || event.pos === null || event.del_len === null || event.ins_len === null) {
      documentLength = null;
    } else if (event.pos > documentLength || event.pos + event.del_len > documentLength) {
      documentLength = null;
    } else {
      documentLength = documentLength - event.del_len + event.ins_len;
    }
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

export type LengthStepPoint = { t: number; length: number };

/** Hold each observed length until the next edit, then change it at that edit. */
export function buildLengthStepPoints(points: TimelinePoint[]): LengthStepPoint[] {
  const steps: LengthStepPoint[] = [];
  for (const point of points) {
    // A missing measurement can include edits during an unobserved absence.
    // End at the last known edit instead of extending into that unknown gap.
    if (point.documentLength === null) break;
    const previous = steps.at(-1);
    if (previous) steps.push({ t: point.t, length: previous.length });
    steps.push({ t: point.t, length: point.documentLength });
  }
  return steps;
}

export const RHYTHM_MIN_MS = 16;
export const RHYTHM_MAX_MS = 100_000;
export const RHYTHM_BIN_COUNT = 40;

/** Separate out-of-range gaps instead of clamping them onto the log axis. */
export function buildDelayHistogram(events: BufferMutation[]): {
  bins: ActivityBin[]; underflow: number; overflow: number; total: number;
} {
  const logMin = Math.log10(RHYTHM_MIN_MS);
  const span = Math.log10(RHYTHM_MAX_MS) - logMin;
  const bins = Array.from({ length: RHYTHM_BIN_COUNT }, (_, index) => ({
    start: 10 ** (logMin + span * index / RHYTHM_BIN_COUNT),
    end: 10 ** (logMin + span * (index + 1) / RHYTHM_BIN_COUNT),
    count: 0,
  }));
  let underflow = 0, overflow = 0;
  for (let index = 1; index < events.length; index++) {
    const delay = events[index]!.t - events[index - 1]!.t;
    if (delay < RHYTHM_MIN_MS) underflow++;
    else if (delay > RHYTHM_MAX_MS) overflow++;
    else bins[Math.min(RHYTHM_BIN_COUNT - 1, Math.floor((Math.log10(delay) - logMin) / span * RHYTHM_BIN_COUNT))]!.count++;
  }
  return { bins, underflow, overflow, total: Math.max(0, events.length - 1) };
}

/** Endpoint waits are distinct from intervals between captured edits. */
export function recordTimingDetails(record: Pick<RecordApiResponse, "manifest" | "events" | "event_times">): {
  signedFinish: boolean; editingSpanMs: number; beforeFirstEditMs: number; afterLastEditMs: number;
} {
  const first = record.event_times?.first ?? record.events[0]?.t ?? 0;
  const last = record.event_times?.last ?? record.events.at(-1)?.t ?? 0;
  return {
    signedFinish: record.manifest.format_version === "0.3",
    editingSpanMs: Math.max(0, last - first),
    beforeFirstEditMs: first,
    afterLastEditMs: Math.max(0, record.manifest.duration_ms - last),
  };
}

export function timelineLengthScale(points: TimelinePoint[], observedFinalLength: number | null): number {
  const largestKnown = points.reduce((largest, point) => Math.max(largest, point.documentLength ?? 0), 0);
  return Math.max(1, largestKnown, observedFinalLength ?? 0);
}

export function formatDelayMs(ms: number | null): string {
  return ms === null ? "n/a" : formatDuration(ms);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const totalSeconds = Math.round(seconds);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor(totalSeconds / 3600) % 24;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const remainder = totalSeconds % 60;
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
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
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const rest = hours % 24;
    return `${days} ${days === 1 ? "day" : "days"}${rest ? ` ${rest} ${rest === 1 ? "hour" : "hours"}` : ""}`;
  }
  const minutes = totalMinutes % 60;
  if (minutes === 0) return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  return `${hours} ${hours === 1 ? "hour" : "hours"} ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

// A match over a very short bound text is weak evidence — many documents can
// share a short run — so the checker warns below this length.
export const SHORT_BINDING_CANONICAL_LENGTH = 64;

export const TEXT_BINDING_DISCLAIMER =
  "Compares letters and digits in order; ignores spacing, punctuation, case, and number formatting. It is not a check of exact text.";

export type BindingCheckResult = {
  ok: boolean;
  kind: "exact" | "trailing" | "leading" | "surrounding" | "none";
  leadingCount: number;
  trailingCount: number;
  canonicalLength: number;
};

// Bounded edge-window checking: the signed wording may be the whole canonical
// candidate, near the start, or near the end. The shared format checker tests
// windows up to 160 canonical characters from either edge — never an unbounded
// interior substring search.
export function checkCandidateAgainstBinding(
  binding: TextBinding,
  candidateText: string,
  sessionId: string,
): BindingCheckResult {
  const length = binding.canonical_length;
  const base = verifyTextBindingCandidate(binding, candidateText, sessionId);
  if (!base.valid) return { ok: false, kind: "none", leadingCount: 0, trailingCount: 0, canonicalLength: length };
  const leading = base.leadingCanonicalLength ?? 0;
  const trailing = base.trailingCanonicalLength ?? 0;
  let kind: BindingCheckResult["kind"] = "exact";
  if (leading > 0 && trailing > 0) kind = "surrounding";
  else if (leading > 0) kind = "leading";
  else if (trailing > 0) kind = "trailing";
  return { ok: true, kind, leadingCount: leading, trailingCount: trailing, canonicalLength: length };
}

export type BindingMatchSummary = { ok: boolean; headline: string; short: boolean };

export function describeBindingMatch(result: BindingCheckResult): BindingMatchSummary {
  if (!result.ok) {
    return { ok: false, headline: "These letters don't match what the author signed.", short: false };
  }
  let headline: string;
  if (result.kind === "trailing") {
    headline = `Same wording as the signed text, plus ${result.trailingCount} more ${result.trailingCount === 1 ? "character" : "characters"} after it (for example an appended signature line).`;
  } else if (result.kind === "leading") {
    headline = `Same wording as the signed text, with ${result.leadingCount} more ${result.leadingCount === 1 ? "character" : "characters"} before it (for example a quoted header).`;
  } else if (result.kind === "surrounding") {
    headline = `Same wording as the signed text, with ${result.leadingCount} more ${result.leadingCount === 1 ? "character" : "characters"} before it and ${result.trailingCount} more ${result.trailingCount === 1 ? "character" : "characters"} after it.`;
  } else {
    headline = "Same wording as the signed text.";
  }
  // A match on very little text is weak evidence whether it is a whole, leading,
  // or trailing match — many documents share a short run of letters/digits (and
  // short numeric forms collide once formatting is dropped) — so warn on any
  // short successful match, not only edge ones.
  const short = result.canonicalLength < SHORT_BINDING_CANONICAL_LENGTH;
  return { ok: true, headline, short };
}
