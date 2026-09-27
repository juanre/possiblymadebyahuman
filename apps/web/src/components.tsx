import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Signal } from "../../../packages/format/src/index.ts";
import type { ObservationCommitment, RecordObservation } from "../../../packages/storage/src/index.ts";
import { buildActivityColumns, buildDelayHistogram, buildTimeAxis, formatPauseLength, layoutTimeAxisLabels, buildLengthStepPoints, recordTimingDetails, RHYTHM_MIN_MS, RHYTHM_MAX_MS, buildTimelinePoints, checkCandidateAgainstBinding, describeBindingMatch, describeRecordSummary, formatCharacters, formatDelayMs, formatDuration, formatServerObservedSpan, formatSignedTextLength, formatUtcMinute, recordFacts, TEXT_BINDING_DISCLAIMER, timelineLengthScale, verifyRecordChain, type BindingCheckResult, type TimelinePoint } from "./record-utils.ts";
import type { RecordApiResponse, VerificationState } from "./types.ts";

const SITE_NAME = "possiblymadebyahuman";

/** Names the browser tab after the page the reader is looking at. */
export function usePageTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · ${SITE_NAME}`;
  }, [title]);
}

export function HomeLink() {
  return (
    <p className="record-home-line">
      <a className="record-home" href="/">
        <img src="/favicon.svg" alt="" width="22" height="22" />
        {SITE_NAME}
      </a>
    </p>
  );
}

export const TECHNICAL_DETAILS_ID = "technical-details";
const SIGNATURE_HEADING_ID = "signature-and-verification";

/** Opens the technical details and brings the signature section into view. */
export function revealSignatureDetails(open: () => void) {
  open();
  requestAnimationFrame(() => {
    const heading = document.getElementById(SIGNATURE_HEADING_ID);
    heading?.scrollIntoView({ block: "start" });
    heading?.focus({ preventScroll: true });
  });
}

// Any completed check that fails is announced once, above the header, on both
// the inline and the paged record page. Downloads that could not finish are
// pending, not failures, and never raise this alert.
export function VerificationAlert({ verification, onShowDetails }: { verification?: VerificationState; onShowDetails: () => void }) {
  if (!verification || verification.ok || verification.pending) return null;
  const hashMismatch = verification.messages.some((message) => message.includes("record_hash mismatch") || message.includes("hash does not match"));
  return (
    <div className="verification-alert" role="alert">
      <p>
        <strong>This record does not verify.</strong>{" "}
        {hashMismatch
          ? "Recomputing the hash chain from these events does not reproduce the signed record hash, so its contents cannot be trusted."
          : "It fails the record format's checks, so its contents cannot be trusted."}
      </p>
      <p>
        <a
          href={`#${SIGNATURE_HEADING_ID}`}
          onClick={(event) => {
            event.preventDefault();
            revealSignatureDetails(onShowDetails);
          }}
        >
          See what failed in the technical details
        </a>
      </p>
    </div>
  );
}

type HeaderSource = Pick<RecordApiResponse, "manifest" | "stats" | "observation">;

// The header keeps the same geometry while the record loads: the title is
// reserved but hidden, and placeholders stand in for the summary and facts.
export function RecordHeader({ record }: { record?: HeaderSource }) {
  return (
    <header className={`record-header${record ? "" : " record-header-loading"}`}>
      <HomeLink />
      <h1 aria-label={record ? undefined : "Loading writing record"}><span aria-hidden={!record}>Signed writing record</span></h1>
      {record ? (
        <>
          <p className="record-summary">{describeRecordSummary(record)}</p>
          <dl className="record-facts">
            {recordFacts(record).map((fact) => (
              <div key={fact.label} className="record-fact"><dt>{fact.label}</dt><dd>{fact.value}</dd></div>
            ))}
          </dl>
        </>
      ) : (
        <>
          <p className="record-summary record-placeholder" aria-hidden="true"><span /><span /></p>
          <div className="record-facts record-placeholder" aria-hidden="true" />
        </>
      )}
      <p className="record-limit">
        This record shows how the text was edited. Who had the ideas, and who typed them, is for you to judge.{" "}
        <a href="/docs/what-pmbah-does/">How records work</a>
      </p>
    </header>
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

function TechnicalSection({ title, id, children }: { title: string; id?: string; children: React.ReactNode }) {
  const generated = useId();
  const headingId = id ?? generated;
  return (
    <section className="technical-section" aria-labelledby={headingId}>
      <h3 id={headingId} tabIndex={id ? -1 : undefined}>{title}</h3>
      {children}
    </section>
  );
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
      <TechnicalSection title="Capture context">
        {timingRows ? <dl className="details">{timingRows}</dl> : <p className="muted">No capture context was included.</p>}
      </TechnicalSection>
    );
  }
  return (
    <TechnicalSection title="Capture context">
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
    </TechnicalSection>
  );
}

