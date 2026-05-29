import React, { useMemo, useState } from "react";
import type { Signal } from "../../../packages/format/src/index.ts";
import type { ObservationCommitment, RecordObservation } from "../../../packages/storage/src/index.ts";
import { buildTimelinePoints, checkCandidateAgainstBinding, describeBindingMatch, formatDuration, formatServerObservedSpan, formatUtcMinute, TEXT_BINDING_DISCLAIMER, verifyRecordChain, type BindingCheckResult } from "./record-utils.ts";
import type { RecordApiResponse } from "./types.ts";

export function DisclaimerBanner() {
  return (
    <section className="banner" aria-label="What this record means">
      <strong>This is a signed writing record.</strong>
      <span> It shows the shape of an editing process. It does not prove who originated the ideas, and it is not a human/AI score.</span>
    </section>
  );
}

// Begin/end of the writing. When the server observed checkpoints, that window
// is the trusted answer. Otherwise we anchor on the trusted server upload time
// (ingested_server_t) as the end and subtract the recorded duration for the
// begin — consistent across producers and never claiming more than it knows.
function recordTimingWindow(record: RecordApiResponse): { began: string; ended: string } | null {
  const observation = record.observation;
  if (observation.first_observed_at && observation.last_observed_at) {
    return { began: observation.first_observed_at, ended: observation.last_observed_at };
  }
  const ingested = record.manifest.ingested_server_t;
  if (ingested) {
    const ended = new Date(ingested).getTime();
    return {
      began: new Date(ended - record.manifest.duration_ms).toISOString(),
      ended: new Date(ended).toISOString(),
    };
  }
  return null;
}

