import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Signal } from "../../../packages/format/src/index.ts";
import type { ObservationCommitment, RecordObservation } from "../../../packages/storage/src/index.ts";
import { buildActivityBins, buildDelayHistogram, buildLengthStepPoints, recordTimingDetails, RHYTHM_MIN_MS, RHYTHM_MAX_MS, buildTimelinePoints, checkCandidateAgainstBinding, describeBindingMatch, formatDelayMs, formatDuration, formatServerObservedSpan, formatUtcMinute, TEXT_BINDING_DISCLAIMER, timelineLengthScale, verifyRecordChain, type BindingCheckResult } from "./record-utils.ts";
import type { RecordApiResponse, VerificationState } from "./types.ts";

export function DisclaimerBanner() {
  return (
    <section className="banner" aria-label="What this record means">
      <strong>This is a signed writing record.</strong>
      <span> It shows the shape of an editing process. It does not prove who originated the ideas, and it is not a human/AI score.</span>
    </section>
  );
}

// Prefer checkpoint receipt times. Without them, show the upload time and an
// explicitly inferred start based on the producer's claimed duration.
function recordTimingWindow(record: RecordApiResponse): { began: string; ended: string; estimated: boolean } | null {
  const observation = record.observation;
  if (observation.first_observed_at && observation.last_observed_at) {
    return { began: observation.first_observed_at, ended: observation.last_observed_at, estimated: false };
  }
  const ingested = record.manifest.ingested_server_t;
  if (ingested) {
    const ended = new Date(ingested).getTime();
    const began = new Date(ended - record.manifest.duration_ms);
    if (!Number.isFinite(ended) || !Number.isFinite(began.getTime())) return null;
    return {
      began: began.toISOString(),
      ended: new Date(ended).toISOString(),
      estimated: true,
    };
  }
  return null;
}

export function CaptureContextSummary({ record }: { record: RecordApiResponse }) {
  const context = record.manifest.capture_context;
  const timing = recordTimingWindow(record);
  const timingRows = timing ? (
    <>
      <dt>{timing.estimated ? "Start inferred from upload and claimed duration" : "First checkpoint received"}</dt><dd><UtcInstant iso={timing.began} /></dd>
      <dt>{timing.estimated ? "Uploaded" : "Last checkpoint received"}</dt><dd><UtcInstant iso={timing.ended} /></dd>
    </>
  ) : null;
  if (!context) {
    return (
      <section className="card">
        <h2>Capture context</h2>
        {timingRows ? <dl className="details">{timingRows}</dl> : <p className="muted">No capture context was included.</p>}
      </section>
    );
  }
  return (
    <section className="card">
      <h2>Capture context</h2>
      <dl className="details">
        {context.surface && <><dt>Surface</dt><dd>{String(context.surface)}</dd></>}
        {context.label && <><dt>Label</dt><dd>{String(context.label)}</dd></>}
        {context.browser?.url && <><dt>URL</dt><dd>{context.browser.url}</dd></>}
        {context.browser?.title && <><dt>Page title</dt><dd>{context.browser.title}</dd></>}
        {context.browser?.field_kind && <><dt>Field</dt><dd>{context.browser.field_kind}</dd></>}
        {context.emacs?.buffer_name && <><dt>Buffer</dt><dd>{context.emacs.buffer_name}</dd></>}
        {context.emacs?.major_mode && <><dt>Major mode</dt><dd>{context.emacs.major_mode}</dd></>}
        {timingRows}
      </dl>
    </section>
  );
}

