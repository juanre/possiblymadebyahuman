import {
  b3HashBytes,
  b3HashToBytes,
  canonicalizeEventBytes,
  type B3Hash,
  type BufferMutation,
  type FormatVersion,
} from "../../format/src/index.ts";
import type { PendingMutation, SessionId } from "./types.ts";

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

const TEXT_ENCODER = new TextEncoder();

function utf8(value: string): Uint8Array {
  return TEXT_ENCODER.encode(value);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function advanceChain(
  previous_chain_tip: B3Hash | null,
  next_event: BufferMutation,
  session_id: SessionId,
  format_version: FormatVersion,
): B3Hash {
  const event_bytes = canonicalizeEventBytes(next_event);
  if (previous_chain_tip === null) {
    return b3HashBytes(concatBytes(utf8(format_version), utf8(session_id), event_bytes));
  }
  return b3HashBytes(concatBytes(b3HashToBytes(previous_chain_tip), event_bytes));
}
