import assert from "node:assert/strict";
import test from "node:test";

import {
  FORMAT_VERSION,
} from "../packages/format/src/index.ts";
import {
  SessionRegistry,
  advanceChain,
  buildCaptureContext,
} from "../packages/producer-core/src/index.ts";

function mutableClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance(ms) {
      t += ms;
      return t;
    },
    set(ms) {
      t = ms;
      return t;
    },
  };
}

function deterministicUuids() {
  let counter = 0;
  return {
    uuid: () => {
      counter += 1;
      const hex = counter.toString(16).padStart(12, "0");
      return `00000000-0000-4000-8000-${hex}`;
    },
  };
}

function inMemoryStorage(seed = []) {
  let snapshot = seed.map((record) => structuredClone(record));
  return {
    async read() {
      return snapshot.map((record) => structuredClone(record));
    },
    async write(next) {
      snapshot = next.map((record) => structuredClone(record));
    },
  };
}

function recordingCheckpoint(options = {}) {
  const calls = [];
  let nextResponses = [];
  let observedCounter = 0;
  let checkpointCounter = 0;
  let tokenCounter = 0;
  return {
    async postCheckpoint(request) {
      calls.push(request);
      const programmed = nextResponses.shift();
      if (programmed) {
        if (typeof programmed === "function") return programmed(request);
        return programmed;
      }
      observedCounter += 1;
      checkpointCounter += 1;
      tokenCounter += 1;
      const observed_session_id = request.observed_session_id ?? `obs-${observedCounter}`;
      const token = request.token ?? `tok-${tokenCounter}`;
      return {
        ok: true,
        response: {
          observed_session_id,
          token,
          checkpoint_id: `cp-${checkpointCounter}`,
          event_count: request.event_count,
          chain_tip: request.chain_tip,
          server_t: new Date(1_700_000_000_000 + checkpointCounter).toISOString(),
          created: true,
        },
      };
    },
    queue(...responses) {
      nextResponses.push(...responses);
    },
    calls,
    options,
  };
}

const PRODUCER = {
  id: "test-producer",
  version: "0.1.0",
  capabilities: ["timing"],
};

const ORIGIN = { origin: "https://a.test", path: "/thread/1", tab_id: 11, frame_id: 0 };

function descriptor(overrides = {}) {
  return {
    tag_name: "TEXTAREA",
    field_kind: "textarea",
    name: "comment",
    id: "comment-1",
    aria_label: null,
    nearest_form_id: "form-reply",
    dom_signature: "sig-default",
    index_among_similar: 0,
    ...overrides,
  };
}

function captureContext() {
  return buildCaptureContext({ origin: ORIGIN, descriptor: descriptor(), page_title: "Test Page" });
}

function makeRegistry(opts = {}) {
  const clock = opts.clock ?? mutableClock();
  const uuid = opts.uuid ?? deterministicUuids();
  const storage = opts.storage ?? inMemoryStorage();
  const checkpoint = opts.checkpoint;
  const cadence = opts.cadence;
  const registry = new SessionRegistry({ clock, uuid, storage, producer: PRODUCER, checkpoint, cadence });
  return { registry, clock, uuid, storage, checkpoint };
}

function newSession(registry) {
  const desc = descriptor();
  return registry.findOrCreate(ORIGIN, desc, captureContext());
}

function appendMany(registry, session_id, count, base_pos = 0) {
  for (let i = 0; i < count; i++) {
    registry.appendMutation(session_id, {
      op: "insert",
      pos: base_pos + i,
      del_len: 0,
      ins_len: 1,
      source: "typing",
    });
  }
}

test("1. first mutation triggers an immediate checkpoint", async () => {
  const checkpoint = recordingCheckpoint();
  const { registry } = makeRegistry({ checkpoint });
  const session = newSession(registry);
  assert.equal(registry.get(session.session_id).observation.state, "unknown");
  registry.appendMutation(session.session_id, { op: "insert", pos: 0, del_len: 0, ins_len: 1, source: "typing" });
  await registry.awaitObservationIdle(session.session_id);
  assert.equal(checkpoint.calls.length, 1);
  assert.equal(checkpoint.calls[0].event_count, 1);
  const observation = registry.get(session.session_id).observation;
  assert.equal(observation.state, "known");
  assert.equal(observation.last_committed_event_count, 1);
  assert.equal(observation.commitments.length, 1);
  assert.equal(observation.commitments[0].event_count, 1);
});

