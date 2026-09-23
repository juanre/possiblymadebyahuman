import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { RecordPage } from "./components.tsx";
import type { RecordApiResponse } from "./types.ts";
import { WritePage } from "./write-page.tsx";
import "./style.css";

function App() {
  const slug = window.location.pathname.replace(/^\//, "").replace(/\/$/, "") || "record";
  const isWriteRoute = slug === "write";
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ loading: boolean; error?: string; notFound?: boolean; record?: RecordApiResponse }>({ loading: !isWriteRoute });

  useEffect(() => {
    if (isWriteRoute) return;
    let cancelled = false;
    setState({ loading: true });
    async function load() {
      try {
        const response = await fetch(`/api/records/${encodeURIComponent(slug)}`);
        if (response.status === 404) {
          if (!cancelled) setState({ loading: false, notFound: true });
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
  }, [isWriteRoute, slug, attempt]);

  if (isWriteRoute) return <WritePage />;
  if (state.loading) return <RecordPage />;
  if (state.notFound) {
    return (
      <main className="page-shell">
        <p className="eyebrow"><a className="eyebrow-home" href="/">← possiblymadebyahuman</a></p>
        <h1>No record at this address</h1>
        <p>No writing record exists at <code>/{slug}</code>. Check the link you were given: a record is addressed by the short signature or full hash in its URL.</p>
        <p><a href="/">Go to the home page</a></p>
      </main>
    );
  }
  if (state.error || !state.record) {
    return (
      <main className="page-shell">
        <p className="eyebrow"><a className="eyebrow-home" href="/">← possiblymadebyahuman</a></p>
        <h1>Writing record unavailable</h1>
        <p className="error">{state.error ?? "The record could not be loaded."}</p>
        <p>This page cannot say anything about a record it could not load. Try again in a moment, or <a href="/">go to the home page</a>.</p>
        <button type="button" onClick={() => setAttempt(value => value + 1)}>Try again</button>
      </main>
    );
  }
  return <RecordPage record={state.record} />;
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
