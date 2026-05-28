import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { RecordPage } from "./components.tsx";
import type { RecordApiResponse } from "./types.ts";
import { WritePage } from "./write-page.tsx";
import "./style.css";

function App() {
  const slug = window.location.pathname.replace(/^\//, "").replace(/\/$/, "") || "record";
  const isWriteRoute = slug === "write";
  const [state, setState] = useState<{ loading: boolean; error?: string; record?: RecordApiResponse }>({ loading: !isWriteRoute });

  useEffect(() => {
    if (isWriteRoute) return;
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch(`/api/records/${encodeURIComponent(slug)}`);
        if (!response.ok) throw new Error(`Record fetch failed (${response.status})`);
        const record = await response.json() as RecordApiResponse;
        if (!cancelled) setState({ loading: false, record });
      } catch (error) {
        if (!cancelled) setState({ loading: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [isWriteRoute, slug]);

  if (isWriteRoute) return <WritePage />;
  if (state.loading) return <main className="page-shell"><p className="eyebrow">possiblymadebyahuman</p><h1>Writing record</h1><p>Loading writing record…</p></main>;
  if (state.error || !state.record) return <main className="page-shell"><p className="eyebrow">possiblymadebyahuman</p><h1>Writing record unavailable</h1><p className="error">{state.error ?? "Record not found"}</p><p>This page cannot make a claim without a record to inspect.</p></main>;
  return <RecordPage record={state.record} />;
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