test("1a. long-idle resume keeps token and only checkpoints when new events arrive", async () => {
  const checkpoint = recordingCheckpoint();
  const clock = mutableClock(0);
  const { registry } = makeRegistry({ checkpoint, clock });
  const session = newSession(registry);
  registry.appendMutation(session.session_id, { op: "insert", pos: 0, del_len: 0, ins_len: 1, source: "typing" });
  await registry.awaitObservationIdle(session.session_id);
  const token_after_first = registry.get(session.session_id).observation.last_observed_token;
  // idle 10 minutes — no events, no heartbeats
  clock.advance(600_000);
  await registry.awaitObservationIdle(session.session_id);
  assert.equal(checkpoint.calls.length, 1);
  assert.equal(
    registry.get(session.session_id).observation.last_observed_token,
    token_after_first,
  );
});

test("2. delta-of-50 cadence: 51 events commit at event_count 1 then 51", async () => {
  const checkpoint = recordingCheckpoint();
  const { registry } = makeRegistry({ checkpoint });
  const session = newSession(registry);
  appendMany(registry, session.session_id, 51);
  await registry.awaitObservationIdle(session.session_id);
  const counts = checkpoint.calls.map((call) => call.event_count);
  assert.deepEqual(counts, [1, 51]);
});

test("3. time-gated cadence: 60s elapsed with new events triggers another checkpoint", async () => {
  const checkpoint = recordingCheckpoint();
  const clock = mutableClock(0);
  const { registry } = makeRegistry({ checkpoint, clock });
  const session = newSession(registry);
  registry.appendMutation(session.session_id, { op: "insert", pos: 0, del_len: 0, ins_len: 1, source: "typing" });
  await registry.awaitObservationIdle(session.session_id);
  assert.equal(checkpoint.calls.length, 1);
  // five more events, under the 50 threshold and under 60s
  clock.advance(10_000);
  appendMany(registry, session.session_id, 5, 1);
  await registry.awaitObservationIdle(session.session_id);
  assert.equal(checkpoint.calls.length, 1, "no event-count or time threshold crossed");
  // jump past 60s after the first commit
  clock.advance(60_000);
  registry.appendMutation(session.session_id, { op: "insert", pos: 6, del_len: 0, ins_len: 1, source: "typing" });
  await registry.awaitObservationIdle(session.session_id);
  assert.equal(checkpoint.calls.length, 2);
  assert.equal(checkpoint.calls[1].event_count, 7);
});

test("4. flushObservation before sign covers all pending events", async () => {
  const checkpoint = recordingCheckpoint();
  const { registry } = makeRegistry({ checkpoint });
  const session = newSession(registry);
  // First event commits.
  registry.appendMutation(session.session_id, { op: "insert", pos: 0, del_len: 0, ins_len: 1, source: "typing" });
  await registry.awaitObservationIdle(session.session_id);
  assert.equal(checkpoint.calls.length, 1);
  // Now append 9 more — below every_n_events threshold, no checkpoint kicks.
  appendMany(registry, session.session_id, 9, 1);
  await registry.awaitObservationIdle(session.session_id);
  assert.equal(checkpoint.calls.length, 1, "cadence does not trigger below threshold");
  // Flush explicitly before sign.
  await registry.flushObservation(session.session_id);
  assert.equal(checkpoint.calls.length, 2);
  assert.equal(checkpoint.calls[1].event_count, 10);
  const draft = registry.sign(session.session_id);
  assert.equal(draft.events.length, 10);
  const envelope = registry.getObservationEnvelope(session.session_id);
  assert.ok(envelope, "envelope present after successful flush");
  assert.equal(typeof envelope.observed_session_id, "string");
  assert.equal(typeof envelope.token, "string");
});

test("5. success path moves state to 'known' and stores envelope", async () => {
  const checkpoint = recordingCheckpoint();
  const { registry } = makeRegistry({ checkpoint });
  const session = newSession(registry);
  registry.appendMutation(session.session_id, { op: "insert", pos: 0, del_len: 0, ins_len: 1, source: "typing" });
  await registry.awaitObservationIdle(session.session_id);
  const obs = registry.get(session.session_id).observation;
  assert.equal(obs.state, "known");
  assert.equal(obs.last_committed_event_count, 1);
});

