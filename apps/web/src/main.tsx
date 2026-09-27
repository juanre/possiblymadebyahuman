import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { HomeLink, RecordPage, usePageTitle } from "./components.tsx";
import type { RecordApiResponse } from "./types.ts";
import { PagedRecordPage, type RecordSummary } from "./paged-record-page.tsx";
import { WritePage } from "./write-page.tsx";
import "./style.css";

function App() {
  const slug = window.location.pathname.replace(/^\//, "").replace(/\/$/, "");
  const isWriteRoute = slug === "write";
  // The site owns the bare root; there is no record to load at that address.
  const hasRecordAddress = slug !== "";
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ loading: boolean; error?: string; notFound?: boolean; record?: RecordApiResponse; summary?: RecordSummary }>({ loading: !isWriteRoute && hasRecordAddress });

  useEffect(() => {
    if (isWriteRoute || !hasRecordAddress) return;
    let cancelled = false;
    setState({ loading: true });
    async function load() {
      try {
        const response = await fetch(`/api/records/${encodeURIComponent(slug)}`);
        if (response.status === 404) {
          if (!cancelled) setState({ loading: false, notFound: true });
          return;
        }
        if (response.status === 409) {
          const reason = await response.json();
          if (reason.error !== "chunked_record_requires_pagination") throw new Error("Record could not be loaded");
          const summaryResponse = await fetch(`/api/records/${encodeURIComponent(slug)}/summary`);
          if (!summaryResponse.ok) throw new Error(`Record summary fetch failed (${summaryResponse.status})`);
          const summary = await summaryResponse.json() as RecordSummary;
          if (!cancelled) setState({ loading: false, summary });
          return;
        }
        if (!response.ok) throw new Error(`Record fetch failed (${response.status})`);
        const record = await response.json() as RecordApiResponse;
        if (!cancelled) setState({ loading: false, record });
      } catch (error) {
        if (!cancelled) setState({ loading: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [isWriteRoute, hasRecordAddress, slug, attempt]);

  if (isWriteRoute) return <WritePage />;
  if (!hasRecordAddress) return <MissingRecordAddress />;
  if (state.loading) return <RecordPage />;
  if (state.notFound) return <RecordNotFound slug={slug} />;
  if (state.summary) return <PagedRecordPage key={state.summary.manifest.record_hash} summary={state.summary} />;
  if (state.error || !state.record) {
    return <RecordUnavailable message={state.error} onRetry={() => setAttempt(value => value + 1)} />;
  }
  return <RecordPage record={state.record} />;
}

function MissingRecordAddress() {
  usePageTitle("No record address");
  return (
    <main className="page-shell record-message">
      <HomeLink />
      <h1>No record address</h1>
      <p>This page shows a writing record when you open the link to one. A record link ends with the record's short signature or full hash.</p>
      <p><a href="/docs/what-pmbah-does/">Read what writing records are</a></p>
    </main>
  );
}

function RecordNotFound({ slug }: { slug: string }) {
  usePageTitle("No record at this address");
  return (
    <main className="page-shell record-message">
      <HomeLink />
      <h1>No record at this address</h1>
      <p>No writing record exists at <code>/{slug}</code>. Check the link you were given: a record is addressed by the short signature or full hash in its URL.</p>
      <p><a href="/">Go to the home page</a></p>
    </main>
  );
}

function RecordUnavailable({ message, onRetry }: { message?: string; onRetry: () => void }) {
  usePageTitle("Writing record unavailable");
  return (
    <main className="page-shell record-message">
      <HomeLink />
      <h1>Writing record unavailable</h1>
      <p className="error">{message ?? "The record could not be loaded."}</p>
      <p>This page cannot say anything about a record it could not load. Try again in a moment, or <a href="/">go to the home page</a>.</p>
      <button type="button" className="secondary-button" onClick={onRetry}>Try again</button>
    </main>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
