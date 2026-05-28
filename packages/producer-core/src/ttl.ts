import type { SessionRecord } from "./types.ts";

export const DEFAULT_TTL_MS = 3 * 24 * 60 * 60 * 1000;
export const DEFAULT_UPLOADED_GRACE_MS = 60 * 1000;

export type SweepResult = {
  kept: SessionRecord[];
  removed: SessionRecord[];
};

export type SweepOptions = {
  ttl_ms?: number;
  uploaded_grace_ms?: number;
};

export function sweepExpired(
  snapshot: SessionRecord[],
  now_ms: number,
  options: SweepOptions = {},
): SweepResult {
  const ttl = options.ttl_ms ?? DEFAULT_TTL_MS;
  const grace = options.uploaded_grace_ms ?? DEFAULT_UPLOADED_GRACE_MS;
  const kept: SessionRecord[] = [];
  const removed: SessionRecord[] = [];
  for (const record of snapshot) {
    if (record.state === "uploaded" && now_ms - record.last_edit_wall_ms >= grace) {
      removed.push(record);
      continue;
    }
    if (now_ms - record.last_edit_wall_ms >= ttl) {
      removed.push(record);
      continue;
    }
    kept.push(record);
  }
  return { kept, removed };
}
