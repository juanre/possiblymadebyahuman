import {
  IngestUploadError,
  type JournalUpload,
} from "../../producer-core/src/adapters.ts";
import { withUploadDeadline } from "../../producer-core/src/upload-deadline.ts";
import { validateUploadResponse } from "../../producer-core/src/upload-response.ts";
import type { BufferMutation } from "../../format/src/index.ts";
import type { IngestRecordResponse } from "../../producer-core/src/types.ts";

export type JournalFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Resumable, bounded publication. Each request, including its body, has a deadline. */
export async function uploadJournal(args: {
  endpoint: string;
  fetch: JournalFetch;
  payload: JournalUpload;
  readEvents(start: number, count: number): Promise<BufferMutation[]>;
  timeout_ms?: number;
}): Promise<IngestRecordResponse> {
  const request = args.fetch;
  const post = (url: string, body: unknown) =>
    withUploadDeadline(async (signal) => {
      const response = await request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      const json = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        const code = typeof json?.error === "string" ? json.error : null;
        throw new IngestUploadError(
          response.status,
          code,
          code ?? `upload_failed_${response.status}`,
        );
      }
      return json;
    }, args.timeout_ms);
  const { payload } = args;
  const begun = await post(args.endpoint, payload);
  if (begun.upload_id !== payload.upload_id)
    throw new Error("Invalid resumable upload identity");
  if (begun.completed)
    return validateUploadResponse(
      begun.completed,
      payload.manifest.record_hash,
    );
  const validateCursor = (
    status: Record<string, unknown>,
    minimum: number,
  ): number => {
    const cursor = status.next_seq;
    if (
      status.upload_id !== payload.upload_id ||
      typeof cursor !== "number" ||
      !Number.isSafeInteger(cursor) ||
      cursor < minimum ||
      cursor > payload.manifest.event_count
    ) {
      throw new Error("Invalid resumable upload cursor");
    }
    return cursor;
  };
  let cursor = validateCursor(begun, 0);
  const chunkSize =
    typeof begun.max_chunk_events === "number" &&
    Number.isInteger(begun.max_chunk_events) &&
    begun.max_chunk_events > 0
      ? Math.min(4096, begun.max_chunk_events)
      : 4096;
  const target = `${args.endpoint}/${encodeURIComponent(payload.upload_id)}`;
  while (cursor < payload.manifest.event_count) {
    const count = Math.min(chunkSize, payload.manifest.event_count - cursor);
    const events = await args.readEvents(cursor, count);
    if (
      events.length !== count ||
      events.some((event, index) => event.seq !== cursor + index)
    )
      throw new Error("Local event journal is incomplete; publication stopped");
    const next = await post(`${target}/chunks`, { start_seq: cursor, events });
    const expected = cursor + events.length;
    cursor = validateCursor(next, expected);
    if (cursor !== expected)
      throw new Error("Server acknowledged an unexpected event prefix");
  }
  return validateUploadResponse(
    await post(`${target}/finalize`, {}),
    payload.manifest.record_hash,
  );
}
