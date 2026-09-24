import { IndexedDbSessionStorage } from "../../../../packages/browser-storage/src/index.ts";
import { uploadJournal } from "../../../../packages/browser-storage/src/upload.ts";
import { IngestUploadError, withUploadDeadline, validateUploadResponse } from "../../../../packages/producer-core/src/index.ts";
import type {
  CheckpointAdapter,
  CheckpointRequest,
  CheckpointResponse,
  CheckpointResult,
  ClipboardAdapter,
  ClockAdapter,
  IngestRecordInput,
  IngestRecordResponse,
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
  return new IndexedDbSessionStorage({
    name: "pmbah.extension.journal.v1",
    async legacyRead() {
      const raw = (await storage.get([SESSION_STORAGE_KEY]))[SESSION_STORAGE_KEY];
      if (raw === undefined) return [];
      if (!Array.isArray(raw)) throw new Error("Legacy session storage is invalid; it has been preserved");
      return raw as SessionRecord[];
    },
    legacyRemove: () => storage.remove([SESSION_STORAGE_KEY]),
  });
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

export type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<unknown> }>;

export function createFetchUploadAdapter(args: { records_endpoint: string; fetch: FetchLike; timeout_ms?: number }): UploadAdapter {
  return {
    postJournalRecord(payload, readEvents) {
      return uploadJournal({ endpoint: args.records_endpoint.replace(/\/records$/, "/record-uploads"), fetch: args.fetch, payload, readEvents, timeout_ms: args.timeout_ms });
    },
    async postRecord(payload: IngestRecordInput): Promise<IngestRecordResponse> {
      return withUploadDeadline(async signal => {
      const body = JSON.stringify({
        manifest: payload.manifest,
        events: payload.events,
        ...(payload.observation ? { observation: payload.observation } : {}),
      });
      const response = await args.fetch(args.records_endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal,
      });
      if (!response.ok) {
        const text = await response.text();
        throw new IngestUploadError(response.status, ingestErrorCode(text), `ingest_failed status=${response.status} reason=${text}`);
      }
      return validateUploadResponse(await response.json(), payload.manifest.record_hash);
      }, args.timeout_ms);
    },
  };
}

/** The `error` field of an ingest failure body, or null when the body is not such JSON. */
function ingestErrorCode(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string") {
      return (parsed as { error: string }).error;
    }
  } catch {
    // Not a JSON body; there is no code to surface.
  }
  return null;
}

export function createFetchCheckpointAdapter(args: { base_url: string; fetch: FetchLike }): CheckpointAdapter {
  return {
    async postCheckpoint(request: CheckpointRequest, signal?: AbortSignal): Promise<CheckpointResult> {
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
          signal,
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
