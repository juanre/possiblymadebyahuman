import type { BufferMutation } from "../../format/src/index.ts";
import type { PendingMutation } from "./types.ts";

export function appendBufferMutation(
  events: BufferMutation[],
  pending: PendingMutation,
  wall_ms: number,
  base_wall_ms: number,
): BufferMutation {
  const seq = events.length;
  const t = Math.max(0, wall_ms - base_wall_ms);
  const event: BufferMutation = {
    seq,
    t,
    op: pending.op,
    pos: pending.pos,
    del_len: pending.del_len,
    ins_len: pending.ins_len,
    source: pending.source,
  };
  events.push(event);
  return event;
}

export function durationMs(events: BufferMutation[]): number {
  if (events.length === 0) return 0;
  return events[events.length - 1]!.t;
}