export function CaptureContextSummary({ record }: { record: RecordApiResponse }) {
  const context = record.manifest.capture_context;
  const timing = recordTimingWindow(record);
  const timingRows = timing ? (
    <>
      <dt>Began</dt><dd><UtcInstant iso={timing.began} /></dd>
      <dt>Ended</dt><dd><UtcInstant iso={timing.ended} /></dd>
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
  return (
    <section className="card">
      <h2>Quick facts</h2>
      <div className="stats-grid">
        <Stat label="Events" value={stats.event_count} />
        <Stat label="Duration" value={formatDuration(stats.duration_ms)} />
        <Stat label="Observed length" value={stats.observed_final_length === null ? "unknown" : `${stats.observed_final_length} codepoints`} />
        <Stat label="Typing events" value={stats.typed_event_count} />
        <Stat label="Insert / delete / replace" value={`${stats.insert_op_count} / ${stats.delete_op_count} / ${stats.replace_op_count}`} />
        <Stat label="Paste / unknown" value={`${stats.paste_event_count} / ${stats.unknown_source_count}`} />
        <Stat label="Largest atomic insert" value={`${stats.largest_atomic_insert_codepoints} codepoints`} />
        <Stat label="Active / idle" value={`${formatDuration(stats.active_time_ms)} / ${formatDuration(stats.idle_time_ms)}`} />
        <Stat label="Delay p50 / p95" value={`${stats.inter_event_delay_p50_ms ?? "n/a"}ms / ${stats.inter_event_delay_p95_ms ?? "n/a"}ms`} />
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="stat"><span>{label}</span><strong>{value}</strong></div>;
}

const TIMELINE_VB_W = 1200;
const TIMELINE_VB_H = 220;
const TIMELINE_PAD_L = 50;
const TIMELINE_PAD_R = 20;
const TIMELINE_PAD_T = 28;
const TIMELINE_PAD_B = 48;

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
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return s === 0 ? `${m}:00` : `${m}:${String(s).padStart(2, "0")}`;
}

export function EditTimeline({ record }: { record: RecordApiResponse }) {
  const points = useMemo(() => buildTimelinePoints(record.events), [record.events]);
  const knownLengths = points.map((point) => point.documentLength).filter((length): length is number => length !== null);
  const maxLength = Math.max(1, ...knownLengths, record.stats.observed_final_length ?? 0);
  const observedDurationMs = record.manifest.duration_ms || (points.length > 0 ? points[points.length - 1]!.t : 0);
  const duration = Math.max(1, observedDurationMs);
  const plotW = TIMELINE_VB_W - TIMELINE_PAD_L - TIMELINE_PAD_R;
  const plotH = TIMELINE_VB_H - TIMELINE_PAD_T - TIMELINE_PAD_B;
  const baseline = TIMELINE_PAD_T + plotH;
  const tx = (t: number) => TIMELINE_PAD_L + (Math.min(duration, Math.max(0, t)) / duration) * plotW;
  const ly = (len: number) => baseline - (Math.min(maxLength, Math.max(0, len)) / maxLength) * plotH;

  // Document length over time. The fill closes down to the baseline at both
  // ends (correct for an area); the stroked line traces ONLY the curve, so it
  // does not follow the closing edge back to zero at the end.
  const areaCommands: string[] = [`M ${TIMELINE_PAD_L} ${baseline}`];
  for (const point of points) {
    areaCommands.push(`L ${tx(point.t)} ${ly(point.documentLength ?? 0)}`);
  }
  // Close the fill straight down at the LAST data point, not out at the (often
  // later) duration mark — otherwise the fill slopes diagonally to zero at the
  // end and reads as the document length collapsing.
  const lastX = points.length > 0 ? tx(points[points.length - 1]!.t) : TIMELINE_PAD_L;
  areaCommands.push(`L ${lastX} ${baseline} Z`);
  const areaPath = areaCommands.join(" ");
  const linePath = points.map((point, index) => `${index === 0 ? "M" : "L"} ${tx(point.t)} ${ly(point.documentLength ?? 0)}`).join(" ");

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
  const tickEverySeconds = totalSeconds < 60 ? 10 : totalSeconds < 300 ? 30 : totalSeconds < 1200 ? 60 : 300;
  const ticks: number[] = [];
  for (let seconds = 0; seconds <= totalSeconds; seconds += tickEverySeconds) ticks.push(seconds);
  if (ticks.at(-1) !== Math.floor(totalSeconds)) ticks.push(totalSeconds);

  return (
    <section className="card timeline-card">
      <h2>Edit timeline</h2>
      <p className="muted">Document length over time. Pastes, cuts, and large inserts are marked on the curve; shaded bands are long pauses. Steady typing is the rising line itself.</p>
      <svg className="timeline-chart" viewBox={`0 0 ${TIMELINE_VB_W} ${TIMELINE_VB_H}`} role="img" aria-label="Content-blind edit timeline" preserveAspectRatio="xMidYMid meet">
        {pauseSpans.map((point) => {
          const startT = Math.max(0, point.t - point.delayFromPreviousMs);
          const x = tx(startT);
          const width = Math.max(2, tx(point.t) - x);
          return <rect key={`pause-${point.seq}`} x={x} y={TIMELINE_PAD_T} width={width} height={plotH} fill="#ead9b8" opacity={0.45} />;
        })}
        <line x1={TIMELINE_PAD_L} y1={baseline} x2={TIMELINE_VB_W - TIMELINE_PAD_R} y2={baseline} stroke="#d8c8a6" strokeWidth={0.6} />
        <path d={areaPath} fill="rgba(139, 94, 52, 0.18)" stroke="none" />
        <path d={linePath} fill="none" stroke="#8b5e34" strokeWidth={1.2} strokeLinejoin="round" strokeLinecap="round" />
        {notable.map((point) => {
          const x = tx(point.t);
          const y = ly(point.documentLength ?? 0);
          const r = point.isLargeInsert ? 4.5 : 3.2;
          return (
            <circle key={point.seq} cx={x} cy={y} r={r} fill={sourceFill(point.source)} stroke="#fffaf2" strokeWidth={1.2}>
              <title>{`seq ${point.seq} · ${point.source} · +${point.ins_len ?? "unknown"}/-${point.del_len ?? "unknown"} · len ${point.documentLength ?? "unknown"} · t=${point.t}ms`}</title>
            </circle>
          );
        })}
        <text x={TIMELINE_PAD_L - 6} y={TIMELINE_PAD_T + 4} fontSize={11} fill="#756b60" fontFamily="ui-monospace, monospace" textAnchor="end">{maxLength} cp</text>
        <text x={TIMELINE_PAD_L - 6} y={baseline + 4} fontSize={11} fill="#756b60" fontFamily="ui-monospace, monospace" textAnchor="end">0</text>
        {ticks.map((seconds) => {
          const x = tx(seconds * 1000);
          return (
            <g key={`tick-${seconds}`}>
              <line x1={x} y1={baseline} x2={x} y2={baseline + 4} stroke="#a89a82" strokeWidth={0.6} />
              <text x={x} y={baseline + 18} fontSize={11} fill="#756b60" fontFamily="ui-monospace, monospace" textAnchor="middle">{formatTimelineTick(seconds)}</text>
            </g>
          );
        })}
        <text x={TIMELINE_VB_W - TIMELINE_PAD_R} y={baseline + 34} fontSize={10} fill="#a89a82" fontFamily="ui-monospace, monospace" textAnchor="end">time →</text>
      </svg>
      <div className="legend">
        <span className="dot curve" /> document length{" "}
        {notableSources.has("paste") && <><span className="dot source-paste" /> paste </>}
        {notableSources.has("drop") && <><span className="dot source-drop" /> drop </>}
        {(notableSources.has("cut") || notableSources.has("delete")) && <><span className="dot source-cut" /> cut/delete </>}
        {notableSources.has("ime") && <><span className="dot source-ime" /> IME </>}
        {notableSources.has("autocomplete") && <><span className="dot source-autocomplete" /> autocomplete </>}
        {notableSources.has("programmatic") && <><span className="dot source-programmatic" /> programmatic </>}
        {hasLargeInsert && <><span className="dot large" /> large insert </>}
        {hasLongPause && <><span className="dot pause" /> long pause</>}
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
  active_time_ms: "Total time spent actively editing — the sum of gaps shorter than 30 seconds.",
  idle_time_ms: "Total time paused — the sum of gaps of 30 seconds or more.",
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
  const observation = record.observation;
  const showObservation = observation.state === "observed" || observation.state === "partial";
  return (
    <section className="card">
      <h2>Signature &amp; details</h2>
      {showObservation ? <ObservationStatusLine record={record} /> : null}
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
        body: "No server commitment was received for this session. The hash chain in this record is still verifiable in your browser; the server cannot confirm when it saw the editing process.",
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

export function ManifestDetails({ record, computedRecordHash }: { record: RecordApiResponse; computedRecordHash?: string }) {
  const manifest = record.manifest;
  return (
    <dl className="details mono">
      <dt>Full record hash</dt><dd>{manifest.record_hash}</dd>
      {computedRecordHash && <><dt>Computed hash</dt><dd>{computedRecordHash}</dd></>}
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
      <p className="muted">Have a copy of this writing? Paste it below and your browser tells you whether it is the text signed here — comparing wording, not exact text. (The Check button turns on once you paste something.)</p>
      <p className="binding-check-privacy">Runs entirely in your browser — the document you paste is never uploaded.</p>
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
            This binds only a short run of text ({result.canonicalLength} letters), so a match on it is weak on its own — many documents share a short run.
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
      <p className="muted">A separate judgment, for you to make — not an automated result. Weigh the signed size against the recorded process.</p>
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

const FP_MIN_MS = 16;
const FP_MAX_MS = 100_000;
const FP_BINS = 40;
const FP_TICKS: { ms: number; label: string }[] = [
  { ms: 100, label: "100ms" },
  { ms: 1000, label: "1s" },
  { ms: 10000, label: "10s" },
  { ms: 60000, label: "1m" },
];

// A "fingerprint" of the writing rhythm: a finely log-bucketed distribution of
// time between consecutive edits, drawn as a continuous area + line. Log bins
// keep the typing cadence crisp while long pauses fall into the right tail, so
// a single big pause never flattens the curve.
export function TimingFingerprint({ record }: { record: RecordApiResponse }) {
  const points = buildTimelinePoints(record.events);
  const delays = points.filter((point) => point.seq > 0).map((point) => point.delayFromPreviousMs).filter((delay) => delay > 0);
  if (delays.length === 0) return null;
  const logMin = Math.log10(FP_MIN_MS);
  const span = Math.log10(FP_MAX_MS) - logMin;
  const counts = new Array(FP_BINS).fill(0) as number[];
  for (const delay of delays) {
    const clamped = Math.min(FP_MAX_MS, Math.max(FP_MIN_MS, delay));
    const index = Math.min(FP_BINS - 1, Math.max(0, Math.floor(((Math.log10(clamped) - logMin) / span) * FP_BINS)));
    counts[index] += 1;
  }
  const maxCount = Math.max(...counts, 1);
  const stats = record.stats;
  const W = 660, H = 150, padL = 8, padR = 8, padT = 10, padB = 26;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const baseY = padT + innerH;
  const xForFrac = (frac: number) => padL + frac * innerW;
  const xForBin = (index: number) => xForFrac((index + 0.5) / FP_BINS);
  const yForCount = (count: number) => baseY - (count / maxCount) * innerH;
  const xForMs = (ms: number) => xForFrac((Math.log10(ms) - logMin) / span);
  const linePoints = counts.map((count, index) => `${xForBin(index).toFixed(1)},${yForCount(count).toFixed(1)}`).join(" ");
  const areaPath =
    `M ${xForBin(0).toFixed(1)},${baseY} ` +
    counts.map((count, index) => `L ${xForBin(index).toFixed(1)},${yForCount(count).toFixed(1)}`).join(" ") +
    ` L ${xForBin(FP_BINS - 1).toFixed(1)},${baseY} Z`;
  return (
    <section className="card fingerprint-card" aria-label="Writing rhythm">
      <h2>Writing rhythm</h2>
      <p className="muted">Time between consecutive edits, on a log scale.</p>
      <svg className="fingerprint-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Distribution of time between edits">
        {FP_TICKS.map((tick) => (
          <line key={`line-${tick.ms}`} x1={xForMs(tick.ms)} y1={padT} x2={xForMs(tick.ms)} y2={baseY} className="fp-tick-line" />
        ))}
        <path d={areaPath} className="fp-area" />
        <polyline points={linePoints} className="fp-line" />
        {FP_TICKS.map((tick) => (
          <text key={`text-${tick.ms}`} x={xForMs(tick.ms)} y={H - 6} className="fp-label">{tick.label}</text>
        ))}
      </svg>
      <dl className="fingerprint-stats">
        <div><dt>Edits</dt><dd>{stats.event_count}</dd></div>
        <div><dt>Duration</dt><dd>{formatDuration(stats.duration_ms)}</dd></div>
        <div><dt>Median gap</dt><dd>{stats.inter_event_delay_p50_ms === null ? "n/a" : `${stats.inter_event_delay_p50_ms}ms`}</dd></div>
        <div><dt>Longest pause</dt><dd>{stats.inter_event_delay_max_ms === null ? "n/a" : formatDuration(stats.inter_event_delay_max_ms)}</dd></div>
      </dl>
    </section>
  );
}

export function RecordSignet({ record }: { record: RecordApiResponse }) {
  const bound = !!record.manifest.text_binding;
  return (
    <header className="signet">
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
          <h1>Signed writing record</h1>
          <p className="signet-statement">
            Signs the <strong>shape of the writing process</strong>
            {bound ? <> and the <strong>text it produced</strong></> : null}.
          </p>
        </div>
      </div>
      <p className="signet-orient">A timestamped, tamper-evident record of how this text was written. <a href="/docs/product-promise/">What is this?</a></p>
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
        <a href="/docs/product-promise/">What this is</a>
        <a href="/docs/checking-a-document/">How checking works</a>
        <a href="/docs/verification/">Verify a record</a>
        <a href="https://github.com/juanre/possiblymadebyahuman" rel="noopener">Source</a>
      </nav>
      <p className="record-footer-note muted">Content-blind: this page never stores or shows your text.</p>
    </footer>
  );
}

export function RecordPage({ record }: { record: RecordApiResponse }) {
  return (
    <main className="page-shell record-page">
      <RecordSignet record={record} />
      <TimingFingerprint record={record} />
      <TextBindingSection record={record} />
      <CaptureContextSummary record={record} />
      <QuickStatsPanel record={record} />
      <EditTimeline record={record} />
      <SignalList signals={record.signals} />
      <VerificationPanel record={record} />
      <DisclaimerBanner />
      <RecordFooter />
    </main>
  );
}
