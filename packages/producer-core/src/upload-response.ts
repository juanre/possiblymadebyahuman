import type { B3Hash } from "../../format/src/index.ts";
import type { IngestRecordResponse } from "./types.ts";

/** A successful status alone cannot retire the durable upload intent. */
export function validateUploadResponse(value: unknown, expectedHash: B3Hash): IngestRecordResponse {
  if (!value || typeof value !== "object") throw new Error("Invalid upload response; retry the frozen record.");
  const response = value as Partial<IngestRecordResponse>;
  if (response.record_hash !== expectedHash || typeof response.short_signature !== "string" || !response.short_signature ||
      typeof response.url !== "string" || typeof response.created !== "boolean") {
    throw new Error("Invalid upload response; retry the frozen record.");
  }
  let url: URL;
  try { url = new URL(response.url); }
  catch { throw new Error("Invalid record link in upload response; retry the frozen record."); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Invalid record link in upload response; retry the frozen record.");
  }
  return response as IngestRecordResponse;
}
