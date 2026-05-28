import React from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

function RecordShell() {
  const slug = window.location.pathname.replace(/^\//, "") || "record";
  return (
    <main className="shell">
      <p className="eyebrow">possiblymadebyahuman</p>
      <h1>Writing record</h1>
      <p>
        This placeholder shell is reserved for record <code>{slug}</code>. The public
        record page will show replay structure, facts, and verification status — not a
        human/AI verdict.
      </p>
      <p className="note">
        M2.x only wires container routing and static serving. The full record UI arrives in M4.
      </p>
    </main>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RecordShell />
  </React.StrictMode>,
);
