import React, { useMemo, useState } from "react";
import type { Signal } from "../../../packages/format/src/index.ts";
import type { ObservationCommitment, RecordObservation } from "../../../packages/storage/src/index.ts";
import { buildTimelinePoints, formatDuration, formatServerObservedSpan, formatUtcMinute, sourceClass, verifyRecordChain } from "./record-utils.ts";
import type { RecordApiResponse } from "./types.ts";

export function DisclaimerBanner() {
  return (
    <section className="banner" aria-label="What this record means">
      <strong>This is a writing record, not a verdict.</strong>
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

export function EditTimeline({ record }: { record: RecordApiResponse }) {
  const points = useMemo(() => buildTimelinePoints(record.events), [record.events]);
  const knownLengths = points.map((point) => point.documentLength).filter((length): length is number => length !== null);
  const maxLength = Math.max(1, ...knownLengths, record.stats.observed_final_length ?? 0);
  return (
    <section className="card">
      <h2>Edit timeline</h2>
      <p className="muted">Operation shape only: observed length, edit position, operation size, source, large inserts, and long pauses. No text is stored, hashed, or reconstructed.</p>
      <div className="timeline" role="img" aria-label="Content-opaque edit timeline">
        {points.map((point) => {
          const left = point.pos === null ? "0%" : `${Math.min(100, (point.pos / maxLength) * 100)}%`;
          const operationSize = (point.ins_len ?? 0) + (point.del_len ?? 0);
          const width = operationSize === 0 ? "4px" : `${Math.max(1.5, Math.min(18, (operationSize / maxLength) * 100))}%`;
          return (
            <div key={point.seq} className="timeline-row">
              <span className="timeline-label">#{point.seq}</span>
              <div className="timeline-bar">
                <span
                  className={`event-marker ${sourceClass(point.source)} ${point.isLargeInsert ? "large" : ""} ${point.isLongPause ? "pause" : ""}`}
                  style={{ left, width }}
                  title={`seq ${point.seq}: ${point.source}, +${point.ins_len ?? "unknown"}/-${point.del_len ?? "unknown"}, observed length ${point.documentLength ?? "unknown"}`}
                />
              </div>
              <span className="timeline-meta">len {point.documentLength ?? "?"}</span>
            </div>
          );
        })}
      </div>
      <div className="legend"><span className="dot source-typing" /> typing <span className="dot source-paste" /> paste <span className="dot source-cut" /> cut <span className="dot source-unknown" /> unknown <span className="dot large" /> large insert <span className="dot pause" /> long pause</div>
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
      <EditTimeline record={record} />
      <SignalList signals={record.signals} />
      <VerificationPanel record={record} />
    </main>
  );
}
