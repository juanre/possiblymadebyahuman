import type { RecordManifest } from "../../../packages/format/src/index.ts";
import { verifyPagedRecord, type EventPage } from "./stream-record.ts";

// A page that could not be fetched says nothing about the record's integrity,
// so it is reported separately from a failed check.
class PageUnavailable extends Error {}

self.onmessage = async (
  message: MessageEvent<{ manifest: RecordManifest; starting_length?: number | null }>,
) => {
  const { manifest, starting_length: startingLength = 0 } = message.data;
  try {
    // Address pages by the immutable full hash, not a mutable caller-supplied URL.
    const result = await verifyPagedRecord(
      manifest,
      async (offset, limit) => {
        let response: Response;
        try {
          response = await fetch(
            `/api/records/${encodeURIComponent(manifest.record_hash)}/events?offset=${offset}&limit=${limit}`,
            { signal: AbortSignal.timeout(30_000) },
          );
        } catch {
          throw new PageUnavailable("An event page could not be loaded.");
        }
        if (!response.ok)
          throw new PageUnavailable(
            `Event page could not be loaded (${response.status}).`,
          );
        try {
          return (await response.json()) as EventPage;
        } catch {
          throw new PageUnavailable("An event page could not be read.");
        }
      },
      (progress) =>
        self.postMessage({ type: "progress", count: progress.count }),
      startingLength,
    );
    self.postMessage({ type: "complete", ...result });
  } catch (error) {
    self.postMessage({
      type: error instanceof PageUnavailable ? "unavailable" : "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
