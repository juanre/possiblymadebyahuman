import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  CaptureContextSummary,
  PencilHatch,
  RecordFooter,
  RecordHeader,
  SignalList,
  TechnicalDetails,
  TextBindingSection,
  TimingAndCounts,
  usePageTitle,
  VerificationAlert,
  VerificationPanel,
} from "./components.tsx";
import type { RecordApiResponse, VerificationState } from "./types.ts";
import type { RecordOverview } from "./stream-record.ts";
import type { VerificationResult } from "../../../packages/format/src/index.ts";
import { formatCharacters, formatDuration } from "./record-utils.ts";

export type RecordSummary = Omit<RecordApiResponse, "events"> & {
  first_event_t: number;
  last_event_t: number;
};

type WorkerMessage = {
  type: "progress" | "unavailable" | "error" | "complete";
  count?: number;
  message?: string;
  verification?: VerificationResult;
  overview?: RecordOverview;
};

export function PagedRecordPage({ summary }: { summary: RecordSummary }) {
  const [verification, setVerification] = useState<VerificationState>({
    ok: false,
    pending: true,
    messages: ["The event log has not been downloaded and verified."],
  });
  const [count, setCount] = useState(0);
  const [running, setRunning] = useState(false);
  const [overview, setOverview] = useState<RecordOverview>();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const worker = useRef<Worker | null>(null);
  useEffect(() => () => worker.current?.terminate(), []);
  usePageTitle("Signed writing record");
  // Summary timing is separate from event arrays; no fake endpoint events.
  // One record object per summary, so state tied to it survives re-renders.
  const record = useMemo<RecordApiResponse>(
    () => ({
      ...summary,
      events: [],
      event_times: { first: summary.first_event_t, last: summary.last_event_t },
    }),
    [summary],
  );
  const verify = () => {
    worker.current?.terminate();
    setCount(0);
    setRunning(true);
    setVerification({
      ok: false,
      pending: true,
      messages: ["Verifying the full event log in bounded pages."],
    });
    const current = new Worker(
      new URL("./record-verifier.worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.current = current;
    const stopped = (next: VerificationState) => {
      setRunning(false);
      setVerification(next);
      current.terminate();
    };
    // A download that could not finish leaves the record unverified, not failed.
    const interrupted = (message: string) =>
      stopped({ ok: false, pending: true, messages: [message] });
    current.onerror = () =>
      interrupted("The record verification worker failed. You can retry.");
    current.onmessage = (message: MessageEvent<WorkerMessage>) => {
      if (worker.current !== current) return;
      const value = message.data;
      if (value.type === "progress") setCount(value.count ?? 0);
      if (value.type === "unavailable")
        interrupted(`${value.message ?? "An event page could not be loaded."} You can retry.`);
      if (value.type === "error")
        stopped({ ok: false, messages: [value.message ?? "Record verification failed."] });
      if (value.type === "complete" && value.verification) {
        setVerification({
          ok: value.verification.valid,
          messages: value.verification.errors,
          computedRecordHash: value.verification.computedRecordHash,
        });
        setOverview(value.verification.valid ? value.overview : undefined);
        setRunning(false);
        current.terminate();
      }
    };
    current.postMessage({ manifest: summary.manifest });
  };
  const stop = () => {
    worker.current?.terminate();
    worker.current = null;
    setRunning(false);
    setVerification({
      ok: false,
      pending: true,
      messages: ["Verification stopped before the full record was checked."],
    });
  };
  return (
    <main className="page-shell record-page">
      <VerificationAlert verification={verification} onShowDetails={() => setDetailsOpen(true)} />
      <RecordHeader record={record} verification={verification} checking={running} onShowDetails={() => setDetailsOpen(true)} />
      {overview ? (
        <StreamedOverview overview={overview} durationMs={summary.manifest.duration_ms} />
      ) : (
        <section className="record-section edit-timeline" aria-labelledby="edit-timeline-heading">
          <h2 id="edit-timeline-heading">Edit timeline</h2>
          <p className="section-intro">
            This record has {summary.manifest.event_count.toLocaleString("en-US")}{" "}
            events. Your browser downloads and verifies all of them in pages,
            checking the hash as it goes, and then draws the timeline.
          </p>
          {running ? (
            <div className="verify-progress">
              <p role="status">
                Verified {count.toLocaleString("en-US")} of{" "}
                {summary.manifest.event_count.toLocaleString("en-US")} events…
              </p>
              <progress max={summary.manifest.event_count} value={count} aria-hidden="true" />
              <button type="button" className="secondary-button" onClick={stop}>
                Stop verification
              </button>
            </div>
          ) : (
            !verification.ok && (
              <button type="button" className="verify-button" onClick={verify}>Verify full record</button>
            )
          )}
          {!running && verification.pending && verification.messages.length > 0 && count > 0 && (
            <p className="muted">{verification.messages.join(" ")}</p>
          )}
        </section>
      )}
      <TextBindingSection record={record} verification={verification} />
      <TechnicalDetails open={detailsOpen} onToggle={setDetailsOpen}>
        <VerificationPanel record={record} verification={verification} />
        <TimingAndCounts record={record} />
        <SignalList signals={record.signals} />
        <CaptureContextSummary record={record} />
      </TechnicalDetails>
      <RecordFooter />
    </main>
  );
}

function StreamedOverview({ overview, durationMs }: { overview: RecordOverview; durationMs: number }) {
  const hatchId = `pencil-hatch-${useId().replace(/:/g, "")}`;
  const maximum = Math.max(1, ...overview.bins.map((bin) => bin.count));
  return (
    <section className="record-section edit-timeline" aria-labelledby="edit-timeline-heading">
      <h2 id="edit-timeline-heading">Edit timeline</h2>
      <p className="section-intro">
        All verified edits grouped into {overview.bins.length} equal time
        intervals. Bar height shows the number of edits; it does not
        reconstruct document text or show individual keystrokes.
      </p>
      <svg
        className="overview-chart"
        viewBox="0 0 1024 180"
        preserveAspectRatio="none"
        role="img"
        aria-label="Verified editing activity across the full record"
      >
        <PencilHatch id={hatchId} />
        {overview.bins.map((bin, i) => (
          <rect
            key={i}
            x={i * 8}
            y={176 - (164 * bin.count) / maximum}
            width={7}
            height={(164 * bin.count) / maximum}
            fill={`url(#${hatchId})`}
            stroke="#3d2f17"
            strokeWidth={0.8}
            vectorEffect="non-scaling-stroke"
          >
            <title>{`${formatDuration(bin.start)}–${formatDuration(bin.end)}: ${bin.count} edits${bin.minimum_length === null ? "" : `; measured lengths ${bin.minimum_length}–${formatCharacters(bin.maximum_length)}`}`}</title>
          </rect>
        ))}
        <line x1={0} y1={176.5} x2={1024} y2={176.5} stroke="#3d2f17" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      </svg>
      <p className="overview-axis" aria-hidden="true">
        <span>0:00</span>
        <span>{formatDuration(durationMs)}</span>
      </p>
    </section>
  );
}
