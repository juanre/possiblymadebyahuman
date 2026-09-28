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
  delayFromPreviousMs: number;
};

export const LARGE_INSERT_CODEPOINTS = 50;

export type ActivityBin = { start: number; end: number; count: number };

// Pauses at least this long are cut out of the edit timeline's time axis and
// drawn as a short labelled break, so hours or days away do not squeeze the
// writing itself into slivers.
export const ELIDED_PAUSE_MS = 5 * 60_000;
// Beyond this many, only the longest pauses are cut; the rest stay to scale.
export const MAX_ELIDED_PAUSES = 12;
const MIN_SPAN_PX = 8;

export type TimeSpan = { start: number; end: number; x0: number; x1: number };
export type TimeAxis = { spans: TimeSpan[]; breaks: TimeSpan[]; width: number; x: (t: number) => number };

/**
 * Map session time onto a horizontal axis of the given width. Stretches of
 * writing share the width in proportion to their duration; each cut pause
 * takes a fixed break width regardless of its length.
 */
export function buildTimeAxis(times: readonly number[], endMs: number, width: number, breakWidth = 28): TimeAxis {
  const end = Math.max(0, endMs, times.at(-1) ?? 0);
  const boundaries = [0, ...times, end];
  const pauses: { start: number; end: number }[] = [];
  for (let index = 1; index < boundaries.length; index++) {
    const start = boundaries[index - 1]!, stop = boundaries[index]!;
    if (stop - start >= ELIDED_PAUSE_MS) pauses.push({ start, end: stop });
  }
  const cut = pauses
    .sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start)
    .slice(0, MAX_ELIDED_PAUSES)
    .sort((a, b) => a.start - b.start);

  let ranges: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const pause of cut) { ranges.push({ start: cursor, end: pause.start }); cursor = pause.end; }
  ranges.push({ start: cursor, end });
  // A cut wait at either end leaves an empty stretch with no edit in it.
  const firstTime = times[0], lastTime = times.at(-1);
  ranges = ranges.filter((range, index) => range.end > range.start
    || (index === 0 ? firstTime === range.start : index === ranges.length - 1 ? lastTime === range.end : true));

  const gapWidth = cut.length === 0 ? 0 : Math.min(breakWidth, width * 0.5 / cut.length);
  const available = Math.max(0, width - cut.length * gapWidth);
  const minSpan = ranges.length === 0 ? 0 : Math.min(MIN_SPAN_PX, available / ranges.length);
  const total = ranges.reduce((sum, range) => sum + (range.end - range.start), 0);
  const share = available - minSpan * ranges.length;

  const spans: TimeSpan[] = [];
  const breaks: TimeSpan[] = [];
  const items = [...ranges.map(range => ({ ...range, kind: "span" as const })), ...cut.map(pause => ({ ...pause, kind: "break" as const }))]
    .sort((a, b) => a.start - b.start || (a.kind === "break" ? 1 : -1));
  let x = 0;
  for (const item of items) {
    const itemWidth = item.kind === "break" ? gapWidth
      : minSpan + (total > 0 ? share * (item.end - item.start) / total : share / ranges.length);
    const placed = { start: item.start, end: item.end, x0: x, x1: x + itemWidth };
    (item.kind === "break" ? breaks : spans).push(placed);
    x += itemWidth;
  }

  const locate = (list: TimeSpan[], t: number) => list.find(item => t >= item.start && t <= item.end);
  const place = (item: TimeSpan, t: number) => item.end > item.start
    ? item.x0 + (t - item.start) / (item.end - item.start) * (item.x1 - item.x0)
    : (item.x0 + item.x1) / 2;
  return {
    spans,
    breaks,
    width,
    x(t: number) {
      const clamped = Math.min(end, Math.max(0, t));
      const item = locate(spans, clamped) ?? locate(breaks, clamped);
      return item ? place(item, clamped) : 0;
    },
  };
}

export type ActivityColumn = { start: number; end: number; count: number; x0: number; x1: number };