test("6. partial state when uncheckpointed events remain after a commit", async () => {
  const checkpoint = recordingCheckpoint();
  const { registry } = makeRegistry({ checkpoint });
  const session = newSession(registry);
  // First mutation commits at event_count=1.
  registry.appendMutation(session.session_id, { op: "insert", pos: 0, del_len: 0, ins_len: 1, source: "typing" });
  await registry.awaitObservationIdle(session.session_id);
  // Adding 9 more events without crossing thresholds leaves them uncommitted.
  appendMany(registry, session.session_id, 9, 1);
  await registry.awaitObservationIdle(session.session_id);
  const obs = registry.get(session.session_id).observation;
  assert.equal(obs.last_committed_event_count, 1);
  assert.equal(obs.state, "partial");
});

test("7. out-of-order success preserves max(last_committed, response.event_count)", async () => {
  const checkpoint = recordingCheckpoint();
  // Stage 1: first event-count=1 commit happens normally.
  // Stage 2: queue a stale response (event_count=1 again) for the 50-event checkpoint
  //   — the max() guard must keep last_committed_event_count at 1, not regress.
  const { registry } = makeRegistry({ checkpoint });
  const session = newSession(registry);
  registry.appendMutation(session.session_id, { op: "insert", pos: 0, del_len: 0, ins_len: 1, source: "typing" });
  await registry.awaitObservationIdle(session.session_id);
  assert.equal(registry.get(session.session_id).observation.last_committed_event_count, 1);

  // Force the next response to be a stale (event_count=1) commit even though we're sending 51
  checkpoint.queue((request) => ({
    ok: true,
    response: {
      observed_session_id: request.observed_session_id,
      token: request.token ?? "stale-token",
      checkpoint_id: "cp-stale",
      event_count: 1, // server replays old commit (out-of-order)
      chain_tip: request.chain_tip,
      server_t: new Date(1_700_000_001_000).toISOString(),
      created: false,
    },
  }));
  appendMany(registry, session.session_id, 50, 1);
  await registry.awaitObservationIdle(session.session_id);
  const obs = registry.get(session.session_id).observation;
  assert.equal(obs.last_committed_event_count, 1, "stale response must not regress committed count");
});

test("8. TTL sweep removes a checkpointed session past the TTL", () => {
  const checkpoint = recordingCheckpoint();
  const clock = mutableClock(0);
  const { registry } = makeRegistry({ checkpoint, clock });
  const session = newSession(registry);
  registry.appendMutation(session.session_id, { op: "insert", pos: 0, del_len: 0, ins_len: 1, source: "typing" });
  clock.set(5 * 24 * 60 * 60 * 1000);
  const removed = registry.sweep();
  assert.equal(removed.length, 1);
  assert.equal(removed[0].session_id, session.session_id);
});

test("8a. commitments evict to retention watermark, preserving oldest + tail", async () => {
  const checkpoint = recordingCheckpoint();
  // 100 commitments → retention 32 → list shape is [oldest, last 31 tail]
  const { registry } = makeRegistry({ checkpoint });
  const session = newSession(registry);
  // First event commits at event_count=1 (the "oldest" anchor).
  registry.appendMutation(session.session_id, { op: "insert", pos: 0, del_len: 0, ins_len: 1, source: "typing" });
  await registry.awaitObservationIdle(session.session_id);
  // Force 99 more checkpoints by abusing flushObservation in a tight loop.
  for (let i = 0; i < 99; i++) {
    registry.appendMutation(session.session_id, {
      op: "insert",
      pos: 1 + i,
      del_len: 0,
      ins_len: 1,
      source: "typing",
    });
    await registry.flushObservation(session.session_id);
  }
  const obs = registry.get(session.session_id).observation;
  assert.equal(obs.commitments.length, 32);
  // Oldest commitment is event_count=1 (first commit, anchor preserved).
  assert.equal(obs.commitments[0].event_count, 1);
  // Newest commitment is the last one we made (event_count=100).
  assert.equal(obs.commitments[obs.commitments.length - 1].event_count, 100);
  // Tail of 31 starts at event_count = 100 - 30 = 70.
  assert.equal(obs.commitments[1].event_count, 70);
});