// Measurements that the header does not already state, for readers who want
// the arithmetic behind the summary.
export function TimingAndCounts({ record }: { record: RecordApiResponse }) {
  const stats = record.stats;
  const timing = recordTimingDetails(record);
  return (
    <TechnicalSection title="Timing and counts">
      <dl className="details timing-counts">
        <dt>{timing.signedFinish ? "Signed duration" : "Reported duration"}</dt><dd>{formatDuration(stats.duration_ms)}</dd>
        <dt>Editing span, first to last edit</dt><dd>{formatDuration(timing.editingSpanMs)}</dd>
        <dt>Between edits, active and paused</dt><dd>{formatDuration(stats.active_time_ms)} active, {formatDuration(stats.idle_time_ms)} in pauses of 30 seconds or more</dd>
        <dt>Median and 95th-percentile gap</dt><dd>{formatDelayMs(stats.inter_event_delay_p50_ms)} and {formatDelayMs(stats.inter_event_delay_p95_ms)}</dd>
        <dt>Longest gap</dt><dd>{formatDelayMs(stats.inter_event_delay_max_ms)}</dd>
        <dt>Typing edits</dt><dd>{stats.typed_event_count}</dd>
        <dt>Insertions, deletions, replacements</dt><dd>{stats.insert_op_count}, {stats.delete_op_count}, {stats.replace_op_count}</dd>
        <dt>Edits with unknown source</dt><dd>{stats.unknown_source_count}</dd>
      </dl>
      <p className="muted">Active and paused totals cover only the intervals between edits; time before the first edit and after the last is separate.</p>
    </TechnicalSection>
  );
}

// Chart geometry is in CSS pixels: the viewBox width follows the rendered
// width of the SVG, so one user unit is one pixel and labels keep their size
// at any screen width. The fallback width is used until the SVG is measured.
const TIMELINE_FALLBACK_W = 1200;
const TIMELINE_VB_H = 280;
const TIMELINE_PAD_L = 12;
const TIMELINE_PAD_R = 12;
const TIMELINE_PAD_T = 34;
const TIMELINE_PAD_B = 44;
const CHART_FONT = "Inter, ui-sans-serif, system-ui, sans-serif";
const SERIF_FONT = "'Iowan Old Style', 'New York', ui-serif, Georgia, serif";

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

function sourceFill(source: string): string {
  switch (source) {
    case "typing": return "#2f80ed";
    case "paste": return "#c96a16";
    case "cut": return "#bf3f3f";
    case "delete": return "#bf3f3f";
    case "ime": return "#7c3aed";
    case "autocomplete": return "#0f766e";
    case "drop": return "#16a34a";
    case "programmatic": return "#64748b";
    default: return "#a89a82";
  }
}

const SOURCE_NAMES: Record<string, string> = {
  typing: "Typing",
  paste: "Paste",
  cut: "Cut",
  delete: "Deletion",
  ime: "IME input",
  autocomplete: "Autocomplete",
  drop: "Drop",
  programmatic: "Programmatic edit",
};

function describeTimelinePoint(point: { source: string; t: number; ins_len: number | null; del_len: number | null; documentLength: number | null }): string {
  const name = SOURCE_NAMES[point.source] ?? "Edit of unknown source";
  const inserted = point.ins_len === null ? "unknown amount added" : `${formatCharacters(point.ins_len)} added`;
  const removed = point.del_len === null ? "unknown amount removed" : `${formatCharacters(point.del_len)} removed`;
  const length = point.documentLength === null ? "" : `; length afterwards ${formatCharacters(point.documentLength)}`;
  return `${name} at ${formatDuration(point.t)}: ${inserted}, ${removed}${length}`;
}

