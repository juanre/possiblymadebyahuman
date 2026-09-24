import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  advanceEventHash,
  sealRecordHash,
  EventStreamVerifier,
  computeRecordHash,
} from "../packages/format/src/index.ts";
import { runDefaultAnalyzers } from "../packages/analyzers/src/index.ts";
import {
  createAnalysisAccumulator,
  appendAnalysisEvent,
  finalizeAnalysis,
} from "../packages/analyzers/src/streaming.ts";
import { computeRecordStats } from "../apps/ingest-api/src/index.ts";
const sessionId = "123e4567-e89b-42d3-a456-426614174002";
const event = (seq, t = seq * 150) => ({
  seq,
  t,
  op: "insert",
  pos: seq,
  del_len: 0,
  ins_len: 1,
  source: "typing",
});
const manifestFor = (events, version = "0.3") => ({
  format_version: version,
  session_id: sessionId,
  producer: {
    id: "test",
    version: "1",
    capabilities: ["timing", "source_attribution"],
  },
  event_count: events.length,
  duration_ms: events.at(-1).t + 100,
  attestations: [],
  record_hash: computeRecordHash(events, sessionId, version, undefined, {
    duration_ms: events.at(-1).t + 100,
  }),
});

test("incremental hashing preserves every historical hash-chain vector", async () => {
  for (const vector of JSON.parse(
    await readFile("packages/conformance/vectors/hash-chain.json", "utf8"),
  )) {
    let tip = null;
    for (const e of vector.events) {
      tip = advanceEventHash(tip, e, vector.session_id, vector.format_version);
      assert.equal(tip, vector.chain[e.seq]);
    }
    assert.equal(
      sealRecordHash(tip, vector.format_version, vector.text_binding, vector),
      vector.record_hash,
    );
  }
});
test("stream verification checks count, chronology, duration, final seal and remains poisoned after a rejected event", () => {
  const events = [event(0), event(1)];
  const manifest = manifestFor(events);
  const good = new EventStreamVerifier(manifest);
  for (const e of events) good.append(e);
  assert.equal(good.finish().valid, true);
  const short = new EventStreamVerifier(manifest);
  short.append(events[0]);
  assert.equal(short.finish().valid, false);
  const bad = new EventStreamVerifier(manifest);
  assert.throws(() => bad.append(events[1]), /gap-free/);
  assert.throws(() => bad.append(events[0]));
  assert.equal(bad.finish().valid, false);
  const backwards = new EventStreamVerifier(manifest);
  backwards.append(event(0, 50));
  assert.throws(() => backwards.append(event(1, 49)), /non-decreasing/);
  const duration = new EventStreamVerifier({ ...manifest, duration_ms: 1 });
  for (const e of events) duration.append(e);
  assert.equal(duration.finish().valid, false);
  const seal = new EventStreamVerifier({
    ...manifest,
    parent_record: "b3:" + "f".repeat(64),
  });
  for (const e of events) seal.append(e);
  assert.equal(seal.finish().valid, false);
});
test("serialized streaming state matches array entry points across chunk boundaries", () => {
  for (const capabilities of [[], ["timing", "source_attribution"]])
    for (const unknown of [false, true])
      for (const count of [1, 1000]) {
        const events = Array.from({ length: count }, (_, i) => ({
          ...event(i, Math.floor(i / 7) * 35000 + i),
          ...(i % 3 === 0 ? { source: "paste", ins_len: 99 } : {}),
          ...(i % 5 === 0
            ? { op: "replace", del_len: 2, source: "unknown" }
            : {}),
          ...(unknown && i % 11 === 0 ? { pos: null, ins_len: null } : {}),
        }));
        const manifest = {
          ...manifestFor(events),
          producer: { id: "test", version: "1", capabilities },
        };
        const record = { manifest, events };
        const expected = computeRecordStats(record);
        let state = createAnalysisAccumulator();
        for (const e of events) {
          appendAnalysisEvent(state, e);
          if (e.seq % 71 === 0) state = JSON.parse(JSON.stringify(state));
        }
        const result = finalizeAnalysis(state, manifest, {
          p50: expected.inter_event_delay_p50_ms,
          p90: expected.inter_event_delay_p90_ms,
          p95: expected.inter_event_delay_p95_ms,
          p99: expected.inter_event_delay_p99_ms,
        });
        assert.deepEqual(result.stats, expected);
        assert.deepEqual(result.signals, runDefaultAnalyzers(record));
      }
});
test("four million event two-year analysis retains fixed-size state", () => {
  const count = 4_000_000;
  const duration = 2 * 365 * 24 * 60 * 60 * 1000;
  const state = createAnalysisAccumulator();
  for (let i = 0; i < count; i++)
    appendAnalysisEvent(state, event(i, Math.floor((duration * i) / count)));
  assert.equal(state.count, count);
  assert.equal(state.observed_length, count);
  assert.equal(state.active + state.idle, state.last_t - state.first_t);
  assert.ok(
    JSON.stringify(state).length < 2000,
    "accumulator must not retain event/delay arrays",
  );
});

test("paged reader verifies all events with a fixed overview and rejects tampered page cursors", async () => {
  const { verifyPagedRecord, EVENT_PAGE_SIZE } = await import(
    "../apps/web/src/stream-record.ts"
  );
  const events = Array.from({ length: 9000 }, (_, i) => event(i));
  const manifest = manifestFor(events);
  const tips = [];
  let tip = null;
  for (const e of events) {
    tip = advanceEventHash(tip, e, sessionId, "0.3");
    tips.push(tip);
  }
  let requests = 0;
  const readPage = async (offset, limit) => {
    requests++;
    assert.equal(limit, EVENT_PAGE_SIZE);
    const page = events.slice(offset, offset + limit);
    const next = offset + page.length;
    return {
      events: page,
      total_events: events.length,
      next_offset: next === events.length ? null : next,
      chain_tip_before: tips[offset - 1] ?? null,
      chain_tip_after: tips[next - 1],
    };
  };
  const result = await verifyPagedRecord(manifest, readPage);
  assert.equal(result.verification.valid, true);
  assert.equal(requests, 3);
  assert.equal(result.overview.bins.length, 128);
  assert.equal(
    result.overview.bins.reduce((n, b) => n + b.count, 0),
    9000,
  );
  await assert.rejects(
    () =>
      verifyPagedRecord(manifest, async (offset, limit) => ({
        ...(await readPage(offset, limit)),
        next_offset: 0,
      })),
    /cursor/,
  );
  await assert.rejects(
    () =>
      verifyPagedRecord(manifest, async (offset, limit) => ({
        ...(await readPage(offset, limit)),
        chain_tip_after: "b3:" + "0".repeat(64),
      })),
    /hash/,
  );
  await assert.rejects(
    () =>
      verifyPagedRecord(manifest, async (offset, limit) => ({
        ...(await readPage(offset, limit)),
        events: [],
      })),
    /page size/,
  );
});
