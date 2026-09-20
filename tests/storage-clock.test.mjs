import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryRecordStore, ObservedSessionTokenError, OBSERVED_SESSION_TTL_MS } from "../packages/storage/src/index.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_ID = "123e4567-e89b-42d3-a456-426614174999";
const TOKEN_HASH = "a".repeat(64);
const CHAIN_TIP = `b3:${"0".repeat(64)}`;

test("in-memory observed-session expiry follows the injected clock, not the wall clock", async () => {
  let nowMs = Date.parse("2026-05-28T10:00:00.000Z");
  const store = new InMemoryRecordStore({ now: () => new Date(nowMs) });
  await store.appendObservedCheckpoint({
    observed_session_id: SESSION_ID,
    new_observed_token_hash: TOKEN_HASH,
    event_count: 1,
    chain_tip: CHAIN_TIP,
  });

  nowMs += DAY_MS;
  const session = await store.getObservedSessionForBinding({ observed_session_id: SESSION_ID, observed_token_hash: TOKEN_HASH });
  assert.equal(session.checkpoints.length, 1);
  assert.equal(session.checkpoints[0].observed_at, "2026-05-28T10:00:00.000Z");

  nowMs += OBSERVED_SESSION_TTL_MS;
  await assert.rejects(
    store.getObservedSessionForBinding({ observed_session_id: SESSION_ID, observed_token_hash: TOKEN_HASH }),
    ObservedSessionTokenError,
  );
});
