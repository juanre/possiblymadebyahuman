import React from "react";
import type { SessionRegistry } from "../../../packages/producer-core/src/index.ts";
import { draftTitle, type DraftRow } from "./drafts.ts";

type DraftListProps = {
  drafts: DraftRow[];
  registry: SessionRegistry;
  /** Whether the browser agreed to keep this site's storage under pressure. */
  persistent: boolean | null;
  /** The address named a draft that is not in this browser. */
  missing: boolean;
  onNew: () => void;
  onDelete: (draft: DraftRow) => Promise<void>;
  navigate: (path: string) => void;
};

const dateFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

function lastEdited(ms: number, now = Date.now()): string {
  const minutes = Math.round((now - ms) / 60_000);
  if (minutes < 1) return "Edited just now";
  if (minutes < 60) return `Edited ${minutes} min ago`;
  const date = new Date(ms);
  if (new Date(now).toDateString() === date.toDateString()) return `Edited at ${timeFormat.format(date)}`;
  return `Edited ${dateFormat.format(date)}`;
}

function draftStatus(draft: DraftRow, registry: SessionRegistry): { label: string; tone: "writing" | "published" | "failed" | "empty" } {
  const current = registry.get(draft.session_ids.at(-1) ?? "");
  if (current?.state === "failed_upload" || current?.state === "uploading" || current?.state === "signing") return { label: "Not published yet", tone: "failed" };
  if (current?.state === "uploaded") return { label: "Published", tone: "published" };
  if (!draft.text.trim()) return { label: "Empty", tone: "empty" };
  return { label: "Writing", tone: "writing" };
}

export function DraftList({ drafts, registry, persistent, missing, onNew, onDelete, navigate }: DraftListProps) {
  const open = (draft: DraftRow) => navigate(`/write/${encodeURIComponent(draft.draft_id)}`);
  const remove = async (draft: DraftRow) => {
    const published = draft.session_ids.some(id => registry.get(id)?.uploaded_response);
    const question = published
      ? `Delete "${draftTitle(draft)}" from this browser? Its published records stay online; their links will no longer be listed here.`
      : `Delete "${draftTitle(draft)}"? Its writing and editing history will be removed from this browser.`;
    if (!window.confirm(question)) return;
    try { await onDelete(draft); }
    catch (error) { window.alert(`The draft could not be deleted: ${error instanceof Error ? error.message : String(error)}`); }
  };

  return <main className="drafts-page">
    <p className="drafts-home"><a href="/"><span aria-hidden="true">← </span>possiblymadebyahuman</a></p>
    <div className="drafts-top">
      <h1 className="drafts-heading">Drafts</h1>
      <button className="write-button write-button-primary" type="button" onClick={onNew}>New draft</button>
    </div>
    <p className="drafts-privacy">Your drafts are saved in this browser only. When you sign one, we publish the shape of your editing; your words never leave this browser.</p>
    {missing ? <p className="drafts-problem" role="alert">That draft is not in this browser. Drafts stay in the browser where they were written.</p> : null}
    {persistent === false ? <p className="drafts-note">This browser may clear saved drafts if it runs short of space. Keep a copy of anything important.</p> : null}

    {drafts.length ? (
      <ul className="drafts-sheet" aria-label="Your drafts">
        {drafts.map(draft => {
          const status = draftStatus(draft, registry);
          const links = draft.session_ids.flatMap(id => registry.get(id)?.uploaded_response?.url ?? []);
          return <li className="draft-row" key={draft.draft_id}>
            <a className="draft-open" href={`/write/${encodeURIComponent(draft.draft_id)}`}
              onClick={event => { event.preventDefault(); open(draft); }}>
              <span className="draft-title">{draftTitle(draft)}</span>
              <span className="draft-meta">
                <span className="draft-status" data-tone={status.tone}>{status.label}</span>
                <span>{lastEdited(draft.updated_ms)}</span>
              </span>
            </a>
            {links.length ? <span className="draft-links">
              {links.map((url, index) => <a key={url} href={url} target="_blank" rel="noopener noreferrer"
                aria-label={`Published record ${index + 1} of ${draftTitle(draft)}`}>{url.replace(/^https?:\/\//, "")}</a>)}
            </span> : null}
            <button className="draft-delete" type="button" onClick={() => void remove(draft)}
              aria-label={`Delete ${draftTitle(draft)}`}>Delete</button>
          </li>;
        })}
      </ul>
    ) : (
      <div className="drafts-empty">
        <p>No drafts in this browser.</p>
        <button className="write-button write-button-primary" type="button" onClick={onNew}>Start a draft</button>
      </div>
    )}
  </main>;
}