// Activity is independent of document-length inference. Columns about
// columnPx wide keep dense logs bounded, and none spans a cut pause.
export function buildActivityColumns(events: BufferMutation[], axis: TimeAxis, columnPx = 10): ActivityColumn[] {
  if (events.length === 0) return [];
  const groups = axis.spans.map(span => {
    const count = Math.max(1, Math.floor((span.x1 - span.x0) / columnPx));
    return Array.from({ length: count }, (_, index) => ({
      start: span.start + (span.end - span.start) * index / count,
      end: span.start + (span.end - span.start) * (index + 1) / count,
      count: 0,
      x0: span.x0 + (span.x1 - span.x0) * index / count,
      x1: span.x0 + (span.x1 - span.x0) * (index + 1) / count,
    }));
  });
  for (const event of events) {
    const spanIndex = Math.max(0, axis.spans.findIndex(span => event.t >= span.start && event.t <= span.end));
    const span = axis.spans[spanIndex]!;
    const columns = groups[spanIndex]!;
    const index = span.end > span.start ? Math.floor((event.t - span.start) / (span.end - span.start) * columns.length) : 0;
    columns[Math.min(columns.length - 1, Math.max(0, index))]!.count++;
  }
  return groups.flat();
}

export type TimeAxisLabel = { x: number; text: string; kind: "break" | "end" | "resume" | "tick"; left: number; right: number; anchor: "start" | "middle" | "end"; row: 0 | 1 };

const LABEL_CHAR_PX = 7;
const LABEL_GAP_PX = 12;
const TICK_SPACING_PX = 72;
const TICK_STEPS_SECONDS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];

function tickStepSeconds(minimumSeconds: number): number {
  const step = TICK_STEPS_SECONDS.find(candidate => candidate >= minimumSeconds);
  if (step !== undefined) return step;
  const days = minimumSeconds / 86400;
  const magnitude = 10 ** Math.floor(Math.log10(days));
  return 86400 * ([1, 2, 5, 10].map(factor => factor * magnitude).find(candidate => candidate >= days) ?? 10 * magnitude);
}

/**
 * Axis labels, in priority order: the length of each cut pause, the end of
 * the session, its start, the time writing resumed after each cut, then
 * regular ticks. A label is dropped when it would overlap one already placed,
 * except a pause length or the end of the session, which move to a second
 * row first.
 */
export function layoutTimeAxisLabels(axis: TimeAxis, options: { endPrefix?: string } = {}): TimeAxisLabel[] {
  const candidates: Omit<TimeAxisLabel, "left" | "right" | "anchor" | "row">[] = [];
  for (const gap of axis.breaks) candidates.push({ x: (gap.x0 + gap.x1) / 2, text: formatPauseLength(gap.end - gap.start), kind: "break" });
  const end = Math.max(0, ...axis.spans.map(span => span.end), ...axis.breaks.map(gap => gap.end));
  if (end > 0) candidates.push({ x: axis.x(end), text: `${options.endPrefix ?? ""}${formatTimelineTick(end / 1000)}`, kind: "end" });
  if (axis.spans[0]?.start === 0) candidates.push({ x: axis.x(0), text: formatTimelineTick(0), kind: "tick" });
  for (const span of axis.spans) {
    if (axis.breaks.some(gap => gap.end === span.start)) candidates.push({ x: axis.x(span.start), text: formatTimelineTick(span.start / 1000), kind: "resume" });
  }
  for (const span of axis.spans) {
    const widthPx = span.x1 - span.x0;
    const seconds = (span.end - span.start) / 1000;
    if (seconds <= 0 || widthPx <= 0) continue;
    const step = tickStepSeconds(seconds * TICK_SPACING_PX / widthPx);
    for (let tick = Math.ceil(span.start / 1000 / step) * step; tick * 1000 <= span.end; tick += step) {
      candidates.push({ x: axis.x(tick * 1000), text: formatTimelineTick(tick), kind: "tick" });
    }
  }
  const placed: TimeAxisLabel[] = [];
  for (const candidate of candidates) {
    const labelWidth = candidate.text.length * LABEL_CHAR_PX;
    let anchor: TimeAxisLabel["anchor"] = "middle";
    let left = candidate.x - labelWidth / 2;
    if (left < 0) { anchor = "start"; left = Math.max(0, candidate.x); }
    if (left + labelWidth > axis.width) { anchor = "end"; left = Math.min(candidate.x, axis.width) - labelWidth; }
    const rows: (0 | 1)[] = candidate.kind === "break" || candidate.kind === "end" ? [0, 1] : [0];
    for (const row of rows) {
      const label = { ...candidate, anchor, left, right: left + labelWidth, row };
      if (placed.some(other => (label.kind !== "break" && other.text === label.text) || (label.kind === "tick" && Math.abs(other.x - label.x) < 1))) break;
      if (placed.some(other => other.row === row && label.left < other.right + LABEL_GAP_PX && other.left < label.right + LABEL_GAP_PX)) continue;
      placed.push(label);
      break;
    }
  }
  return placed.sort((a, b) => a.x - b.x);
}