/** Diagonal pencil shading, the fill for the measured document length. */
export function PencilHatch({ id }: { id: string }) {
  return (
    <defs>
      <pattern id={id} width={5} height={5} patternUnits="userSpaceOnUse" patternTransform="rotate(-38)">
        <line x1={0} y1={0} x2={0} y2={5} stroke="#3d2f17" strokeWidth={1} strokeOpacity={0.5} />
      </pattern>
    </defs>
  );
}

// Width given to each pause cut out of the time axis.
const TIMELINE_BREAK_W = 28;

function EditTimeline({ record }: { record: RecordApiResponse }) {
  const timing = recordTimingDetails(record);
  const hatchId = `pencil-hatch-${useId().replace(/:/g, "")}`;
  const points = useMemo(() => buildTimelinePoints(record.events), [record.events]);
  // The length curve is drawn for the prefix of events whose document length can
  // be inferred; from the first event with an unknown position onwards only
  // markers are shown.
  const firstUnknown = points.findIndex((point) => point.documentLength === null);
  const knownPoints = firstUnknown === -1 ? points : points.slice(0, firstUnknown);
  const lengthKnown = knownPoints.length > 0;
  const lengthKnownThroughout = points.length > 0 && firstUnknown === -1;
  const maxLength = timelineLengthScale(points, record.stats.observed_final_length);
  const endMs = Math.max(record.manifest.duration_ms, points.at(-1)?.t ?? 0);
  const [chartRef, chartW] = useContentWidth<SVGSVGElement>(TIMELINE_FALLBACK_W);
  const plotW = Math.max(1, chartW - TIMELINE_PAD_L - TIMELINE_PAD_R);
  const plotH = TIMELINE_VB_H - TIMELINE_PAD_T - TIMELINE_PAD_B;
  const baseline = TIMELINE_PAD_T + plotH;
  const axis = useMemo(() => buildTimeAxis(record.events.map(event => event.t), endMs, plotW, TIMELINE_BREAK_W), [record.events, endMs, plotW]);
  const activity = useMemo(() => buildActivityColumns(record.events, axis), [record.events, axis]);
  const maxActivity = activity.reduce((max, column) => Math.max(max, column.count), 1);
  const tx = (t: number) => TIMELINE_PAD_L + axis.x(t);
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
  // The length held across a cut pause, when the curve reaches that far.
  const lengthAt = (t: number) => lastStep && t < lastStep.t ? [...steps].reverse().find(step => step.t <= t)?.length ?? null : null;

  // Only notable events get a marker: pastes, drops, cuts and deletions, and
  // large insertions. The curve already carries the typing itself, including
  // multi-character deletions; where there is no curve, those get a marker too.
  const isDeletion = (point: TimelinePoint) => point.source === "cut" || point.source === "delete"
    || (point.documentLength === null && (point.del_len ?? 0) > 1);
  const notable = points.filter((point) =>
    point.isLargeInsert
    || point.source === "paste"
    || point.source === "drop"
    || isDeletion(point),
  );
  const markerSource = (point: TimelinePoint) => isDeletion(point) && point.source !== "cut" ? "delete" : point.source;
  const notableSources = new Set(notable.map(markerSource));
  const hasLargeInsert = points.some((point) => point.isLargeInsert);
  const cutPauses = axis.breaks.length;
  const labels = layoutTimeAxisLabels(axis, { endPrefix: timing.signedFinish ? "signed at " : "" });
  // Pause lengths that would collide sit on a second row below the axis.
  const secondRowH = labels.some(label => label.row === 1) ? 16 : 0;
  const pauseSentence = cutPauses > 0 ? ` ${cutPauses === 1 ? "A pause" : "Pauses"} of 5 minutes or more ${cutPauses === 1 ? "is" : "are"} cut short and marked with how long ${cutPauses === 1 ? "it" : "they"} lasted.` : "";
  const finalLength = lastStep?.length ?? null;
  const chartLabel = [
    lengthKnown ? `Document length over time${finalLength === null ? "" : `, ending at ${formatCharacters(finalLength)}`}.` : "Edits over time.",
    timing.signedFinish && timing.afterLastEditMs > 0 ? `Signed ${formatDuration(timing.afterLastEditMs)} after the last edit.` : "",
    cutPauses > 0 ? `${cutPauses} ${cutPauses === 1 ? "pause" : "pauses"} of 5 minutes or more cut from the time axis.` : "",
  ].filter(Boolean).join(" ");

  return (
    <section className="record-section edit-timeline" aria-labelledby="edit-timeline-heading">
      <h2 id="edit-timeline-heading">Edit timeline</h2>
      {points.length === 0 ? (
        <p className="section-intro">No edit events were included in this record.</p>
      ) : lengthKnownThroughout ? (
        <p className="section-intro">Document length over time. Pastes, cuts, and large insertions are marked on the curve.{pauseSentence}</p>
      ) : lengthKnown ? (
        <p className="section-intro">Document length over time, up to edit {knownPoints.length} of {points.length}. Later events lack enough measurements to reconstruct length, so editing activity continues below.{pauseSentence}</p>
      ) : (
        <p className="section-intro">Document length is unknown because this record lacks enough measurements to reconstruct it. The bars show when edits happened and how many were captured, not document length.{pauseSentence}</p>
      )}
      <svg ref={chartRef} className="timeline-chart" viewBox={`0 0 ${chartW} ${TIMELINE_VB_H + secondRowH}`} role="img" aria-label={chartLabel} preserveAspectRatio="xMidYMid meet">
        <PencilHatch id={hatchId} />
        {!lengthKnown && activity.filter(column => column.count > 0).map(column => {
          const height = Math.max(3, column.count / maxActivity * plotH);
          return <rect className="activity-bar" key={`${column.start}-${column.x0}`} x={TIMELINE_PAD_L + column.x0} y={baseline - height}
            width={Math.max(1, column.x1 - column.x0 - 1)} height={height} fill={`url(#${hatchId})`} stroke="#3d2f17" strokeWidth={0.8}>
            <title>{`${column.count} edit${column.count === 1 ? "" : "s"} from ${formatDuration(column.start)} to ${formatDuration(column.end)}`}</title>
          </rect>;
        })}
        {!lengthKnown && points.length > 0 && <text x={TIMELINE_PAD_L} y={TIMELINE_PAD_T - 12} fontSize={12} fill="#514a40" fontFamily={CHART_FONT}>edits per interval (peak {maxActivity})</text>}
        <line x1={TIMELINE_PAD_L} y1={baseline} x2={chartW - TIMELINE_PAD_R} y2={baseline} stroke="#3d2f17" strokeWidth={1} />
        {lengthKnown ? <path className="length-area" d={areaPath} fill={`url(#${hatchId})`} stroke="none" /> : null}
        {lengthKnown ? <path className="length-curve" d={linePath} fill="none" stroke="#3d2f17" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" /> : null}
        {axis.breaks.map((gap) => {
          const x0 = TIMELINE_PAD_L + gap.x0;
          const x1 = TIMELINE_PAD_L + gap.x1;
          const held = lengthAt(gap.start);
          return (
            <g className="timeline-break" key={`break-${gap.start}`}>
              <title>{`No edits for ${formatPauseLength(gap.end - gap.start)}`}</title>
              <rect x={x0} y={TIMELINE_PAD_T - 4} width={x1 - x0} height={plotH + 12} fill="#fbf8f2" />
              {held !== null && <line x1={x0} y1={ly(held)} x2={x1} y2={ly(held)} stroke="#3d2f17" strokeWidth={1.5} strokeDasharray="2 4" strokeLinecap="round" />}
              <line x1={x0 + 2} y1={baseline + 6} x2={x0 + 8} y2={baseline - 6} stroke="#3d2f17" strokeWidth={1.2} />
              <line x1={x1 - 8} y1={baseline + 6} x2={x1 - 2} y2={baseline - 6} stroke="#3d2f17" strokeWidth={1.2} />
            </g>
          );
        })}
        {knownPoints.length === 1 && !notable.some(point => point.seq === knownPoints[0]!.seq) && <circle className="length-single" cx={tx(knownPoints[0]!.t)} cy={ly(knownPoints[0]!.documentLength ?? 0)} r={3.5} fill="#3d2f17">
          <title>{`${formatCharacters(knownPoints[0]!.documentLength)} after the first edit`}</title>
        </circle>}
        {notable.map((point) => (
          <circle key={point.seq} cx={tx(point.t)} cy={markerY(point)} r={point.isLargeInsert ? 5 : 4} fill={sourceFill(markerSource(point))} stroke="#fbf8f2" strokeWidth={1.5}>
            <title>{describeTimelinePoint(point)}</title>
          </circle>
        ))}
        {lengthKnown && lastStep ? <text className="length-scale" x={tx(lastStep.t)} y={ly(lastStep.length) - 10} fontSize={12} fill="#514a40" fontFamily={CHART_FONT}
          textAnchor={tx(lastStep.t) > chartW / 2 ? "end" : "start"}>{formatCharacters(lastStep.length)}</text> : null}
        {labels.map((label) => {
          const x = TIMELINE_PAD_L + label.x;
          return (
            <g key={`${label.kind}-${label.x}`} className={`axis-label axis-label-${label.kind}`}>
              {label.kind !== "break" && <line x1={x} y1={baseline} x2={x} y2={baseline + 5} stroke="#3d2f17" strokeWidth={1} />}
              <text x={label.anchor === "start" ? TIMELINE_PAD_L + label.left : label.anchor === "end" ? TIMELINE_PAD_L + label.right : x} y={baseline + 20 + label.row * 16}
                fontSize={label.kind === "break" ? 13 : 12} fill={label.kind === "break" ? "#6e665d" : "#5e554a"}
                fontFamily={label.kind === "break" ? SERIF_FONT : CHART_FONT} fontStyle={label.kind === "break" ? "italic" : undefined}
                textAnchor={label.anchor} style={{ fontVariantNumeric: "tabular-nums" }}>{label.text}</text>
            </g>
          );
        })}
        <text x={chartW - TIMELINE_PAD_R} y={baseline + 38 + secondRowH} fontSize={11} fill="#756b60" fontFamily={CHART_FONT} textAnchor="end">time since the session started</text>
      </svg>
      {lengthKnown && !lengthKnownThroughout && <div className="activity-strip" aria-label="Editing activity for the complete record">
        <p className="muted">All {points.length} edits over time; bar height is the number of edits per interval.</p>
        <svg viewBox={`0 0 ${chartW} 56`} role="img" aria-label="Edit counts over time">
          {activity.filter(column => column.count > 0).map(column => {
            const height = Math.max(3, column.count / maxActivity * 48);
            return <rect className="activity-bar" key={`${column.start}-${column.x0}`} x={TIMELINE_PAD_L + column.x0} y={52 - height}
              width={Math.max(1, column.x1 - column.x0 - 1)} height={height} fill={`url(#${hatchId})`} stroke="#3d2f17" strokeWidth={0.8}>
              <title>{`${column.count} edits from ${formatDuration(column.start)} to ${formatDuration(column.end)}`}</title>
            </rect>;
          })}
        </svg>
      </div>}
      <div className="legend">
        {!lengthKnown && points.length > 0 && <span>bar height: edits per interval</span>}
        {lengthKnown && <span><span className="dot curve" /> document length</span>}
        {notableSources.has("paste") && <span><span className="dot source-paste" /> paste</span>}
        {notableSources.has("drop") && <span><span className="dot source-drop" /> drop</span>}
        {(notableSources.has("cut") || notableSources.has("delete")) && <span><span className="dot source-cut" /> cut or deletion</span>}
        {notableSources.has("ime") && <span><span className="dot source-ime" /> IME input</span>}
        {notableSources.has("autocomplete") && <span><span className="dot source-autocomplete" /> autocomplete</span>}
        {notableSources.has("programmatic") && <span><span className="dot source-programmatic" /> programmatic</span>}
        {hasLargeInsert && <span><span className="dot large" /> large insertion</span>}
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
  small_edit_count: "Edits that inserted or deleted only a few characters.",
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
  return (
    <TechnicalSection title="Analyzer signals">
      {signals.length === 0 ? <p className="muted">No analyzer signals were stored.</p> : signals.map((signal) => <SignalCard key={`${signal.analyzer_id}:${signal.analyzer_version}`} signal={signal} />)}
    </TechnicalSection>
  );
}

export function SignalCard({ signal }: { signal: Signal }) {
  return (
    <article className="signal-card">
      <h4>{signal.analyzer_id} <small>v{signal.analyzer_version}</small></h4>
      {!signal.applicable && <p className="pill">Not applicable</p>}
      <p>{signal.explanation}</p>
      {signal.measures.length > 0 && <dl className="measure-grid">{signal.measures.map((measure) => <React.Fragment key={measure.key}><dt><MeasureTerm name={measure.key} /></dt><dd>{measure.value === null ? "not measured" : `${String(measure.value)}${measure.unit ? ` ${measure.unit}` : ""}`}</dd></React.Fragment>)}</dl>}
    </article>
  );
}

export function VerificationPanel({ record, verification: suppliedVerification }: { record: RecordApiResponse; verification?: VerificationState }) {
  // The record's signature is the BLAKE3 record hash; the URL is derived from
  // it. We recompute it from the events in-browser so the "Computed hash" row
  // is the reader's own re-derivation, not a server claim — but we don't dress
  // it up as a verdict, because comparing it to the server's own hash field
  // is only a check of internal consistency.
  const verification = useMemo(() => suppliedVerification ?? verifyRecordChain(record), [record, suppliedVerification]);
  return (
    <TechnicalSection title="Signature & details" id={SIGNATURE_HEADING_ID}>
      <ChainStatus verification={verification} />
      <ObservationStatusLine record={record} />
      <ManifestDetails record={record} computedRecordHash={verification.computedRecordHash} />
    </TechnicalSection>
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
  if (!iso) return <span className="utc-instant unknown">not recorded</span>;
  return (
    <time className="utc-instant" dateTime={iso} title={iso}>
      {formatUtcMinute(iso)}
    </time>
  );
}

// The reader's own recomputation of the hash chain, stated plainly. This is a
// check of internal consistency (the events shown are the events signed), not
// a verdict about authorship. A failure is announced by VerificationAlert at
// the top of the page, so this block carries the details without a second
// live announcement.
function ChainStatus({ verification }: { verification: VerificationState }) {
  if (verification.pending) return <p className="chain-status" role="status">{verification.messages.join(" ")}</p>;
  if (verification.ok) {
    return (
      <p className="chain-status ok" role="status">
        <strong>Hash chain recomputed in your browser.</strong> The events and any document binding reproduce the displayed record hash. This checks internal consistency; compare an independently saved hash to check an earlier record.
      </p>
    );
  }
  const hashMismatch = verification.messages.some((message) => message.includes("record_hash mismatch"));
  return (
    <div className="chain-status error">
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
    <dl className="details manifest-details">
      <dt>Full record hash</dt><dd className="mono">{manifest.record_hash}</dd>
      {computedRecordHash && <><dt>Computed hash</dt><dd className="mono">{computedRecordHash}</dd></>}
      {manifest.parent_record && (
        <><dt>Continues from</dt><dd className="mono"><a className="parent-record-link" href={`/${manifest.parent_record}`}>{manifest.parent_record}</a></dd></>
      )}
      <dt>Producer</dt><dd>{manifest.producer.id} v{manifest.producer.version}</dd>
      <dt>Capabilities</dt><dd>{manifest.producer.capabilities.join(", ") || "none declared"}</dd>
      <dt>Server metadata</dt><dd>{manifest.ingested_server_t ? "ingestion time present" : "client-claimed time only"}</dd>
      <dt>Analyzer versions</dt><dd>{record.signals.map((signal) => `${signal.analyzer_id}@${signal.analyzer_version}`).join(", ") || "none"}</dd>
      <dt>Server-observed commitments</dt><dd><ObservationCommitmentsList commitments={record.observation.commitments} state={record.observation.state} totalCount={record.observation.checkpoint_count} /></dd>
    </dl>
  );
}

export function ObservationCommitmentsList({ commitments, state, totalCount = commitments.length }: { commitments: ObservationCommitment[]; state: RecordObservation["state"]; totalCount?: number }) {
  if (commitments.length === 0) {
    return state === "not_requested" ? <span className="muted">not requested</span> : <span className="muted">none</span>;
  }
  const summary = state === "partial"
    ? `${totalCount} server-observed commitments (partial)`
    : `${totalCount} server-observed ${totalCount === 1 ? "commitment" : "commitments"}`;
  return (
    <details className="observation-commitments" data-state={state}>
      <summary>{summary}</summary>
      {totalCount > commitments.length && <p className="muted">Showing the first checkpoint and the latest {commitments.length - 1} of {totalCount}. All stored checkpoints were checked when the record was published.</p>}
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

export function TextBindingSection({ record, verification }: { record: RecordApiResponse; verification?: VerificationState }) {
  const binding = record.manifest.text_binding;
  if (!binding) {
    return (
      <section className="record-section" aria-labelledby="check-a-document-heading">
        <h2 id="check-a-document-heading">Check a document</h2>
        <p className="section-intro">No document was bound to this record, so it has no text to check against.</p>
      </section>
    );
  }
  return (
    <>
      <DocumentCheckCard record={record} verification={verification} />
      <CommensurabilityCard record={record} />
    </>
  );
}

export function DocumentCheckCard({ record, verification: suppliedVerification }: { record: RecordApiResponse; verification?: VerificationState }) {
  const binding = record.manifest.text_binding!;
  const sessionId = record.manifest.session_id;
  const verification = useMemo(() => suppliedVerification ?? verifyRecordChain(record), [record, suppliedVerification]);
  const [candidate, setCandidate] = useState("");
  const [result, setResult] = useState<BindingCheckResult | null>(null);
  const [checkedRecordHash, setCheckedRecordHash] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  // A result belongs to the record whose binding produced it, identified by
  // its signed hash rather than by object identity across renders.
  const currentResult = verification.ok && checkedRecordHash === record.manifest.record_hash ? result : null;
  return (
    <section className="record-section document-check" id="check-a-document" aria-label="Check a document">
      <h2>Check a document</h2>
      <p className="section-intro">Have a copy of this writing? Paste it here to check whether its wording is the text the writer signed with this record. The check runs in your browser; nothing you paste is uploaded.</p>
      {!verification.ok && (verification.pending
        ? <p className="check-unavailable" role="status">Verify the full record in the edit timeline above before checking a document against it.</p>
        : <p className="check-unavailable">Checking is unavailable because this record does not verify, so its binding cannot be trusted.</p>)}
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
        placeholder="Paste the document you want to check"
        aria-label="document to check"
      />
      <div className="binding-check-actions">
        <button
          className="verify-button"
          type="button"
          disabled={!verification.ok || candidate.length === 0}
          onClick={() => {
            if (!verification.ok) return;
            setResult(checkCandidateAgainstBinding(binding, candidate, sessionId));
            setCheckedRecordHash(record.manifest.record_hash);
            setCheckedAt(new Date().toLocaleTimeString());
          }}
        >
          Check
        </button>
      </div>
      {currentResult && <BindingResult result={currentResult} />}
      {currentResult && checkedAt ? <p className="muted binding-checked-at">Checked at {checkedAt}.</p> : null}
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
            This binds only a short run of text ({formatSignedTextLength(result.canonicalLength)}), so a match on it is weak on its own; many documents share a short run.
          </p>
        )}
      </div>
    </div>
  );
}

// The comparison is left to the reader: the header states the process, and
// this section adds only the size of the text that was signed with it.
export function CommensurabilityCard({ record }: { record: RecordApiResponse }) {
  const binding = record.manifest.text_binding!;
  return (
    <section className="record-section commensurability" aria-label="How this was written">
      <h2>How this was written</h2>
      <p className="section-intro">
        The signed text has <strong>{formatSignedTextLength(binding.canonical_length)}</strong>. Set that against the writing process summarized at the top of this page: whether the two fit together is yours to weigh.
      </p>
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
  const H = 150, padL = 54, padR = 64, padT = 10, padB = 26;
  const innerW = Math.max(1, W - padL - padR);
  const innerH = H - padT - padB;
  const baseY = padT + innerH;
  const xForMs = (ms: number) => padL + (Math.log10(ms) - logMin) / span * innerW;
  const barWidth = innerW / bins.length;
  const boundaryBarWidth = 24;
  return (
    <TechnicalSection title="Writing rhythm">
      <p className="muted">Gaps between consecutive edits. The middle bars use a log scale from 16ms to 100s; separate bars show shorter and longer gaps. Bar height counts gaps.</p>
      <svg ref={chartRef} className="fingerprint-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Distribution of gaps between edits, with separate bars below 16 milliseconds and above 100 seconds">
        {FP_TICKS.map((tick) => (
          <line key={`line-${tick.ms}`} x1={xForMs(tick.ms)} y1={padT} x2={xForMs(tick.ms)} y2={baseY} className="fp-tick-line" />
        ))}
        {bins.map((bin, index) => <rect key={index} className="fp-bin" data-count={bin.count}
          x={padL + index * barWidth} y={baseY - bin.count / maxCount * innerH}
          width={Math.max(0.5, barWidth - 0.5)} height={bin.count / maxCount * innerH} fill="#8b7355">
          <title>{`${bin.count} gaps, approximately ${formatDuration(Math.round(bin.start))} to ${formatDuration(Math.round(bin.end))}`}</title>
        </rect>)}
        <rect className="fp-underflow" data-count={underflow} x={8} y={baseY - underflow / maxCount * innerH}
          width={boundaryBarWidth} height={underflow / maxCount * innerH} fill="#8b7355">
          <title>{`${underflow} gaps shorter than 16ms, including simultaneous edits`}</title>
        </rect>
        <rect className="fp-overflow" data-count={overflow} x={W - 36} y={baseY - overflow / maxCount * innerH}
          width={boundaryBarWidth} height={overflow / maxCount * innerH} fill="#8b7355">
          <title>{`${overflow} gaps longer than 100 seconds`}</title>
        </rect>
        <text x={20} y={H - 6} className="fp-label" textAnchor="middle">&lt;16ms</text>
        {FP_TICKS.map((tick) => (
          <text key={`text-${tick.ms}`} x={xForMs(tick.ms)} y={H - 6} className="fp-label" textAnchor="middle">{tick.label}</text>
        ))}
        <text x={W - 24} y={H - 6} className="fp-label" textAnchor="middle">&gt;100s</text>
      </svg>
      <p className="muted rhythm-overflow-summary">{overflow} {overflow === 1 ? "gap longer" : "gaps longer"} than 100 seconds. {underflow} shorter than 16ms, including gaps of zero milliseconds.</p>
    </TechnicalSection>
  );
}

/** One collapsed disclosure for everything a reader can verify by hand. */
export function TechnicalDetails({ open, onToggle, children }: { open: boolean; onToggle: (open: boolean) => void; children: React.ReactNode }) {
  return (
    <details id={TECHNICAL_DETAILS_ID} className="technical-details" open={open} onToggle={(event) => onToggle(event.currentTarget.open)}>
      <summary><h2>Technical details</h2></summary>
      <p className="section-intro">The hash check, capture details, and the raw measurements behind this page.</p>
      {children}
    </details>
  );
}

export function RecordFooter() {
  return (
    <footer className="record-footer">
      <div className="record-footer-rule" aria-hidden="true" />
      <p className="record-footer-mark"><img className="record-footer-seal" src="/favicon.svg" alt="" width="24" height="24" /> possiblymadebyahuman</p>
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
  const verification = useMemo(() => record ? verifyRecordChain(record) : undefined, [record]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  usePageTitle(record ? "Signed writing record" : "Writing record");
  return (
    <main className="page-shell record-page">
      <VerificationAlert verification={verification} onShowDetails={() => setDetailsOpen(true)} />
      <RecordHeader record={record} />
      <p className="visually-hidden" role="status">{record ? "Writing record loaded." : "Loading writing record…"}</p>
      {record ? <>
        <EditTimeline record={record} />
        <TextBindingSection record={record} verification={verification} />
        <TechnicalDetails open={detailsOpen} onToggle={setDetailsOpen}>
          <VerificationPanel record={record} verification={verification} />
          <TimingFingerprint record={record} />
          <TimingAndCounts record={record} />
          <SignalList signals={record.signals} />
          <CaptureContextSummary record={record} />
        </TechnicalDetails>
      </> : <div className="record-section timeline-placeholder" aria-hidden="true" />}
      <RecordFooter />
    </main>
  );
}
