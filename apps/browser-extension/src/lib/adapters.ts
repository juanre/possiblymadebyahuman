import type {
  CheckpointAdapter,
  CheckpointRequest,
  CheckpointResponse,
  CheckpointResult,
  ClipboardAdapter,
  ClockAdapter,
  IngestRecordInput,
  IngestRecordResponse,
  ObservationEnvelope,
  SessionRecord,
  StorageAdapter,
  UploadAdapter,
  UuidAdapter,
} from "../../../../packages/producer-core/src/index.ts";

const SESSION_STORAGE_KEY = "pmbah:sessions:v1";

export interface ChromeStorageLocalSlice {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export function createChromeStorageAdapter(storage: ChromeStorageLocalSlice): StorageAdapter {
  return {
    async read(): Promise<SessionRecord[]> {
      const result = await storage.get([SESSION_STORAGE_KEY]);
      const raw = result[SESSION_STORAGE_KEY];
      if (!Array.isArray(raw)) return [];
      return raw as SessionRecord[];
    },
    async write(snapshot: SessionRecord[]): Promise<void> {
      const safe = snapshot.map(scrubTransientFlagsForPersist);
      await storage.set({ [SESSION_STORAGE_KEY]: safe });
    },
  };
}

function scrubTransientFlagsForPersist(record: SessionRecord): SessionRecord {
  return {
    ...record,
    observation: {
      ...record.observation,
      in_flight: false,
      queued: false,
      next_backoff_ms: 0,
    },
  };
}

export function createDateClockAdapter(): ClockAdapter {
  return { now: () => Date.now() };
}

export interface CryptoSlice {
  randomUUID(): string;
}

export function createCryptoUuidAdapter(crypto: CryptoSlice): UuidAdapter {
  return { uuid: () => crypto.randomUUID() };
}

export interface NavigatorClipboardSlice {
  writeText(value: string): Promise<void>;
}

export function createNavigatorClipboardAdapter(clipboard: NavigatorClipboardSlice): ClipboardAdapter {
  return {
    async writeText(value: string): Promise<void> {
      await clipboard.writeText(value);
    },
  };
}

export type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<unknown> }>;

export function createFetchUploadAdapter(args: { records_endpoint: string; fetch: FetchLike }): UploadAdapter {
  return {
    async postRecord(payload: IngestRecordInput & { observation?: ObservationEnvelope }): Promise<IngestRecordResponse> {
      const body = JSON.stringify({
        manifest: payload.manifest,
        events: payload.events,
        ...(payload.observation ? { observation: payload.observation } : {}),
      });
      const response = await args.fetch(args.records_endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`ingest_failed status=${response.status} reason=${text}`);
      }
      const json = (await response.json()) as IngestRecordResponse;
      return json;
    },
  };
}

export function createFetchCheckpointAdapter(args: { base_url: string; fetch: FetchLike }): CheckpointAdapter {
  return {
    async postCheckpoint(request: CheckpointRequest): Promise<CheckpointResult> {
      const body: Record<string, unknown> = {
        event_count: request.event_count,
        chain_tip: request.chain_tip,
      };
      // Per producer-core .40 caveat: omit `token` from the request body when null.
      if (request.token !== null) body.token = request.token;
      const url = `${args.base_url}/api/observed-sessions/${request.observed_session_id}/checkpoints`;
      let response: Awaited<ReturnType<FetchLike>>;
      try {
        response = await args.fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (error) {
        return {
          ok: false,
          kind: "transient",
          status: 0,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      if (response.ok) {
        const json = (await response.json()) as CheckpointResponse;
        return { ok: true, response: json };
      }
      const status = response.status;
      const reason = await response.text().catch(() => `status=${status}`);
      if (status === 404) return { ok: false, kind: "unavailable", status, reason };
      if (status === 409) return { ok: false, kind: "conflict", status, reason };
      if (status === 400) return { ok: false, kind: "client_bug", status, reason };
      if (status === 429) return { ok: false, kind: "rate_limited", status, reason };
      return { ok: false, kind: "transient", status, reason };
    },
  };
}

/**
 * Convenience type for building producer-core SessionRegistry constructor
 * options from the Chrome runtime. Defined here so the service-worker entry
 * file does not need to import individual adapter factories.
 */
export type ChromeRegistryDependencies = {
  storage: ChromeStorageLocalSlice;
  crypto: CryptoSlice;
  fetch: FetchLike;
  records_endpoint: string;
  base_url: string;
};
