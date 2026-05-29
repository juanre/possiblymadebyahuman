import React, { useMemo, useState } from "react";
import type { Signal } from "../../../packages/format/src/index.ts";
import type { ObservationCommitment, RecordObservation } from "../../../packages/storage/src/index.ts";
import { buildTimelinePoints, formatDuration, formatServerObservedSpan, formatUtcMinute, verifyRecordChain } from "./record-utils.ts";
import type { RecordApiResponse } from "./types.ts";

export function DisclaimerBanner() {
  return (
    <section className="banner" aria-label="What this record means">
      <strong>This is a signed writing record.</strong>
      <span> It shows the shape of an editing process. It does not prove who originated the ideas, and it is not a human/AI score.</span>
    </section>
  );
}

export function CaptureContextSummary({ record }: { record: RecordApiResponse }) {
  const context = record.manifest.capture_context;
  if (!context) return <section className="card muted"><h2>Capture context</h2><p>No capture context was included.</p></section>;
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

  // Document length over time, as a filled area under the curve.
  const areaCommands: string[] = [`M ${TIMELINE_PAD_L} ${baseline}`];
  for (const point of points) {
    areaCommands.push(`L ${tx(point.t)} ${ly(point.documentLength ?? 0)}`);
  }
  areaCommands.push(`L ${tx(duration)} ${baseline} Z`);
  const areaPath = areaCommands.join(" ");

  const pauseSpans = points.filter((point) => point.isLongPause && point.delayFromPreviousMs > 0);
  const seenSources = new Set(points.map((point) => point.source));
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
      <p className="muted">Document length and event activity over time. Bars above the curve are events colored by source; vertical bands are long pauses. No text is stored, hashed, or reconstructed.</p>
      <svg className="timeline-chart" viewBox={`0 0 ${TIMELINE_VB_W} ${TIMELINE_VB_H}`} role="img" aria-label="Content-blind edit timeline" preserveAspectRatio="xMidYMid meet">
        {pauseSpans.map((point) => {
          const startT = Math.max(0, point.t - point.delayFromPreviousMs);
          const x = tx(startT);
          const width = Math.max(2, tx(point.t) - x);
          return <rect key={`pause-${point.seq}`} x={x} y={TIMELINE_PAD_T} width={width} height={plotH} fill="#ead9b8" opacity={0.45} />;
        })}
        <line x1={TIMELINE_PAD_L} y1={baseline} x2={TIMELINE_VB_W - TIMELINE_PAD_R} y2={baseline} stroke="#d8c8a6" strokeWidth={0.6} />
        <path d={areaPath} fill="rgba(139, 94, 52, 0.18)" stroke="#8b5e34" strokeWidth={1.2} strokeLinejoin="round" />
        {points.map((point) => {
          const x = tx(point.t);
          const operationSize = (point.ins_len ?? 0) + (point.del_len ?? 0);
          const tickHeight = point.isLargeInsert ? 14 : operationSize > 1 ? 8 : 4;
          const curveY = ly(point.documentLength ?? 0);
          const top = Math.max(TIMELINE_PAD_T, curveY - tickHeight - 2);
          const height = Math.max(2, curveY - 2 - top);
          return (
            <rect
              key={point.seq}
              x={x - 0.6}
              y={top}
              width={1.2}
              height={height}
              fill={sourceFill(point.source)}
              opacity={0.85}
            >
              <title>{`seq ${point.seq} · ${point.source} · +${point.ins_len ?? "unknown"}/-${point.del_len ?? "unknown"} · len ${point.documentLength ?? "unknown"} · t=${point.t}ms`}</title>
            </rect>
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
        {seenSources.has("typing") && <><span className="dot source-typing" /> typing </>}
        {seenSources.has("paste") && <><span className="dot source-paste" /> paste </>}
        {seenSources.has("cut") && <><span className="dot source-cut" /> cut </>}
        {seenSources.has("ime") && <><span className="dot source-ime" /> IME </>}
        {seenSources.has("autocomplete") && <><span className="dot source-autocomplete" /> autocomplete </>}
        {seenSources.has("drop") && <><span className="dot source-drop" /> drop </>}
        {seenSources.has("programmatic") && <><span className="dot source-programmatic" /> programmatic </>}
        {seenSources.has("unknown") && <><span className="dot source-unknown" /> unknown </>}
        {hasLargeInsert && <><span className="dot large" /> large insert </>}
        {hasLongPause && <><span className="dot pause" /> long pause</>}
      </div>
    </section>
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
      {signal.measures.length > 0 && <dl className="measure-grid">{signal.measures.map((measure) => <React.Fragment key={measure.key}><dt>{measure.key}</dt><dd>{String(measure.value)}{measure.unit ? ` ${measure.unit}` : ""}</dd></React.Fragment>)}</dl>}
    </article>
  );
}

export function VerificationPanel({ record }: { record: RecordApiResponse }) {
  const [verification, setVerification] = useState(() => verifyRecordChain(record));
  return (
    <section className="card">
      <h2>Verification</h2>
      <ChainVerificationButton onVerify={() => setVerification(verifyRecordChain(record))} ok={verification.ok} />
      <p className={verification.ok ? "ok" : "error"}>{verification.messages.join(" ")}</p>
      <ObservationStatusLine record={record} />
      <ManifestDetails record={record} computedRecordHash={verification.computedRecordHash} />
    </section>
  );
}

export function ChainVerificationButton({ onVerify, ok }: { onVerify: () => void; ok: boolean }) {
  return <button className="verify-button" type="button" onClick={onVerify}>{ok ? "Re-verify chain" : "Retry verification"}</button>;
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

export function RecordPage({ record }: { record: RecordApiResponse }) {
  return (
    <main className="page-shell">
      <p className="eyebrow">possiblymadebyahuman</p>
      <h1>Writing record</h1>
      <DisclaimerBanner />
      <CaptureContextSummary record={record} />
      <QuickStatsPanel record={record} />
      <SignalList signals={record.signals} />
      <VerificationPanel record={record} />
      <EditTimeline record={record} />
    </main>
  );
}
