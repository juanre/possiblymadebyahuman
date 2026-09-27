import type { SessionRecord } from "../../../packages/producer-core/src/index.ts";

/**
 * A /write draft: the writer's text, kept only in this browser, plus the
 * writing sessions recorded for it (oldest first; the last one is current).
 * `text_tag` names the recorded chain position the saved text corresponds
 * to, so a restored draft resumes without a gap only when they agree.
 */
export type DraftRow = {
  draft_id: string;
  name: string | null;
  text: string;
  text_tag: { session_id: string; event_count: number; chain_tip: string | null } | null;
  session_ids: string[];
  created_ms: number;
  updated_ms: number;
};

const TITLE_LENGTH = 60;

export function draftTitle(draft: Pick<DraftRow, "name" | "text">): string {
  const name = draft.name?.trim();
  if (name) return name;
  const line = draft.text.split("\n").map(value => value.replace(/\s+/g, " ").trim()).find(Boolean);
  if (!line) return "Untitled draft";
  const characters = Array.from(line);
  return characters.length > TITLE_LENGTH ? `${characters.slice(0, TITLE_LENGTH - 1).join("")}…` : line;
}

type SessionSummary = Pick<SessionRecord, "session_id" | "state" | "base_wall_ms" | "last_edit_wall_ms" | "capture_context" | "parent_record" | "uploaded_response">;

/**
 * Drafts that must be written so every /write session belongs to one draft.
 * Unowned continuations join the draft of the record they continue; other
 * unowned sessions become drafts with no text, one per continuation chain.
 */
export function adoptSessions(drafts: DraftRow[], sessions: SessionSummary[], uuid: () => string): DraftRow[] {
  const writeSessions = sessions.filter(entry => entry.capture_context?.surface === "web-draft");
  const byId = new Map(writeSessions.map(entry => [entry.session_id, entry]));
  const byRecordHash = new Map(writeSessions.flatMap(entry => entry.uploaded_response ? [[entry.uploaded_response.record_hash, entry] as const] : []));
  const owner = new Map<string, DraftRow>();
  const rows = drafts.map(row => ({ ...row, session_ids: [...row.session_ids] }));
  for (const row of rows) for (const id of row.session_ids) owner.set(id, row);
  const changed = new Set<DraftRow>();
  const chainRoot = (entry: SessionSummary): SessionSummary => {
    const seen = new Set<string>();
    let current = entry;
    while (current.parent_record && !seen.has(current.session_id)) {
      seen.add(current.session_id);
      const parent = byRecordHash.get(current.parent_record);
      if (!parent || owner.has(parent.session_id)) break;
      current = parent;
    }
    return current;
  };
  const ordered = [...writeSessions].sort((a, b) => a.base_wall_ms - b.base_wall_ms || a.last_edit_wall_ms - b.last_edit_wall_ms);
  for (const entry of ordered) {
    if (owner.has(entry.session_id)) continue;
    const parent = entry.parent_record ? byRecordHash.get(entry.parent_record) : undefined;
    let row = parent ? owner.get(parent.session_id) : undefined;
    if (!row) {
      const root = chainRoot(entry);
      row = root !== entry ? owner.get(root.session_id) : undefined;
      if (!row) {
        row = { draft_id: uuid(), name: null, text: "", text_tag: null, session_ids: [],
          created_ms: root.base_wall_ms, updated_ms: root.last_edit_wall_ms };
        rows.push(row);
      }
    }
    const lineage: SessionSummary[] = [];
    for (let current: SessionSummary | undefined = entry; current && !owner.has(current.session_id);
      current = current.parent_record ? byRecordHash.get(current.parent_record) : undefined) lineage.unshift(current);
    for (const member of lineage) {
      row.session_ids.push(member.session_id);
      owner.set(member.session_id, row);
      row.updated_ms = Math.max(row.updated_ms, member.last_edit_wall_ms);
    }
    changed.add(row);
  }
  for (const row of changed) row.session_ids.sort((a, b) => (byId.get(a)?.base_wall_ms ?? 0) - (byId.get(b)?.base_wall_ms ?? 0));
  return [...changed];
}

const result = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
});
const complete = (transaction: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
});

/** Draft text lives in its own database, apart from the content-blind event journal. */
export class DraftStore {
  readonly #name: string;
  readonly #factory?: IDBFactory;
  #database?: Promise<IDBDatabase>;

  constructor(options: { name?: string; factory?: IDBFactory } = {}) {
    this.#name = options.name ?? "pmbah.write.drafts.v1";
    this.#factory = options.factory;
  }

  #open(): Promise<IDBDatabase> {
    if (this.#database) return this.#database;
    const factory = this.#factory ?? globalThis.indexedDB;
    if (!factory) return Promise.reject(new Error("This browser cannot store drafts (IndexedDB is unavailable)"));
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(this.#name, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore("drafts", { keyPath: "draft_id" }); };
      request.onsuccess = () => {
        request.result.onversionchange = () => { request.result.close(); this.#database = undefined; };
        resolve(request.result);
      };
      request.onerror = () => reject(request.error ?? new Error("The drafts database could not be opened"));
      request.onblocked = () => reject(new Error("Another tab blocked the drafts database upgrade"));
    });
    this.#database = opening;
    void opening.catch(() => { if (this.#database === opening) this.#database = undefined; });
    return opening;
  }

  async list(): Promise<DraftRow[]> {
    const database = await this.#open();
    const rows = await result(database.transaction("drafts", "readonly").objectStore("drafts").getAll()) as DraftRow[];
    return rows.sort((a, b) => b.updated_ms - a.updated_ms);
  }

  async get(draft_id: string): Promise<DraftRow | undefined> {
    const database = await this.#open();
    return await result(database.transaction("drafts", "readonly").objectStore("drafts").get(draft_id)) as DraftRow | undefined;
  }

  async put(...rows: DraftRow[]): Promise<void> {
    const database = await this.#open();
    const transaction = database.transaction("drafts", "readwrite", { durability: "strict" });
    const done = complete(transaction);
    for (const row of rows) transaction.objectStore("drafts").put(row);
    await done;
  }

  async delete(draft_id: string): Promise<void> {
    const database = await this.#open();
    const transaction = database.transaction("drafts", "readwrite", { durability: "strict" });
    const done = complete(transaction);
    transaction.objectStore("drafts").delete(draft_id);
    await done;
  }
}

/**
 * Serializes writes of a frequently changing value: only the latest pending
 * value is written, writes never overlap, and a failed value stays pending
 * until a later flush succeeds or a newer value replaces it.
 */
export function createCoalescingWriter<T>(write: (value: T) => Promise<void>, delayMs = 400) {
  let pending: { value: T } | null = null;
  let running: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const drain = (): Promise<void> => {
    running = running.catch(() => undefined).then(async () => {
      while (pending) {
        const next = pending;
        pending = null;
        try { await write(next.value); }
        catch (error) {
          pending ??= next;
          throw error;
        }
      }
    });
    return running;
  };
  return {
    schedule(value: T) {
      pending = { value };
      clearTimeout(timer);
      timer = setTimeout(() => { void drain().catch(() => undefined); }, delayMs);
    },
    flush(): Promise<void> {
      clearTimeout(timer);
      return drain();
    },
    hasPending: () => pending !== null,
  };
}