/** Elapsed session time for an axis tick. */
export function formatTimelineTick(seconds: number): string {
  if (seconds >= 86400) {
    const hours = Math.floor(seconds / 3600) % 24;
    return hours ? `${Math.floor(seconds / 86400)}d ${hours}h` : `${Math.floor(seconds / 86400)}d`;
  }
  if (seconds >= 3600) {
    const minutes = Math.floor(seconds / 60) % 60;
    return minutes ? `${Math.floor(seconds / 3600)}h ${minutes}m` : `${Math.floor(seconds / 3600)}h`;
  }
  // The end of a record shorter than a minute keeps its fraction of a second.
  if (seconds < 60 && !Number.isInteger(seconds)) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** The length of a cut pause, to the minute. */
export function formatPauseLength(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes / 60) % 24;
  if (days) return hours ? `${days}d ${hours}h` : `${days}d`;
  if (hours) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  return `${minutes}m`;
}

export function verifyRecordChain(record: RecordApiResponse): VerificationState {
  const result = verifyRecord({ manifest: record.manifest, events: record.events });
  return {
    ok: result.valid,
    messages: result.valid ? ["Hash chain verified against the full record hash."] : result.errors,
    computedRecordHash: result.computedRecordHash,
  };
}

/** A continuation's points start from its starting length, as the service computed it. */
export function buildTimelinePoints(events: BufferMutation[], startingLength: number | null = 0): TimelinePoint[] {
  let documentLength: number | null = startingLength;
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
export const RHYTHM_MAX_MS = 10_000;
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

export type DensityPoint = { ms: number; value: number };

const DENSITY_POINTS = 400;
const DENSITY_FINE_BINS = 800;
// Smoothing bandwidth, in decades of the log scale: between 0.04 (a gap about
// 10% longer or shorter) and 0.25 (about 78% longer).
const MIN_BANDWIDTH = 0.04;
const MAX_BANDWIDTH = 0.25;

/**
 * A smoothed distribution of the gaps between edits on the rhythm's log
 * scale, from RHYTHM_MIN_MS to RHYTHM_MAX_MS. Smoothing narrows as there are
 * more gaps (Silverman's rule), so long records show detail and short ones
 * stay readable. Values are in gaps per rhythm bucket, the unit of the
 * separate bars for gaps outside the scale. Gaps are first counted into fine
 * bins, so the cost does not grow with the length of the record.
 */
export function buildDelayDensity(events: BufferMutation[]): DensityPoint[] {
  const logMin = Math.log10(RHYTHM_MIN_MS);
  const span = Math.log10(RHYTHM_MAX_MS) - logMin;
  const fine = new Array<number>(DENSITY_FINE_BINS).fill(0);
  let n = 0, sum = 0, sumSquares = 0;
  for (let index = 1; index < events.length; index++) {
    const delay = events[index]!.t - events[index - 1]!.t;
    if (delay < RHYTHM_MIN_MS || delay > RHYTHM_MAX_MS) continue;
    const position = (Math.log10(delay) - logMin) / span;
    fine[Math.min(DENSITY_FINE_BINS - 1, Math.floor(position * DENSITY_FINE_BINS))]!++;
    const log = Math.log10(delay);
    n++; sum += log; sumSquares += log * log;
  }
  if (n === 0) return [];
  const centre = (index: number) => logMin + (index + 0.5) / DENSITY_FINE_BINS * span;
  const deviation = Math.sqrt(Math.max(0, sumSquares / n - (sum / n) ** 2));
  const quantile = (q: number) => {
    let seen = 0;
    for (let index = 0; index < fine.length; index++) {
      seen += fine[index]!;
      if (seen >= q * n) return centre(index);
    }
    return logMin + span;
  };
  const spread = Math.min(deviation, (quantile(0.75) - quantile(0.25)) / 1.34) || deviation;
  const bandwidth = Math.min(MAX_BANDWIDTH, Math.max(MIN_BANDWIDTH, 0.9 * spread * n ** -0.2));
  const bucketWidth = span / RHYTHM_BIN_COUNT;
  const normal = 1 / (bandwidth * Math.sqrt(2 * Math.PI));
  return Array.from({ length: DENSITY_POINTS }, (_, point) => {
    const log = logMin + span * point / (DENSITY_POINTS - 1);
    let density = 0;
    for (let index = 0; index < fine.length; index++) {
      if (fine[index] === 0) continue;
      const u = (log - centre(index)) / bandwidth;
      if (u > -5 && u < 5) density += fine[index]! * Math.exp(-0.5 * u * u);
    }
    return { ms: 10 ** log, value: density * normal * bucketWidth };
  });
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
  return ms === null ? "not measured" : formatDuration(ms);
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

type SummarySource = Pick<RecordApiResponse, "manifest" | "stats" | "observation">;

const countFormat = new Intl.NumberFormat("en-US");

function plural(count: number, one: string, many: string): string {
  return `${countFormat.format(count)} ${count === 1 ? one : many}`;
}

function readableDuration(ms: number): string | null {
  return ms < 1000 ? null : formatServerObservedSpan(ms);
}

// A duration is signed when the record seals its finish time; older formats
// carry a producer-reported duration, which is presented as an estimate.
function durationPhrase(record: SummarySource): string {
  const signed = record.manifest.format_version === "0.3";
  const duration = readableDuration(record.manifest.duration_ms);
  if (duration === null) return signed ? "in under a second" : "in under a second (estimated)";
  return signed ? `over ${duration}` : `over an estimated ${duration}`;
}

function publishedDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" });
}

export function formatCharacters(count: number | null): string {
  return count === null ? "not measured" : plural(count, "character", "characters");
}

/**
 * A descriptive one-sentence account of the record, with no evaluation: the
 * span of the writing and when it was published. The measurements themselves
 * are in the facts beside it.
 */
export function describeRecordSummary(record: SummarySource): string {
  const written = `Written ${durationPhrase(record)}`;
  const date = publishedDate(record.manifest.ingested_server_t);
  return `${written}${date ? ` and published ${date}` : ""}.`;
}

/** What the server saw while the record was written, in one sentence. */
export function describeObservation(observation: Pick<RecordApiResponse["observation"], "state" | "checkpoint_count" | "server_observed_span_ms">): string {
  const count = plural(observation.checkpoint_count, "checkpoint", "checkpoints");
  const span = observation.server_observed_span_ms;
  const received = `The server received ${count}${span !== null && span >= 1000 ? ` over ${formatServerObservedSpan(span)}` : ""}`;
  switch (observation.state) {
    case "observed": return `${received} while it was written.`;
    case "partial": return `${received}, covering only part of the writing.`;
    case "unobserved": return "The server received no checkpoints while it was written.";
    default: return "The writing tool did not send the server checkpoints.";
  }
}

export type RecordFact = { label: string; value: string };

// Writing time is the time between the first and last edit, leaving out
// pauses of 30 seconds or more; the span in the summary sentence includes them.
export function recordFacts(record: SummarySource): RecordFact[] {
  const stats = record.stats;
  const binding = record.manifest.text_binding;
  return [
    { label: "Writing time", value: readableDuration(stats.active_time_ms) ?? "under a second" },
    { label: "Edits", value: countFormat.format(stats.event_count) },
    { label: "Deleted", value: formatCharacters(stats.deleted_codepoints_total) },
    { label: "Pastes", value: stats.paste_event_count === 0 ? "none" : countFormat.format(stats.paste_event_count) },
    { label: "Largest insertion", value: formatCharacters(stats.largest_atomic_insert_codepoints) },
    { label: "Length", value: formatCharacters(stats.observed_final_length) },
    ...(binding ? [{ label: "Signed text", value: formatSignedTextLength(binding.canonical_length) }] : []),
  ];
}

/** Bound text is measured in the canonical form: letters and digits only. */
export function formatSignedTextLength(count: number): string {
  return count === 1 ? "1 letter or digit" : `${countFormat.format(count)} letters and digits`;
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
