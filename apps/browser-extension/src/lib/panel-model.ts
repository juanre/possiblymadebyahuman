import { sessionEventCount, type SessionRecord } from '../../../../packages/producer-core/src/index.ts';
import type { CaptureStatus, SavedLink, SessionSummary } from './messages.ts';

export type PanelNames = { names?: Record<string, string>; next_name_index?: number };

export function ensurePanelNames(state: PanelNames, sessions: SessionRecord[]): boolean {
  let changed = false;
  const names = state.names ??= {};
  for (const session of sessions) {
    if (names[session.session_id]) continue;
    const index = state.next_name_index = (state.next_name_index ?? 0) + 1;
    let site = session.origin.origin;
    try { site = new URL(site).hostname; } catch { /* retained legacy origin */ }
    const field = session.descriptor.aria_label || (session.descriptor.tag_name === 'CONTENTEDITABLE' ? 'Editor' : 'Text field');
    names[session.session_id] = `${site.slice(0, 64)} · ${field.slice(0, 64)} · ${index}`;
    changed = true;
  }
  return changed;
}

export function sessionSummary(session: SessionRecord, displayName: string, captureStatus: CaptureStatus): SessionSummary {
  const { events, observation: _observation, ...summary } = session;
  return { ...summary, event_count: sessionEventCount(session), display_name: displayName, capture_status: captureStatus };
}

export function savedLink(session: SessionRecord, name: string): SavedLink {
  if (!session.uploaded_response) throw new Error('This record has no saved link.');
  return {
    session_id: session.session_id, name, site: session.origin.origin,
    saved_at: new Date(session.last_edit_wall_ms).toISOString(),
    url: session.uploaded_response.url, record_hash: session.uploaded_response.record_hash,
    text_check: !!session.signed_text_binding,
  };
}

export function savedPage(sessions: SessionRecord[], names: Record<string, string>, query = '', offset = 0, limit = 20) {
  const saved = sessions.filter(session => session.state === 'uploaded' && session.uploaded_response);
  saved.sort((a, b) => b.last_edit_wall_ms - a.last_edit_wall_ms || a.session_id.localeCompare(b.session_id));
  const needle = query.trim().toLocaleLowerCase();
  const matches = saved.filter(session => {
    if (!needle) return true;
    const link = savedLink(session, names[session.session_id] ?? 'Saved record');
    return [link.name, link.site, link.saved_at, link.url, link.record_hash].some(value => value.toLocaleLowerCase().includes(needle));
  });
  const size = Number.isInteger(limit) ? Math.max(1, Math.min(50, limit)) : 20;
  const lastPage = Math.floor(Math.max(0, matches.length - 1) / size) * size;
  const start = Number.isInteger(offset) ? Math.max(0, Math.min(Math.floor(offset / size) * size, lastPage)) : 0;
  return { total: saved.length, matching: matches.length, offset: start, sessions: matches.slice(start, start + size) };
}