test("9. 5xx transient response: backoff doubles, no retry fires while idle", async () => {
  const checkpoint = recordingCheckpoint();
  checkpoint.queue({ ok: false, kind: "transient", status: 503, reason: "upstream unavailable" });
  const clock = mutableClock(0);
  const { registry } = makeRegistry({ checkpoint, clock });
  const session = newSession(registry);
  registry.appendMutation(session.session_id, { op: "insert", pos: 0, del_len: 0, ins_len: 1, source: "typing" });
  await registry.awaitObservationIdle(session.session_id);
  let obs = registry.get(session.session_id).observation;
  assert.equal(obs.next_backoff_ms, 1_000); // initial 1000ms on first failure
  assert.equal(obs.last_failure?.reason, "upstream unavailable");
  // Idle time passes, no further calls (no heartbeats).
  clock.advance(120_000);
  await registry.awaitObservationIdle(session.session_id);
  assert.equal(checkpoint.calls.length, 1, "transient does not retry without new events");

  // New event after backoff elapsed → next checkpoint succeeds, backoff resets.
  registry.appendMutation(session.session_id, { op: "insert", pos: 1, del_len: 0, ins_len: 1, source: "typing" });
  await registry.awaitObservationIdle(session.session_id);
  assert.equal(checkpoint.calls.length, 2);
  obs = registry.get(session.session_id).observation;
  assert.equal(obs.next_backoff_ms, 0);
  assert.equal(obs.last_failure, null);
});

test("10. 429 rate_limited bumps backoff but stays in current observation state", async () => {
  const checkpoint = recordingCheckpoint();
  checkpoint.queue({ ok: false, kind: "rate_limited", status: 429, reason: "too many requests" });
  const { registry } = makeRegistry({ checkpoint });
  const session = newSession(registry);
  registry.appendMutation(session.session_id, { op: "insert", pos: 0, del_len: 0, ins_len: 1, source: "typing" });
  await registry.awaitObservationIdle(session.session_id);
  const obs = registry.get(session.session_id).observation;
  assert.equal(obs.next_backoff_ms, 1_000);
  assert.equal(obs.state, "unknown"); // never committed; stays unknown
});

test("11. 409 conflict pins observation to 'diverged' and stops further checkpoints", async () => {
  const checkpoint = recordingCheckpoint();
  // First call succeeds at event_count=1.
  // Second call (after 50 more events) returns conflict.
  checkpoint.queue(undefined, { ok: false, kind: "conflict", status: 409, reason: "chain mismatch" });
  const { registry } = makeRegistry({ checkpoint });
  const session = newSession(registry);
  registry.appendMutation(session.session_id, { op: "insert", pos: 0, del_len: 0, ins_len: 1, source: "typing" });
  await registry.awaitObservationIdle(session.session_id);
  appendMany(registry, session.session_id, 50, 1);
  await registry.awaitObservationIdle(session.session_id);
  assert.equal(registry.get(session.session_id).observation.state, "diverged");
  // Further events do not trigger anything.
  const callsBefore = checkpoint.calls.length;
  registry.appendMutation(session.session_id, { op: "insert", pos: 51, del_len: 0, ins_len: 1, source: "typing" });
  await registry.awaitObservationIdle(session.session_id);
  assert.equal(checkpoint.calls.length, callsBefore, "diverged session stops checkpointing");
});

test("12. 400 client_bug pins observation to 'diverged'", async () => {
  const checkpoint = recordingCheckpoint();
  checkpoint.queue({ ok: false, kind: "client_bug", status: 400, reason: "malformed request" });
  const { registry } = makeRegistry({ checkpoint });
  const session = newSession(registry);
  registry.appendMutation(session.session_id, { op: "insert", pos: 0, del_len: 0, ins_len: 1, source: "typing" });
  await registry.awaitObservationIdle(session.session_id);
  assert.equal(registry.get(session.session_id).observation.state, "diverged");
});

