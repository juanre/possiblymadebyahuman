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

test("paged reader reports progress after every verified page", async () => {
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
  const readPage = async (offset, limit) => {
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
  const counts = [];
  await verifyPagedRecord(manifest, readPage, (progress) =>
    counts.push(progress.count),
  );
  assert.deepEqual(counts, [EVENT_PAGE_SIZE, EVENT_PAGE_SIZE * 2, 9000]);
});

test("stats start a continuation's length from its parent's and report where they started", () => {
  const edits = [
    { seq: 0, t: 0, op: "insert", pos: 120, del_len: 0, ins_len: 3, source: "typing" },
    { seq: 1, t: 150, op: "delete", pos: 50, del_len: 5, ins_len: 0, source: "typing" },
  ];
  const finish = (options) => {
    const state = createAnalysisAccumulator(undefined, options);
    for (const e of edits) appendAnalysisEvent(state, e);
    // Chunked uploads persist the accumulator between requests.
    return finalizeAnalysis(JSON.parse(JSON.stringify(state)), manifestFor(edits), { p50: 150, p90: 150, p95: 150, p99: 150 }).stats;
  };
  assert.deepEqual([finish().starting_length, finish().observed_final_length], [0, null]);
  assert.deepEqual([finish({ startingLength: 200 }).starting_length, finish({ startingLength: 200 }).observed_final_length], [200, 198]);
  assert.deepEqual([finish({ startingLength: null }).starting_length, finish({ startingLength: null }).observed_final_length], [null, null]);
});

test("the paged reader starts a continuation's length from its parent's", async () => {
  const { verifyPagedRecord } = await import("../apps/web/src/stream-record.ts");
  // Typing at the end of 500 characters of existing text.
  const events = Array.from({ length: 20 }, (_, i) => ({ ...event(i), pos: 500 + i }));
  const manifest = manifestFor(events);
  let tip = null;
  const tips = events.map(e => (tip = advanceEventHash(tip, e, sessionId, "0.3")));
  const readPage = async (offset, limit) => {
    const page = events.slice(offset, offset + limit), next = offset + page.length;
    return { events: page, total_events: events.length, next_offset: next === events.length ? null : next, chain_tip_before: tips[offset - 1] ?? null, chain_tip_after: tips[next - 1] };
  };
  const lengths = overview => overview.bins.flatMap(bin => [bin.minimum_length, bin.maximum_length]).filter(value => value !== null);
  assert.deepEqual(lengths((await verifyPagedRecord(manifest, readPage)).overview), [], "from an empty start the length is unknown");
  const continued = (await verifyPagedRecord(manifest, readPage, undefined, 500)).overview;
  assert.equal(Math.min(...lengths(continued)), 501);
  assert.equal(Math.max(...lengths(continued)), 520);
  assert.equal(continued.known_length_events, 20);
});
