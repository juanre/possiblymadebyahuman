import {
  advanceEventHash,
  FORMAT_VERSIONS,
  validateEventLog,
  type BufferMutation,
} from "../../format/src/index.ts";
import type {
  EventJournalStorage,
  JournalCommit,
  StorageAdapter,
} from "../../producer-core/src/adapters.ts";
import type { SessionRecord } from "../../producer-core/src/types.ts";

type Options = {
  name: string;
  assertOwnership?: () => void;
  legacyRead: () => Promise<SessionRecord[]>;
  legacyRemove: () => Promise<void>;
  factory?: IDBFactory;
};

const result = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB request failed"));
  });
const complete = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => {
      /* onabort reports the transaction outcome */
    };
  });
const eventRange = (id: string, start = 0, end = Number.MAX_SAFE_INTEGER) =>
  IDBKeyRange.bound([id, start], [id, end]);

/** Atomic metadata + append-only event rows, with bounded page reads. */
export class IndexedDbSessionStorage
  implements StorageAdapter, EventJournalStorage
{
  readonly journal = this;
  readonly #options: Options;
  #database?: Promise<IDBDatabase>;

  constructor(options: Options) {
    this.#options = options;
  }

  #open(): Promise<IDBDatabase> {
    this.#options.assertOwnership?.();
    if (this.#database) return this.#database;
    const factory = this.#options.factory ?? globalThis.indexedDB;
    if (!factory)
      return Promise.reject(
        new Error("IndexedDB is required to preserve writing-session history"),
      );
    let failed = false;
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(this.#options.name, 1);
      const fail = (error: unknown) => {
        failed = true;
        this.#database = undefined;
        reject(error);
      };
      request.onupgradeneeded = () => {
        request.result.createObjectStore("sessions", { keyPath: "session_id" });
        request.result.createObjectStore("events", {
          keyPath: ["session_id", "seq"],
        });
        request.result.createObjectStore("control");
      };
      request.onsuccess = () => {
        if (failed) {
          request.result.close();
          return;
        }
        request.result.onversionchange = () => {
          request.result.close();
          this.#database = undefined;
        };
        resolve(request.result);
      };
      request.onerror = () =>
        fail(request.error ?? new Error("IndexedDB could not be opened"));
      request.onblocked = () =>
        fail(
          new Error(
            "Another browser context blocked the writing-history database upgrade",
          ),
        );
    });
    this.#database = opening;
    void opening.catch(() => {
      if (this.#database === opening) this.#database = undefined;
    });
    return opening;
  }

  async read(): Promise<SessionRecord[]> {
    const database = await this.#open();
    this.#options.assertOwnership?.();
    const control = database.transaction("control", "readonly");
    if (!(await result(control.objectStore("control").get("legacy-migrated"))))
      await this.#migrate();
    this.#options.assertOwnership?.();
    return result(
      database
        .transaction("sessions", "readonly")
        .objectStore("sessions")
        .getAll(),
    );
  }

  async write(_snapshot: SessionRecord[]): Promise<void> {
    throw new Error("Snapshot writes are disabled for journal-backed sessions");
  }

  async commit(batch: JournalCommit): Promise<void> {
    const database = await this.#open();
    this.#options.assertOwnership?.();
    const transaction = database.transaction(
      ["sessions", "events"],
      "readwrite",
      { durability: "strict" },
    );
    const done = complete(transaction);
    const sessions = transaction.objectStore("sessions");
    const events = transaction.objectStore("events");
    try {
      for (const id of new Set([...batch.deleted, ...batch.clear_events]))
        events.delete(eventRange(id));
      for (const id of batch.deleted) sessions.delete(id);
      for (const append of batch.appends) {
        if (append.events.length > 4096)
          throw new Error("Journal batch exceeds the bounded append window");
        for (const event of append.events)
          events.add({ session_id: append.session_id, seq: event.seq, event });
      }
      for (const session of batch.sessions) {
        if (!session.journaled || session.events.length)
          throw new Error("Journal metadata must not contain history");
        sessions.put(session);
      }
    } catch (error) {
      transaction.abort();
      await done.catch(() => undefined);
      throw error;
    }
    await done;
  }

  async readEvents(
    session_id: string,
    start_seq: number,
    limit: number,
  ): Promise<BufferMutation[]> {
    if (
      !Number.isSafeInteger(start_seq) ||
      start_seq < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 4096
    )
      throw new RangeError("invalid event page");
    const database = await this.#open();
    this.#options.assertOwnership?.();
    const rows = (await result(
      database
        .transaction("events", "readonly")
        .objectStore("events")
        .getAll(
          eventRange(session_id, start_seq, start_seq + limit - 1),
          limit,
        ),
    )) as Array<{ event: BufferMutation }>;
    return rows.map((row) => row.event);
  }

  async #migrate(): Promise<void> {
    // The legacy format is a single JSON snapshot: this one-time read is the
    // only materialization. It is retained until every imported prefix verifies.
    const legacy = await this.#options.legacyRead();
    if (!Array.isArray(legacy))
      throw new Error(
        "Legacy session storage has an unrecognized shape; it has been preserved",
      );
    const ids = new Set<string>();
    for (const session of legacy) {
      if (
        !session ||
        typeof session.session_id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          session.session_id,
        ) ||
        !FORMAT_VERSIONS.includes(session.format_version) ||
        !Array.isArray(session.events) ||
        !Number.isSafeInteger(session.base_wall_ms) ||
        session.base_wall_ms < 0 ||
        !Number.isSafeInteger(session.last_edit_wall_ms) ||
        session.last_edit_wall_ms < 0 ||
        ![
          "active",
          "signing",
          "uploading",
          "uploaded",
          "failed_upload",
        ].includes(session.state) ||
        !session.origin ||
        !session.descriptor ||
        !session.producer ||
        !session.capture_context ||
        (session.event_count !== undefined &&
          session.event_count !== session.events.length) ||
        (session.last_event_t !== undefined &&
          session.last_event_t !== (session.events.at(-1)?.t ?? 0))
      ) {
        throw new Error(
          "Invalid legacy session metadata; original storage preserved",
        );
      }
      if (ids.has(session.session_id))
        throw new Error(
          "Duplicate legacy session identity; original storage preserved",
        );
      ids.add(session.session_id);
    }
    for (const session of legacy) {
      const errors = validateEventLog(session.events);
      if (errors.length)
        throw new Error(`Legacy session cannot be migrated: ${errors[0]}`);
      let tip = null;
      for (const event of session.events)
        tip = advanceEventHash(
          tip,
          event,
          session.session_id,
          session.format_version,
        );
      if (session.last_event_chain_tip && session.last_event_chain_tip !== tip)
        throw new Error(
          "Legacy event chain differs from its saved tip; original storage preserved",
        );
      const metadata: SessionRecord = {
        ...session,
        events: [],
        journaled: true,
        event_count: session.events.length,
        last_event_t: session.events.at(-1)?.t ?? 0,
        last_event_chain_tip: tip,
      };
      // Interrupted migration may have committed event rows but no completion
      // marker. Replacing this source session is safe while legacy remains authoritative.
      await this.commit({
        sessions: [],
        appends: [],
        deleted: [session.session_id],
        clear_events: [],
      });
      for (let start = 0; start < session.events.length; start += 512) {
        await this.commit({
          sessions: [],
          appends: [
            {
              session_id: session.session_id,
              events: session.events.slice(start, start + 512),
            },
          ],
          deleted: [],
          clear_events: [],
        });
      }
      let verifiedTip = null;
      for (let start = 0; start < session.events.length; start += 512) {
        const page = await this.readEvents(session.session_id, start, 512);
        if (page.length !== Math.min(512, session.events.length - start))
          throw new Error(
            "Migration event page is incomplete; original storage preserved",
          );
        for (const event of page)
          verifiedTip = advanceEventHash(
            verifiedTip,
            event,
            session.session_id,
            session.format_version,
          );
      }
      if (verifiedTip !== tip)
        throw new Error(
          "Migration verification failed; original storage preserved",
        );
      await this.commit({
        sessions: [metadata],
        appends: [],
        deleted: [],
        clear_events: [],
      });
    }
    const database = await this.#open();
    this.#options.assertOwnership?.();
    const transaction = database.transaction("control", "readwrite", {
      durability: "strict",
    });
    const done = complete(transaction);
    transaction.objectStore("control").put(true, "legacy-migrated");
    await done;
    // A cleanup failure never rolls back the verified journal or reimports stale data.
    await this.#options.legacyRemove().catch(() => undefined);
  }
}

export { uploadJournal } from "./upload.ts";