test("13. 404 observation_unavailable resets observation; next mutation gets a fresh observed_session_id", async () => {
  const checkpoint = recordingCheckpoint();
  // First call: commit at event_count=1.
  // Second call (cadence at event_count=51): server returns 404 unavailable.
  // Third call (after next mutation): a brand-new observed_session_id must be minted.
  const { registry } = makeRegistry({ checkpoint });
  const session = newSession(registry);
  registry.appendMutation(session.session_id, { op: "insert", pos: 0, del_len: 0, ins_len: 1, source: "typing" });
  await registry.awaitObservationIdle(session.session_id);
  const obs_id_before = registry.get(session.session_id).observation.observed_session_id;
  assert.ok(obs_id_before, "checkpoint #1 must have set observed_session_id");

  checkpoint.queue({ ok: false, kind: "unavailable", status: 404, reason: "observation_unavailable" });
  appendMany(registry, session.session_id, 50, 1);
  await registry.awaitObservationIdle(session.session_id);

  let obs = registry.get(session.session_id).observation;
  assert.equal(obs.state, "unknown");
  assert.equal(obs.observed_session_id, null);
  assert.equal(obs.last_observed_token, null);
  assert.equal(obs.last_committed_event_count, 0);
  assert.equal(obs.commitments.length, 0);

  // The next event triggers a fresh checkpoint with a freshly minted observed_session_id.
  registry.appendMutation(session.session_id, { op: "insert", pos: 51, del_len: 0, ins_len: 1, source: "typing" });
  await registry.awaitObservationIdle(session.session_id);
  obs = registry.get(session.session_id).observation;
  assert.ok(obs.observed_session_id, "fresh observed_session_id minted after reset");
  assert.notEqual(obs.observed_session_id, obs_id_before, "must not reuse the dead observed_session_id");
});

test("14. single-in-flight + queued coalescing: bursty appends fold into at most 2 calls", async () => {
  let resolveFirst;
  const firstPromise = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  let callIndex = 0;
  const checkpoint = {
    calls: [],
    async postCheckpoint(request) {
      checkpoint.calls.push(request);
      callIndex += 1;
      if (callIndex === 1) {
        // Block the first call until the test releases it.
        await firstPromise;
      }
      return {
        ok: true,
        response: {
          observed_session_id: request.observed_session_id,
          token: `tok-${callIndex}`,
          checkpoint_id: `cp-${callIndex}`,
          event_count: request.event_count,
          chain_tip: request.chain_tip,
          server_t: new Date(1_700_000_002_000 + callIndex).toISOString(),
          created: true,
        },
      };
    },
  };
  const { registry } = makeRegistry({ checkpoint });
  const session = newSession(registry);
  // First mutation → kicks call #1 which is blocked.
  registry.appendMutation(session.session_id, { op: "insert", pos: 0, del_len: 0, ins_len: 1, source: "typing" });
  // Many more mutations while call #1 is in flight — all coalesce into a single "queued" flag.
  appendMany(registry, session.session_id, 200, 1);
  // Release the first call.
  resolveFirst();
  await registry.awaitObservationIdle(session.session_id);
  assert.equal(checkpoint.calls.length, 2, "bursty appends fold into one trailing call");
  assert.equal(checkpoint.calls[0].event_count, 1);
  assert.equal(checkpoint.calls[1].event_count, 201);
});

test("15. chain_tip from incremental advance equals full-chain recomputation", async () => {
  const checkpoint = recordingCheckpoint();
  const { registry } = makeRegistry({ checkpoint });
  const session = newSession(registry);
  appendMany(registry, session.session_id, 25);
  await registry.flushObservation(session.session_id);
  const live = registry.get(session.session_id);
  // Recompute the chain from scratch using the same advanceChain helper and assert tip match.
  let tip = null;
  for (const event of live.events) {
    tip = advanceChain(tip, event, live.session_id, FORMAT_VERSION);
  }
  assert.equal(live.last_event_chain_tip, tip);
  // And the last checkpoint must have carried that exact tip on the wire.
  const lastCall = checkpoint.calls[checkpoint.calls.length - 1];
  assert.equal(lastCall.chain_tip, tip);
  assert.equal(lastCall.event_count, 25);
});

test("16. token loss mid-stream (observation_unavailable) reuses session, mints fresh observed_session_id, never sends old token", async () => {
  const checkpoint = recordingCheckpoint();
  const { registry } = makeRegistry({ checkpoint });
  const session = newSession(registry);
  registry.appendMutation(session.session_id, { op: "insert", pos: 0, del_len: 0, ins_len: 1, source: "typing" });
  await registry.awaitObservationIdle(session.session_id);
  const oldToken = registry.get(session.session_id).observation.last_observed_token;
  const oldObsId = registry.get(session.session_id).observation.observed_session_id;
  // Mid-stream loss
  checkpoint.queue({ ok: false, kind: "unavailable", status: 404, reason: "observation_unavailable" });
  appendMany(registry, session.session_id, 50, 1);
  await registry.awaitObservationIdle(session.session_id);
  // Now append more → fresh observed_session_id is minted; old token MUST NOT appear in any later request.
  registry.appendMutation(session.session_id, { op: "insert", pos: 51, del_len: 0, ins_len: 1, source: "typing" });
  await registry.awaitObservationIdle(session.session_id);
  const finalCall = checkpoint.calls[checkpoint.calls.length - 1];
  assert.notEqual(finalCall.observed_session_id, oldObsId);
  assert.notEqual(finalCall.token, oldToken);
  // The same writing session keeps its original session_id.
  assert.equal(registry.get(session.session_id).session_id, session.session_id);
});

