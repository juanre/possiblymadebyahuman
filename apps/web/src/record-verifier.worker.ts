import type { RecordManifest } from "../../../packages/format/src/index.ts";
import { verifyPagedRecord, type EventPage } from "./stream-record.ts";

self.onmessage = async (
  message: MessageEvent<{ manifest: RecordManifest }>,
) => {
  const { manifest } = message.data;
  try {
    // Address pages by the immutable full hash, not a mutable caller-supplied URL.
    const result = await verifyPagedRecord(
      manifest,
      async (offset, limit) => {
        const response = await fetch(
          `/api/records/${encodeURIComponent(manifest.record_hash)}/events?offset=${offset}&limit=${limit}`,
          { signal: AbortSignal.timeout(30_000) },
        );
        if (!response.ok)
          throw new Error(
            `Event page could not be loaded (${response.status})`,
          );
        return (await response.json()) as EventPage;
      },
      (progress) =>
        self.postMessage({ type: "progress", count: progress.count }),
    );
    self.postMessage({ type: "complete", ...result });
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
