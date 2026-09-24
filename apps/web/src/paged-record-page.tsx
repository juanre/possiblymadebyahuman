import React, { useEffect, useRef, useState } from "react";
import {
  CaptureContextSummary,
  DisclaimerBanner,
  QuickStatsPanel,
  RecordFooter,
  RecordSignet,
  SignalList,
  TextBindingSection,
  VerificationPanel,
} from "./components.tsx";
import type { RecordApiResponse, VerificationState } from "./types.ts";
import type { RecordOverview } from "./stream-record.ts";
import type { VerificationResult } from "../../../packages/format/src/index.ts";
import { formatDuration } from "./record-utils.ts";

export type RecordSummary = Omit<RecordApiResponse, "events"> & {
  first_event_t: number;
  last_event_t: number;
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
  const worker = useRef<Worker | null>(null);
  useEffect(() => () => worker.current?.terminate(), []);
  // Summary timing is separate from event arrays; no fake endpoint events.
  const record: RecordApiResponse = {
    ...summary,
    events: [],
    event_times: { first: summary.first_event_t, last: summary.last_event_t },
  };
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
    const failed = (message: string) => {
      setRunning(false);
      setVerification({ ok: false, messages: [message] });
      current.terminate();
    };
    current.onerror = () =>
      failed("The record verification worker failed. You can retry.");
    current.onmessage = (
      message: MessageEvent<{
        type: string;
        count?: number;
        message?: string;
        verification?: VerificationResult;
        overview?: RecordOverview;
      }>,
    ) => {
      if (worker.current !== current) return;
      const value = message.data;
      if (value.type === "progress") setCount(value.count ?? 0);
      if (value.type === "error")
        failed(value.message ?? "Record verification failed.");
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
  return (
    <main className="page-shell record-page">
      <RecordSignet record={record} />
      <section className="card" aria-label="Full record verification">
        <h2>Verify the event log</h2>
        <p>
          This record contains {summary.manifest.event_count.toLocaleString()}{" "}
          events. Its summary loads first. Full verification downloads every
          event in bounded pages and checks the hash in your browser.
        </p>
        {running ? (
          <>
            <p role="status">
              Verified {count.toLocaleString()} of{" "}
              {summary.manifest.event_count.toLocaleString()} events…
            </p>
            <button
              onClick={() => {
                worker.current?.terminate();
                worker.current = null;
                setRunning(false);
                setVerification({
                  ok: false,
                  pending: true,
                  messages: [
                    "Verification stopped before the full record was checked.",
                  ],
                });
              }}
            >
              Stop verification
            </button>
          </>
        ) : (
          !verification.ok && (
            <button onClick={verify}>Verify full record</button>
          )
        )}
      </section>
      <TextBindingSection record={record} verification={verification} />
      <CaptureContextSummary record={record} />
      <QuickStatsPanel record={record} />
      {overview && <StreamedOverview overview={overview} />}
      <SignalList signals={record.signals} />
      <VerificationPanel record={record} verification={verification} />
      <DisclaimerBanner />
      <RecordFooter />
    </main>
  );
}

function StreamedOverview({ overview }: { overview: RecordOverview }) {
  const maximum = Math.max(1, ...overview.bins.map((bin) => bin.count));
  return (
    <section className="card timeline-card">
      <h2>Edit timeline</h2>
      <p>
        All verified edits grouped into {overview.bins.length} equal time
        intervals. Bar height shows event count; it does not reconstruct
        document text or show individual keystrokes.
      </p>
      <svg
        viewBox="0 0 1024 160"
        role="img"
        aria-label="Verified editing activity across the full record"
      >
        {overview.bins.map((bin, i) => (
          <rect
            key={i}
            x={i * 8}
            y={150 - (140 * bin.count) / maximum}
            width={7}
            height={(140 * bin.count) / maximum}
            fill="#769bc7"
          >
            <title>{`${formatDuration(bin.start)}–${formatDuration(bin.end)}: ${bin.count} edits${bin.minimum_length === null ? "" : `; measured lengths ${bin.minimum_length}–${bin.maximum_length} codepoints`}`}</title>
          </rect>
        ))}
      </svg>
    </section>
  );
}