test("getObservationEnvelope returns null when no checkpoint adapter is wired", async () => {
  const { registry } = makeRegistry();
  const session = newSession(registry);
  registry.appendMutation(session.session_id, { op: "insert", pos: 0, del_len: 0, ins_len: 1, source: "typing" });
  assert.equal(registry.getObservationEnvelope(session.session_id), null);
  const live = registry.get(session.session_id);
  assert.equal(live.observation.state, "disabled");
});

test("9b. queued events during transient failure do not bypass next_backoff_ms", async () => {
  // Regression: an earlier draft of #runCheckpointLoop drained the queued flag
  // even on failure, which let bursty typing produce immediate retries and
  // bypass backoff. The loop must exit on failure so that #shouldTrigger can
  // gate the next attempt.
  let resolveFirst;
  const firstPromise = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  let callIndex = 0;
  const checkpoint = {
    calls: [],
    async postCheckpoint(request) {
      checkpoint.calls.push(request);
      callIndex += 1;
      if (callIndex === 1) {
        await firstPromise;
        return { ok: false, kind: "transient", status: 503, reason: "down" };
      }
      return {
        ok: true,
        response: {
          observed_session_id: request.observed_session_id ?? `obs-${callIndex}`,
          token: `tok-${callIndex}`,
          checkpoint_id: `cp-${callIndex}`,
          event_count: request.event_count,
          chain_tip: request.chain_tip,
          server_t: new Date(1_700_000_010_000 + callIndex).toISOString(),
          created: true,
        },
      };
    },
  };
  const clock = mutableClock(0);
  const { registry } = makeRegistry({ checkpoint, clock });
  const session = newSession(registry);
  // First event kicks call #1 which is blocked.
  registry.appendMutation(session.session_id, { op: "insert", pos: 0, del_len: 0, ins_len: 1, source: "typing" });
  // Burst-type 50 events while call #1 is in flight — these set the queued flag.
  appendMany(registry, session.session_id, 50, 1);
  // Release the first call to return a transient failure.
  resolveFirst();
  await registry.awaitObservationIdle(session.session_id);
  assert.equal(checkpoint.calls.length, 1, "trailing queued call must not fire while backoff is active");
  const obs = registry.get(session.session_id).observation;
  assert.equal(obs.next_backoff_ms, 1_000, "first transient sets backoff to initial 1000ms");

  // Within the backoff window — new mutation still gated.
  clock.advance(999);
  registry.appendMutation(session.session_id, { op: "insert", pos: 51, del_len: 0, ins_len: 1, source: "typing" });
  await registry.awaitObservationIdle(session.session_id);
  assert.equal(checkpoint.calls.length, 1, "backoff window still active");

  // Past the backoff window — next mutation triggers call #2 covering the tail.
  clock.advance(2);
  registry.appendMutation(session.session_id, { op: "insert", pos: 52, del_len: 0, ins_len: 1, source: "typing" });
  await registry.awaitObservationIdle(session.session_id);
  assert.equal(checkpoint.calls.length, 2, "backoff elapsed → catch-up call");
  assert.equal(checkpoint.calls[1].event_count, 53, "catch-up covers everything");
});

test("snapshot round-trip clears in-flight + queued and preserves commitments", async () => {
  const checkpoint = recordingCheckpoint();
  const storage = inMemoryStorage();
  const first = makeRegistry({ checkpoint, storage });
  const session = newSession(first.registry);
  appendMany(first.registry, session.session_id, 10);
  await first.registry.flushObservation(session.session_id);
  await first.registry.persist();

  const second = makeRegistry({ checkpoint: recordingCheckpoint(), storage });
  await second.registry.init();
  const reloaded = second.registry.get(session.session_id);
  assert.ok(reloaded);
  assert.equal(reloaded.observation.in_flight, false);
  assert.equal(reloaded.observation.queued, false);
  assert.equal(reloaded.observation.commitments.length >= 1, true);
});
