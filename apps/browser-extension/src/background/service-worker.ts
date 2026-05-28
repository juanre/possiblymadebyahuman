import type { ProducerIdentity } from "../../../../packages/producer-core/src/index.ts";
import {
  createChromeStorageAdapter,
  createCryptoUuidAdapter,
  createDateClockAdapter,
  createFetchCheckpointAdapter,
  createFetchUploadAdapter,
  type ChromeStorageLocalSlice,
  type CryptoSlice,
  type FetchLike,
} from "../lib/adapters.ts";
import { BackgroundDispatcher } from "../lib/dispatcher.ts";
import { isContentMessage } from "../lib/messages.ts";
import { API_BASE_URL, RECORDS_ENDPOINT } from "../lib/config.ts";

export const BACKGROUND_ENTRYPOINT = "service-worker";

declare const chrome: {
  storage: { local: ChromeStorageLocalSlice };
  runtime: {
    onMessage: {
      addListener(
        listener: (
          message: unknown,
          sender: { tab?: { id?: number }; frameId?: number; url?: string },
          sendResponse: (response: unknown) => void,
        ) => boolean | void,
      ): void;
    };
  };
  alarms: {
    create(name: string, info: { periodInMinutes: number }): void;
    onAlarm: {
      addListener(listener: (alarm: { name: string }) => void): void;
    };
  };
};

const PRODUCER: ProducerIdentity = {
  id: "browser-extension",
  version: "0.1.0",
  capabilities: ["timing", "source_attribution"],
};

const TTL_SWEEP_ALARM = "pmbah-ttl-sweep";
const TTL_SWEEP_PERIOD_MINUTES = 60;

const cryptoRef = (globalThis as unknown as { crypto: CryptoSlice }).crypto;
const fetchRef: FetchLike = (input, init) => (globalThis as unknown as { fetch: (i: string, o: unknown) => Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<unknown> }> }).fetch(input, init);

const dispatcher = new BackgroundDispatcher({
  clock: createDateClockAdapter(),
  uuid: createCryptoUuidAdapter(cryptoRef),
  storage: createChromeStorageAdapter(chrome.storage.local),
  upload: createFetchUploadAdapter({ records_endpoint: RECORDS_ENDPOINT, fetch: fetchRef }),
  checkpoint: createFetchCheckpointAdapter({ base_url: API_BASE_URL, fetch: fetchRef }),
  producer: PRODUCER,
});

void dispatcher.ensureInitialised();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isContentMessage(message)) {
    sendResponse({ kind: "error", reason: "unrecognised_message" });
    return false;
  }
  const enriched = enrichWithSender(message, sender);
  dispatcher.handle(enriched).then((response) => sendResponse(response)).catch((error: unknown) => {
    sendResponse({ kind: "error", reason: error instanceof Error ? error.message : String(error) });
  });
  return true;
});

function enrichWithSender(
  message: import("../lib/messages.ts").ContentToBackground,
  sender: { tab?: { id?: number }; frameId?: number; url?: string },
): import("../lib/messages.ts").ContentToBackground {
  if (message.kind !== "register_field") return message;
  const tab_id = sender.tab?.id ?? -1;
  const frame_id = sender.frameId ?? -1;
  return { ...message, tab_id, frame_id };
}

chrome.alarms.create(TTL_SWEEP_ALARM, { periodInMinutes: TTL_SWEEP_PERIOD_MINUTES });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== TTL_SWEEP_ALARM) return;
  const removed = dispatcher.registry.sweep();
  if (removed.length > 0) {
    void dispatcher.registry.persist();
  }
});