export function QuickStatsPanel({ record }: { record: RecordApiResponse }) {
  const stats = record.stats;
  const timing = recordTimingDetails(record);
  return (
    <section className="card">
      <h2>Quick facts</h2>
      <div className="stats-grid">
        <Stat label="Events" value={stats.event_count} />
        <Stat label={timing.signedFinish ? "Signed duration" : "Reported duration"} value={formatDuration(stats.duration_ms)} />
        <Stat label="Editing span" value={formatDuration(timing.editingSpanMs)} />
        <Stat label="Observed length" value={stats.observed_final_length === null ? "unknown" : `${stats.observed_final_length} codepoints`} />
        <Stat label="Typing events" value={stats.typed_event_count} />
        <Stat label="Insert / delete / replace" value={`${stats.insert_op_count} / ${stats.delete_op_count} / ${stats.replace_op_count}`} />
        <Stat label="Paste / unknown" value={`${stats.paste_event_count} / ${stats.unknown_source_count}`} />
        <Stat label="Largest atomic insert" value={`${stats.largest_atomic_insert_codepoints} codepoints`} />
        <Stat label="Active / idle between edits" value={`${formatDuration(stats.active_time_ms)} / ${formatDuration(stats.idle_time_ms)}`} />
        <Stat label="Delay p50 / p95" value={`${formatDelayMs(stats.inter_event_delay_p50_ms)} / ${formatDelayMs(stats.inter_event_delay_p95_ms)}`} />
      </div>
      <p className="muted">Editing span runs from the first captured edit to the last. Active and idle totals cover only intervals between edits; endpoint waits are separate.</p>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="stat"><span>{label}</span><strong>{value}</strong></div>;
}

// Chart geometry is in CSS pixels: the viewBox width follows the rendered
// width of the SVG, so one user unit is one pixel and labels keep their size
// at any screen width. The fallback width is used until the SVG is measured.
const TIMELINE_FALLBACK_W = 1200;
const TIMELINE_VB_H = 220;
const TIMELINE_PAD_L = 50;
const TIMELINE_PAD_R = 20;
const TIMELINE_PAD_T = 28;
const TIMELINE_PAD_B = 48;
const TIMELINE_MIN_TICK_SPACING_PX = 56;
const TIMELINE_TICK_STEPS_SECONDS = [10, 30, 60, 300, 600, 1800, 3600];

// Width of an element's content box, tracked as it resizes.
function useContentWidth<T extends Element>(fallback: number): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width ?? 0;
      if (measured > 0) setWidth(Math.round(measured));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

// The coarsest step that keeps tick labels at least the minimum spacing apart.
function timelineTickStepSeconds(totalSeconds: number, plotW: number): number {
  const maxTicks = Math.max(1, Math.floor(plotW / TIMELINE_MIN_TICK_SPACING_PX));
  for (const step of TIMELINE_TICK_STEPS_SECONDS) {
    if (totalSeconds / step <= maxTicks) return step;
  }
  const largest = TIMELINE_TICK_STEPS_SECONDS[TIMELINE_TICK_STEPS_SECONDS.length - 1]!;
  return largest * Math.ceil(totalSeconds / (largest * maxTicks));
}

function sourceFill(source: string): string {
  switch (source) {
    case "typing": return "#2f80ed";
    case "paste": return "#d9822b";
    case "cut": return "#bf3f3f";
    case "delete": return "#bf3f3f";
    case "ime": return "#7c3aed";
    case "autocomplete": return "#0f766e";
    case "drop": return "#16a34a";
    case "programmatic": return "#64748b";
    default: return "#a89a82";
  }
}

function formatTimelineTick(seconds: number): string {
  if (seconds >= 86400) return `${Math.floor(seconds / 86400)}d ${Math.floor(seconds / 3600) % 24}h`;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m`;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return s === 0 ? `${m}:00` : `${m}:${String(s).padStart(2, "0")}`;
}

export function EditTimeline({ record }: { record: RecordApiResponse }) {
  const timing = recordTimingDetails(record);
  const points = useMemo(() => buildTimelinePoints(record.events), [record.events]);
  // The length curve is drawn for the prefix of events whose document length can
  // be inferred; from the first event with an unknown position onwards only
  // markers and pauses are shown.
  const firstUnknown = points.findIndex((point) => point.documentLength === null);
  const knownPoints = firstUnknown === -1 ? points : points.slice(0, firstUnknown);
  const lengthKnown = knownPoints.length > 0;
  const lengthKnownThroughout = points.length > 0 && firstUnknown === -1;
  const maxLength = timelineLengthScale(points, record.stats.observed_final_length);
  const observedDurationMs = Math.max(record.manifest.duration_ms, points.at(-1)?.t ?? 0);
  const duration = Math.max(1, observedDurationMs);
  const [chartRef, chartW] = useContentWidth<SVGSVGElement>(TIMELINE_FALLBACK_W);
  const plotW = Math.max(1, chartW - TIMELINE_PAD_L - TIMELINE_PAD_R);
  const plotH = TIMELINE_VB_H - TIMELINE_PAD_T - TIMELINE_PAD_B;
  const baseline = TIMELINE_PAD_T + plotH;
  const activity = buildActivityBins(record.events, duration, Math.floor(plotW / 10));
  const maxActivity = activity.reduce((max, bin) => Math.max(max, bin.count), 1);
  const tx = (t: number) => TIMELINE_PAD_L + (Math.min(duration, Math.max(0, t)) / duration) * plotW;
  const ly = (len: number) => baseline - (Math.min(maxLength, Math.max(0, len)) / maxLength) * plotH;
  // With no inferable length there is no curve; markers sit on a neutral mid line.
  const markerY = (point: { documentLength: number | null }) => point.documentLength !== null ? ly(point.documentLength) : baseline - plotH / 2;

  // Only the fill closes to zero. The line holds each observed length until
  // an actual edit changes it, with no growth drawn across an idle interval.
  const steps = buildLengthStepPoints(points);
  const linePath = steps.map((point, index) => `${index === 0 ? "M" : "L"} ${tx(point.t)} ${ly(point.length)}`).join(" ");
  const firstStep = steps[0];
  const lastStep = steps.at(-1);
  const areaPath = firstStep && lastStep
    ? `M ${tx(firstStep.t)} ${baseline} L ${tx(firstStep.t)} ${ly(firstStep.length)} ${steps.slice(1).map(point => `L ${tx(point.t)} ${ly(point.length)}`).join(" ")} L ${tx(lastStep.t)} ${baseline} Z`
    : "";

  const pauseSpans = points.filter((point) => point.isLongPause && point.delayFromPreviousMs > 0);
  // Only NOTABLE events get a marker — pastes, drops, cuts/deletes, and large
  // atomic inserts. Per-keystroke ticks turn into illegible mush on a long
  // record; the rising curve already carries the typing story, and these few
  // markers stay legible at any density.
  const notable = points.filter((point) =>
    point.isLargeInsert
    || point.source === "paste"
    || point.source === "drop"
    || point.source === "cut"
    || point.source === "delete"
    || (point.del_len ?? 0) > 1,
  );
  const notableSources = new Set(notable.map((point) => point.source));
  const hasLargeInsert = points.some((point) => point.isLargeInsert);
  const hasLongPause = pauseSpans.length > 0;

  const totalSeconds = duration / 1000;
  const tickEverySeconds = timelineTickStepSeconds(totalSeconds, plotW);
  const ticks: number[] = [];
  for (let seconds = 0; seconds <= totalSeconds; seconds += tickEverySeconds) ticks.push(seconds);
  // Mark the end of the record too, unless its label would sit on the last tick's.
  const lastTickSeconds = ticks[ticks.length - 1] ?? 0;
  if (((totalSeconds - lastTickSeconds) / totalSeconds) * plotW >= TIMELINE_MIN_TICK_SPACING_PX) ticks.push(totalSeconds);

  return (
    <section className="card timeline-card">
      <h2>Edit timeline</h2>
      {points.length === 0 ? (
        <p className="muted">No edit events were included in this record.</p>
      ) : lengthKnownThroughout ? (
        <p className="muted">Document length over time. Pastes, cuts, and large inserts are marked on the curve; shaded bands are long pauses. The line stays flat between edits and changes at each captured edit.</p>
      ) : lengthKnown ? (
        <p className="muted">Document length over time, up to edit {knownPoints.length} of {points.length}. Later events lack enough measurements to reconstruct length. Editing activity remains visible below; shaded bands mark long pauses.</p>
      ) : (
        <p className="muted">Document length is unknown because this record lacks enough measurements to reconstruct it. The bars show when edits happened and how many were captured, not document length. Shaded bands mark long pauses.</p>
      )}
      {timing.signedFinish && <p className="muted signed-finish-summary">Signed finish at {formatDuration(record.manifest.duration_ms)} from the session start.
        {timing.beforeFirstEditMs > 0 && <> No edits were captured during the first {formatDuration(timing.beforeFirstEditMs)}.</>}
        {timing.afterLastEditMs > 0 && <> The final {formatDuration(timing.afterLastEditMs)} contains no captured edits. The length curve ends at the last measurable edit; it does not describe that later interval.</>}
      </p>}
      <svg ref={chartRef} className="timeline-chart" viewBox={`0 0 ${chartW} ${TIMELINE_VB_H}`} role="img" aria-label="Content-blind edit timeline" preserveAspectRatio="xMidYMid meet">
        {timing.signedFinish && timing.beforeFirstEditMs > 0 && <rect className="before-first-edit-gap" x={tx(0)} y={TIMELINE_PAD_T}
          width={Math.max(1, tx(timing.beforeFirstEditMs) - tx(0))} height={plotH} fill="#dce3e8" opacity={0.65}>
          <title>{`No captured edits before the first edit: ${formatDuration(timing.beforeFirstEditMs)}`}</title>
        </rect>}
        {timing.signedFinish && timing.afterLastEditMs > 0 && <rect className="signed-finish-gap" x={tx(points.at(-1)?.t ?? 0)} y={TIMELINE_PAD_T}
          width={Math.max(1, tx(record.manifest.duration_ms) - tx(points.at(-1)?.t ?? 0))} height={plotH} fill="#dce3e8" opacity={0.65}>
          <title>{`No captured edits between the last edit and signed finish: ${formatDuration(timing.afterLastEditMs)}`}</title>
        </rect>}
        {pauseSpans.map((point) => {
          const startT = Math.max(0, point.t - point.delayFromPreviousMs);
          const x = tx(startT);
          const width = Math.max(2, tx(point.t) - x);
          return <rect key={`pause-${point.seq}`} x={x} y={TIMELINE_PAD_T} width={width} height={plotH} fill="#ead9b8" opacity={0.45} />;
        })}
        {!lengthKnown && activity.filter(bin => bin.count > 0).map(bin => {
          const height = Math.max(3, bin.count / maxActivity * plotH);
          return <rect className="activity-bar" key={bin.start} x={tx(bin.start)} y={baseline - height}
            width={Math.max(1, tx(bin.end) - tx(bin.start) - 1)} height={height} fill="#769bc7">
            <title>{`${bin.count} edit${bin.count === 1 ? "" : "s"} · ${formatDuration(bin.start)}–${formatDuration(bin.end)}`}</title>
          </rect>;
        })}
        {!lengthKnown && points.length > 0 && <text x={TIMELINE_PAD_L} y={TIMELINE_PAD_T - 10} fontSize={11} fill="#514a40">edits per interval · peak {maxActivity}</text>}
        <line x1={TIMELINE_PAD_L} y1={baseline} x2={chartW - TIMELINE_PAD_R} y2={baseline} stroke="#d8c8a6" strokeWidth={0.6} />
        {lengthKnown ? <path className="length-area" d={areaPath} fill="rgba(139, 94, 52, 0.18)" stroke="none" /> : null}
        {lengthKnown ? <path className="length-curve" d={linePath} fill="none" stroke="#8b5e34" strokeWidth={1.2} strokeLinejoin="round" strokeLinecap="round" /> : null}
        {knownPoints.length === 1 && !notable.some(point => point.seq === knownPoints[0]!.seq) && <circle className="length-single" cx={tx(knownPoints[0]!.t)} cy={ly(knownPoints[0]!.documentLength ?? 0)} r={3} fill="#8b5e34">
          <title>{`${knownPoints[0]!.documentLength} codepoints after the first edit`}</title>
        </circle>}
        {notable.map((point) => {
          const x = tx(point.t);
          const y = markerY(point);
          const r = point.isLargeInsert ? 4.5 : 3.2;
          return (
            <circle key={point.seq} cx={x} cy={y} r={r} fill={sourceFill(point.source)} stroke="#fffaf2" strokeWidth={1.2}>
              <title>{`seq ${point.seq} · ${point.source} · +${point.ins_len ?? "unknown"}/-${point.del_len ?? "unknown"} · len ${point.documentLength ?? "unknown"} · t=${point.t}ms`}</title>
            </circle>
          );
        })}
        {lengthKnown ? <text x={TIMELINE_PAD_L - 6} y={TIMELINE_PAD_T + 4} fontSize={11} fill="#756b60" fontFamily="ui-monospace, monospace" textAnchor="end">{maxLength} cp</text> : null}
        {lengthKnown ? <text x={TIMELINE_PAD_L - 6} y={baseline + 4} fontSize={11} fill="#756b60" fontFamily="ui-monospace, monospace" textAnchor="end">0</text> : null}
        {ticks.map((seconds) => {
          const x = tx(seconds * 1000);
          return (
            <g key={`tick-${seconds}`}>
              <line x1={x} y1={baseline} x2={x} y2={baseline + 4} stroke="#a89a82" strokeWidth={0.6} />
              <text x={x} y={baseline + 18} fontSize={11} fill="#756b60" fontFamily="ui-monospace, monospace" textAnchor="middle">{formatTimelineTick(seconds)}</text>
            </g>
          );
        })}
        <text x={chartW - TIMELINE_PAD_R} y={baseline + 34} fontSize={10} fill="#a89a82" fontFamily="ui-monospace, monospace" textAnchor="end">time →</text>
      </svg>
      {lengthKnown && !lengthKnownThroughout && <div className="activity-strip" aria-label="Editing activity for the complete record">
        <p className="muted">All {points.length} edits over time — bar height is the number of edits per interval.</p>
        <svg viewBox={`0 0 ${chartW} 56`} role="img" aria-label="Edit counts over time">
          {activity.filter(bin => bin.count > 0).map(bin => {
            const height = Math.max(3, bin.count / maxActivity * 48);
            return <rect className="activity-bar" key={bin.start} x={tx(bin.start)} y={52 - height}
              width={Math.max(1, tx(bin.end) - tx(bin.start) - 1)} height={height} fill="#769bc7">
              <title>{`${bin.count} edits · ${formatDuration(bin.start)}–${formatDuration(bin.end)}`}</title>
            </rect>;
          })}
        </svg>
      </div>}
      <div className="legend">
        {!lengthKnown && points.length > 0 && <span>bar height: edits per interval</span>}
        {lengthKnown && <><span className="dot curve" /> document length{" "}</>}
        {notableSources.has("paste") && <><span className="dot source-paste" /> paste </>}
        {notableSources.has("drop") && <><span className="dot source-drop" /> drop </>}
        {(notableSources.has("cut") || notableSources.has("delete")) && <><span className="dot source-cut" /> cut/delete </>}
        {notableSources.has("ime") && <><span className="dot source-ime" /> IME </>}
        {notableSources.has("autocomplete") && <><span className="dot source-autocomplete" /> autocomplete </>}
        {notableSources.has("programmatic") && <><span className="dot source-programmatic" /> programmatic </>}
        {hasLargeInsert && <><span className="dot large" /> large insert </>}
        {hasLongPause && <><span className="dot pause" /> long pause</>}
        {timing.signedFinish && (timing.beforeFirstEditMs > 0 || timing.afterLastEditMs > 0) && <span>gray bands: no captured edits before the first edit or after the last</span>}
      </div>
    </section>
  );
}


const MEASURE_DEFINITIONS: Record<string, string> = {
  event_count: "Number of recorded buffer mutations (edits).",
  interval_count: "Number of gaps between consecutive edits.",
  inter_event_delay_p50_ms: "Median time between consecutive edits.",
  inter_event_delay_p90_ms: "90th-percentile time between consecutive edits.",
  inter_event_delay_p95_ms: "95th-percentile time between consecutive edits.",
  inter_event_delay_max_ms: "Longest gap between consecutive edits.",
  long_pause_count: "Number of gaps of 30 seconds or more.",
  active_time_ms: "Sum of gaps shorter than 30 seconds between recorded edits. Time before the first edit and after the last is excluded.",
  idle_time_ms: "Total time paused: the sum of gaps of 30 seconds or more.",
  small_edit_count: "Edits that inserted or deleted only a few codepoints.",
  atomic_insert_max_len: "Largest amount of text inserted in a single edit (e.g. a paste).",
  deletion_count: "Number of edits that removed text.",
  deletion_cluster_count: "Number of runs of consecutive deletions.",
};

function MeasureTerm({ name }: { name: string }) {
  const definition = MEASURE_DEFINITIONS[name];
  const [open, setOpen] = useState(false);
  if (!definition) return <>{name}</>;
  return (
    <span className="measure-term">
      {name}
      <button
        type="button"
        className="measure-info"
        aria-label={`What is ${name}?`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        onBlur={() => setOpen(false)}
      >
        ?
      </button>
      {open ? <span className="measure-popover" role="tooltip">{definition}</span> : null}
    </span>
  );
}

export function SignalList({ signals }: { signals: Signal[] }) {
  return <section className="card"><h2>Analyzer signals as facts</h2>{signals.length === 0 ? <p className="muted">No analyzer signals were stored.</p> : signals.map((signal) => <SignalCard key={`${signal.analyzer_id}:${signal.analyzer_version}`} signal={signal} />)}</section>;
}

export function SignalCard({ signal }: { signal: Signal }) {
  return (
    <article className="signal-card">
      <h3>{signal.analyzer_id} <small>v{signal.analyzer_version}</small></h3>
      {!signal.applicable && <p className="pill">Not applicable</p>}
      <p>{signal.explanation}</p>
      {signal.measures.length > 0 && <dl className="measure-grid">{signal.measures.map((measure) => <React.Fragment key={measure.key}><dt><MeasureTerm name={measure.key} /></dt><dd>{String(measure.value)}{measure.unit ? ` ${measure.unit}` : ""}</dd></React.Fragment>)}</dl>}
    </article>
  );
}

export function VerificationPanel({ record }: { record: RecordApiResponse }) {
  // The record's signature is the BLAKE3 record hash; the URL is derived from
  // it. We recompute it from the events in-browser so the "Computed hash" row
  // is the reader's own re-derivation, not a server claim — but we don't dress
  // it up as a verdict, because comparing it to the server's own hash field
  // is only a check of internal consistency.
  const verification = useMemo(() => verifyRecordChain(record), [record]);
  return (
    <section className="card">
      <h2>Signature &amp; details</h2>
      <ChainStatus verification={verification} />
      <ObservationStatusLine record={record} />
      <ManifestDetails record={record} computedRecordHash={verification.computedRecordHash} />
    </section>
  );
}

export function ObservationStatusLine({ record }: { record: RecordApiResponse }) {
  const observation = record.observation;
  const eventCount = record.manifest.event_count;
  const statusCopy = observationStatusCopy(observation, eventCount);
  return (
    <section className="observation-status" aria-label="Observation status">
      <p className={`observation-status-line observation-status-${observation.state}`}>
        <strong>{statusCopy.headline}</strong> {statusCopy.body}
      </p>
      {observation.server_observed_span_ms !== null && observation.server_observed_span_ms > 0 ? (
        <p className="observation-span muted">
          Server-observed span: {formatServerObservedSpan(observation.server_observed_span_ms)}.
        </p>
      ) : null}
    </section>
  );
}

function observationStatusCopy(observation: RecordObservation, eventCount: number): { headline: string; body: React.ReactNode } {
  switch (observation.state) {
    case "observed": {
      const first = observation.first_observed_at;
      const last = observation.last_observed_at;
      const lastCommitment = observation.commitments[observation.commitments.length - 1];
      const coveredCount = lastCommitment?.event_count ?? eventCount;
      return {
        headline: "Server observed checkpoints.",
        body: (
          <>
            The server received commitments to this event-chain across a span from{" "}
            <UtcInstant iso={first} /> to <UtcInstant iso={last} />. The last commitment covered the final {coveredCount} {coveredCount === 1 ? "event" : "events"}.
          </>
        ),
      };
    }
    case "partial": {
      const first = observation.first_observed_at;
      const last = observation.last_observed_at;
      const lastCommitment = observation.commitments[observation.commitments.length - 1];
      const covered = lastCommitment?.event_count ?? 0;
      const gap = Math.max(0, eventCount - covered);
      return {
        headline: "Partially observed.",
        body: (
          <>
            The server received commitments between <UtcInstant iso={first} /> and <UtcInstant iso={last} />.{" "}
            {gap} {gap === 1 ? "event" : "events"} after the last commitment {gap === 1 ? "was" : "were"} not committed to the server.
          </>
        ),
      };
    }
    case "unobserved":
      return {
        headline: "Not observed.",
        body: "No server commitment is bound to this record. The hash chain in this record is still verifiable in your browser; the server cannot confirm when it saw the editing process.",
      };
    case "not_requested":
    default:
      return {
        headline: "No observation requested.",
        body: "The producer that signed this record did not request server observation.",
      };
  }
}

function UtcInstant({ iso }: { iso: string | null }) {
  if (!iso) return <span className="utc-instant unknown">unknown</span>;
  return (
    <time className="utc-instant" dateTime={iso} title={iso}>
      {formatUtcMinute(iso)}
    </time>
  );
}

// The reader's own recomputation of the hash chain, stated plainly. This is a
// check of internal consistency (the events shown are the events signed), not
// a verdict about authorship.
function ChainStatus({ verification }: { verification: VerificationState }) {
  if (verification.ok) {
    return (
      <p className="chain-status ok" role="status">
        <strong>Hash chain recomputed in your browser.</strong> The events and any document binding reproduce the displayed record hash. This checks internal consistency; compare an independently saved hash to check an earlier record.
      </p>
    );
  }
  const hashMismatch = verification.messages.some((message) => message.includes("record_hash mismatch"));
  return (
    <div className="chain-status error" role="status">
      {hashMismatch ? (
        <p><strong>Hash chain does not match.</strong> Recomputing the chain from the events shown here does not reproduce the record hash, so this response is internally inconsistent.</p>
      ) : (
        <p><strong>Record could not be verified.</strong> This record does not pass the format's checks, so the chain was not recomputed. The details below say what failed.</p>
      )}
      <ul className="chain-status-errors">
        {verification.messages.map((message) => <li key={message}>{message}</li>)}
      </ul>
    </div>
  );
}

export function ManifestDetails({ record, computedRecordHash }: { record: RecordApiResponse; computedRecordHash?: string }) {
  const manifest = record.manifest;
  return (
    <dl className="details mono">
      <dt>Full record hash</dt><dd>{manifest.record_hash}</dd>
      {computedRecordHash && <><dt>Computed hash</dt><dd>{computedRecordHash}</dd></>}
      {manifest.parent_record && (
        <><dt>Continues from</dt><dd><a className="parent-record-link" href={`/${manifest.parent_record}`}>{manifest.parent_record}</a></dd></>
      )}
      <dt>Producer</dt><dd>{manifest.producer.id} v{manifest.producer.version}</dd>
      <dt>Capabilities</dt><dd>{manifest.producer.capabilities.join(", ") || "none declared"}</dd>
      <dt>Server metadata</dt><dd>{manifest.ingested_server_t ? "ingestion time present" : "client-claimed time only"}</dd>
      <dt>Analyzer versions</dt><dd>{record.signals.map((signal) => `${signal.analyzer_id}@${signal.analyzer_version}`).join(", ") || "none"}</dd>
      <dt>Server-observed commitments</dt><dd><ObservationCommitmentsList commitments={record.observation.commitments} state={record.observation.state} /></dd>
    </dl>
  );
}

export function ObservationCommitmentsList({ commitments, state }: { commitments: ObservationCommitment[]; state: RecordObservation["state"] }) {
  if (commitments.length === 0) {
    return state === "not_requested" ? <span className="muted">not requested</span> : <span className="muted">none</span>;
  }
  const summary = state === "partial"
    ? `${commitments.length} server-observed commitments (partial)`
    : `${commitments.length} server-observed ${commitments.length === 1 ? "commitment" : "commitments"}`;
  return (
    <details className="observation-commitments" data-state={state}>
      <summary>{summary}</summary>
      <ol className="observation-commitments-list">
        {commitments.map((commitment) => (
          <li key={commitment.checkpoint_id} className="observation-commitment">
            <time className="utc-instant" dateTime={commitment.observed_at} title={commitment.observed_at}>
              {formatUtcMinute(commitment.observed_at)}
            </time>
            <span className="commitment-count">
              {commitment.event_count} {commitment.event_count === 1 ? "event" : "events"}
            </span>
            <span className="commitment-chain" title={commitment.chain_tip}>chain tip {truncateHash(commitment.chain_tip)}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}

function truncateHash(hash: string): string {
  if (hash.length <= 14) return hash;
  return `${hash.slice(0, 9)}…${hash.slice(-4)}`;
}

export function TextBindingSection({ record }: { record: RecordApiResponse }) {
  const binding = record.manifest.text_binding;
  if (!binding) {
    return (
      <section className="card" aria-label="Document binding">
        <h2>Document binding</h2>
        <p className="muted">No document was bound to this record.</p>
      </section>
    );
  }
  return (
    <>
      <DocumentCheckCard record={record} />
      <CommensurabilityCard record={record} />
    </>
  );
}

export function DocumentCheckCard({ record }: { record: RecordApiResponse }) {
  const binding = record.manifest.text_binding!;
  const sessionId = record.manifest.session_id;
  const [candidate, setCandidate] = useState("");
  const [result, setResult] = useState<BindingCheckResult | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  return (
    <section className="card" id="check-a-document" aria-label="Check a document">
      <h2>Check a document against this record</h2>
      <p className="muted">Have a copy of this writing? Paste it below and your browser tells you whether it is the text signed here, comparing wording, not exact text. (The Check button turns on once you paste something.)</p>
      <p className="binding-check-privacy">Runs entirely in your browser; the document you paste is never uploaded.</p>
      <textarea
        className="binding-check-input"
        value={candidate}
        onChange={(event) => {
          setCandidate(event.target.value);
          // Clear any prior result so the page never shows an answer for text
          // that is no longer in the box.
          setResult(null);
          setCheckedAt(null);
        }}
        placeholder="paste the document you want to check…"
        aria-label="document to check"
      />
      <div className="binding-check-actions">
        <button
          className="verify-button"
          type="button"
          disabled={candidate.length === 0}
          onClick={() => {
            setResult(checkCandidateAgainstBinding(binding, candidate, sessionId));
            setCheckedAt(new Date().toLocaleTimeString());
          }}
        >
          Check
        </button>
      </div>
      {result && <BindingResult result={result} />}
      {result && checkedAt ? <p className="muted binding-checked-at">Checked at {checkedAt}.</p> : null}
    </section>
  );
}

function BindingResult({ result }: { result: BindingCheckResult }) {
  const summary = describeBindingMatch(result);
  return (
    <div className={`binding-result ${summary.ok ? "ok" : "error"}`} role="status" aria-live="polite">
      <span className="binding-result-mark" aria-hidden="true">
        {summary.ok ? (
          <svg viewBox="0 0 36 36" className="binding-mark-svg"><path d="M7 19 L15 27 L29 9" /></svg>
        ) : (
          <svg viewBox="0 0 36 36" className="binding-mark-svg"><path d="M10 10 L26 26 M26 10 L10 26" /></svg>
        )}
      </span>
      <div className="binding-result-body">
        <p className="binding-result-headline">{summary.headline}</p>
        <p className="binding-result-note">{TEXT_BINDING_DISCLAIMER}</p>
        {summary.short && (
          <p className="binding-result-warning">
            This binds only a short run of text ({result.canonicalLength} canonical characters), so a match on it is weak on its own; many documents share a short run.
          </p>
        )}
      </div>
    </div>
  );
}

export function CommensurabilityCard({ record }: { record: RecordApiResponse }) {
  const binding = record.manifest.text_binding!;
  const stats = record.stats;
  const pasteLabel = `${stats.paste_event_count} ${stats.paste_event_count === 1 ? "paste" : "pastes"}`;
  return (
    <section className="card commensurability-card" aria-label="How this was written">
      <h2>How this was written</h2>
      <p className="muted">A separate judgment, for you to make, not an automated result. Weigh the signed size against the recorded process.</p>
      <div className="commensurability">
        <Stat label="Signed text" value={`${binding.canonical_length} letters & digits (no punctuation or spacing)`} />
        <Stat
          label="Writing process"
          value={`${formatDuration(stats.duration_ms)} · ${stats.event_count} edits · ${pasteLabel} · largest insert ${stats.largest_atomic_insert_codepoints}`}
        />
      </div>
      <p className="muted">What counts as “enough” is yours to read.</p>
    </section>
  );
}

const FP_FALLBACK_W = 660;
const FP_TICKS: { ms: number; label: string }[] = [
  { ms: 100, label: "100ms" },
  { ms: 1000, label: "1s" },
  { ms: 10000, label: "10s" },
  { ms: RHYTHM_MAX_MS, label: "100s" },
];

export function TimingFingerprint({ record }: { record: RecordApiResponse }) {
  const [chartRef, W] = useContentWidth<SVGSVGElement>(FP_FALLBACK_W);
  const histogram = useMemo(() => buildDelayHistogram(record.events), [record.events]);
  if (histogram.total === 0) return null;
  const { bins, underflow, overflow } = histogram;
  const logMin = Math.log10(RHYTHM_MIN_MS);
  const span = Math.log10(RHYTHM_MAX_MS) - logMin;
  const maxCount = Math.max(underflow, overflow, ...bins.map(bin => bin.count), 1);
  const stats = record.stats;
  const timing = recordTimingDetails(record);
  const H = 150, padL = 54, padR = 64, padT = 10, padB = 26;
  const innerW = Math.max(1, W - padL - padR);
  const innerH = H - padT - padB;
  const baseY = padT + innerH;
  const xForMs = (ms: number) => padL + (Math.log10(ms) - logMin) / span * innerW;
  const barWidth = innerW / bins.length;
  const boundaryBarWidth = 24;
  return (
    <section className="card fingerprint-card" aria-label="Writing rhythm">
      <h2>Writing rhythm</h2>
      <p className="muted">Gaps between consecutive edits. The middle bars use a log scale from 16ms to 100s; separate bars show shorter and longer gaps. Bar height counts gaps.</p>
      <svg ref={chartRef} className="fingerprint-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Distribution of gaps between edits, with separate bars below 16 milliseconds and above 100 seconds">
        {FP_TICKS.map((tick) => (
          <line key={`line-${tick.ms}`} x1={xForMs(tick.ms)} y1={padT} x2={xForMs(tick.ms)} y2={baseY} className="fp-tick-line" />
        ))}
        {bins.map((bin, index) => <rect key={index} className="fp-bin" data-count={bin.count}
          x={padL + index * barWidth} y={baseY - bin.count / maxCount * innerH}
          width={Math.max(0.5, barWidth - 0.5)} height={bin.count / maxCount * innerH} fill="#769bc7">
          <title>{`${bin.count} gaps · approximately ${formatDuration(Math.round(bin.start))} to ${formatDuration(Math.round(bin.end))}`}</title>
        </rect>)}
        <rect className="fp-underflow" data-count={underflow} x={8} y={baseY - underflow / maxCount * innerH}
          width={boundaryBarWidth} height={underflow / maxCount * innerH} fill="#769bc7">
          <title>{`${underflow} gaps shorter than 16ms, including simultaneous edits`}</title>
        </rect>
        <rect className="fp-overflow" data-count={overflow} x={W - 36} y={baseY - overflow / maxCount * innerH}
          width={boundaryBarWidth} height={overflow / maxCount * innerH} fill="#769bc7">
          <title>{`${overflow} gaps longer than 100 seconds`}</title>
        </rect>
        <text x={20} y={H - 6} className="fp-label" textAnchor="middle">&lt;16ms</text>
        {FP_TICKS.map((tick) => (
          <text key={`text-${tick.ms}`} x={xForMs(tick.ms)} y={H - 6} className="fp-label" textAnchor="middle">{tick.label}</text>
        ))}
        <text x={W - 24} y={H - 6} className="fp-label" textAnchor="middle">&gt;100s</text>
      </svg>
      <p className="muted rhythm-overflow-summary">{overflow} {overflow === 1 ? "gap longer" : "gaps longer"} than 100 seconds. {underflow} shorter than 16ms, including gaps of zero milliseconds.</p>
      <dl className="fingerprint-stats">
        <div><dt>Edits</dt><dd>{stats.event_count}</dd></div>
        <div><dt>{timing.signedFinish ? "Signed duration" : "Reported duration"}</dt><dd>{formatDuration(stats.duration_ms)}</dd></div>
        <div><dt>Editing span</dt><dd>{formatDuration(timing.editingSpanMs)}</dd></div>
        <div><dt>Median gap</dt><dd>{formatDelayMs(stats.inter_event_delay_p50_ms)}</dd></div>
        <div><dt>95th-percentile gap</dt><dd>{formatDelayMs(stats.inter_event_delay_p95_ms)}</dd></div>
        <div><dt>Longest pause</dt><dd>{formatDelayMs(stats.inter_event_delay_max_ms)}</dd></div>
      </dl>
    </section>
  );
}

export function RecordSignet({ record }: { record?: RecordApiResponse }) {
  const bound = !!record?.manifest.text_binding;
  return (
    <header className={`signet${record ? "" : " signet-loading"}`}>
      <p className="eyebrow"><a className="eyebrow-home" href="/">← possiblymadebyahuman</a></p>
      <div className="signet-head">
        <span className="signet-seal" aria-hidden="true">
          <svg viewBox="0 0 64 64" className="signet-seal-svg">
            <path className="seal-edge" d="M 57.00 32.00 A 2.6 2.6 0 0 1 55.99 39.04 A 2.6 2.6 0 0 1 53.03 45.52 A 2.6 2.6 0 0 1 48.37 50.89 A 2.6 2.6 0 0 1 42.39 54.74 A 2.6 2.6 0 0 1 35.56 56.75 A 2.6 2.6 0 0 1 28.44 56.75 A 2.6 2.6 0 0 1 21.61 54.74 A 2.6 2.6 0 0 1 15.63 50.89 A 2.6 2.6 0 0 1 10.97 45.52 A 2.6 2.6 0 0 1 8.01 39.04 A 2.6 2.6 0 0 1 7.00 32.00 A 2.6 2.6 0 0 1 8.01 24.96 A 2.6 2.6 0 0 1 10.97 18.48 A 2.6 2.6 0 0 1 15.63 13.11 A 2.6 2.6 0 0 1 21.61 9.26 A 2.6 2.6 0 0 1 28.44 7.25 A 2.6 2.6 0 0 1 35.56 7.25 A 2.6 2.6 0 0 1 42.39 9.26 A 2.6 2.6 0 0 1 48.37 13.11 A 2.6 2.6 0 0 1 53.03 18.48 A 2.6 2.6 0 0 1 55.99 24.96 A 2.6 2.6 0 0 1 57.00 32.00 Z" />
            <circle className="seal-ring" cx="32" cy="32" r="20" />
            <path className="seal-mark" d="M20 32 C20 26 26 26 32 32 C38 38 44 38 44 32 C44 26 38 26 32 32 C26 38 20 38 20 32 Z" />
          </svg>
        </span>
        <div className="signet-titles">
          <h1 aria-label={record ? undefined : "Loading writing record"}><span aria-hidden={!record}>Signed writing record</span></h1>
          <p className="signet-scope">This shows the shape of a writing process. It is not a human/AI score or verdict.</p>
          <p className="signet-statement" aria-hidden={!record}>
            Signs the <strong>shape of the writing process</strong>
            {bound ? <> and a commitment to the <strong>wording the signer selected</strong></> : null}.
          </p>
        </div>
      </div>
      <p className="signet-orient">An inspectable record of an editing process. A document binding, when present, does not establish that these edits produced that text. <a href="/docs/what-pmbah-does/">What is this?</a></p>
    </header>
  );
}

export function RecordFooter() {
  return (
    <footer className="record-footer">
      <div className="record-footer-rule" aria-hidden="true" />
      <p className="record-footer-mark"><span className="record-footer-seal" aria-hidden="true">∞</span> possiblymadebyahuman</p>
      <p className="record-footer-tagline">We cannot prove a human wrote it. But we can record the writing process, and sign it for you.</p>
      <nav className="record-footer-links" aria-label="Site">
        <a href="/">Home</a>
        <a href="/docs/what-pmbah-does/">What this is</a>
        <a href="/docs/checking-a-document/">How checking works</a>
        <a href="/docs/verification/">Verify a record</a>
        <a href="https://github.com/juanre/possiblymadebyahuman" rel="noopener">Source</a>
      </nav>
      <p className="record-footer-note muted">Public records contain no document text. Text pasted for a check stays in this browser.</p>
    </footer>
  );
}

export function RecordPage({ record }: { record?: RecordApiResponse }) {
  return (
    <main className="page-shell record-page">
      <RecordSignet record={record} />
      {record ? <>
      <TimingFingerprint record={record} />
      <TextBindingSection record={record} />
      <CaptureContextSummary record={record} />
      <QuickStatsPanel record={record} />
      <EditTimeline record={record} />
      <SignalList signals={record.signals} />
      <VerificationPanel record={record} />
      <DisclaimerBanner />
      </> : <div className="record-loading" aria-busy="true">
        <p role="status">Loading writing record…</p>
        <div className="card record-skeleton" aria-hidden="true" />
        <div className="card record-skeleton" aria-hidden="true" />
      </div>}
      <RecordFooter />
    </main>
  );
}
