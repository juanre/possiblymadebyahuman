import {
  advanceEventHash,
  validateEvent,
  type BufferMutation,
} from "../../format/src/index.ts";
import type { PendingMutation } from "./types.ts";

export function buildBufferMutation(
  events: BufferMutation[],
  pending: PendingMutation,
  wall_ms: number,
  base_wall_ms: number,
): BufferMutation {
  return buildNextMutation(pending, events.length, events.at(-1)?.t ?? 0, wall_ms, base_wall_ms);
}

export function buildNextMutation(pending: PendingMutation, seq: number, previous_t: number, wall_ms: number, base_wall_ms: number): BufferMutation {
  // A wall-clock correction must not make a resumed history run backwards.
  const t = Math.max(0, previous_t, wall_ms - base_wall_ms);
  const event: BufferMutation = {
    seq,
    t,
    op: pending.op,
    pos: pending.pos,
    del_len: pending.del_len,
    ins_len: pending.ins_len,
    source: pending.source,
  };
  const errors = validateEvent(event, seq);
  if (errors.length) throw new Error(errors.join("; "));
  return event;
}

export function appendBufferMutation(
  events: BufferMutation[], pending: PendingMutation, wall_ms: number, base_wall_ms: number,
): BufferMutation {
  const event = buildBufferMutation(events, pending, wall_ms, base_wall_ms);
  events.push(event);
  return event;
}

export function durationMs(events: BufferMutation[]): number {
  if (events.length === 0) return 0;
  return events[events.length - 1]!.t;
}

export const advanceChain = advanceEventHash;
