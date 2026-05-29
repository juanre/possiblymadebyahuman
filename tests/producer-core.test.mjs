import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalizeEvent,
  computeRecordHash,
  validateManifest,
} from "../packages/format/src/index.ts";
import {
  PRODUCER_CORE_PACKAGE,
  SessionFrozenError,
  SessionRegistry,
  UnknownSessionError,
  buildCaptureContext,
  isExactDescriptorMatch,
  isPartialDescriptorMatch,
  redactCaptureContext,
  resolveSession,
  stripQueryAndHash,
  sweepExpired,
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
    peek() {
      return snapshot.map((record) => structuredClone(record));
    },
  };
}

function recordingUpload() {
  const calls = [];
  let next;
  return {
    async postRecord(payload) {
      calls.push(payload);
      if (next instanceof Error) throw next;
      return next ?? {
        record_hash: payload.manifest.record_hash,
        short_signature: "TestSig123",
        url: `https://example.test/TestSig123`,
        created: true,
      };
    },
    calls,
    queueResponse(response) {
      next = response;
    },
    queueError(error) {
      next = error;
    },
  };
}

const producer = {
  id: "test-producer",
  version: "0.1.0",
  capabilities: ["timing"],
};

const originA = { origin: "https://a.test", path: "/thread/1", tab_id: 11, frame_id: 0 };
const originB = { origin: "https://b.test", path: "/post", tab_id: 22, frame_id: 0 };

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

function captureForOrigin(origin, desc) {
  return buildCaptureContext({ origin, descriptor: desc, page_title: "Test Page" });
}

function makeRegistry(opts = {}) {
  const clock = opts.clock ?? mutableClock();
  const uuid = opts.uuid ?? deterministicUuids();
  const storage = opts.storage ?? inMemoryStorage();
  const registry = new SessionRegistry({ clock, uuid, storage, producer });
  return { registry, clock, uuid, storage };
}

test("producer-core package identifier is exported", () => {
  assert.equal(PRODUCER_CORE_PACKAGE, "@possiblymadebyahuman/producer-core");
});

test("1. fresh session has stable id, 'fresh' certainty, and 'active' state", () => {
  const { registry, clock } = makeRegistry();
  clock.set(1_000);
  const desc = descriptor();
  const session = registry.findOrCreate(originA, desc, captureForOrigin(originA, desc));
  assert.equal(session.identity_certainty, "fresh");
  assert.equal(session.state, "active");
  assert.equal(session.base_wall_ms, 1_000);
  assert.equal(session.last_edit_wall_ms, 1_000);
  assert.equal(session.events.length, 0);
  assert.match(session.session_id, /^[0-9a-f-]{36}$/);
});

test("2. two fields on the same origin get distinct session ids", () => {
  const { registry } = makeRegistry();
  const left = descriptor({ id: "comment-1", index_among_similar: 0, dom_signature: "sig-left" });
  const right = descriptor({ id: "comment-2", index_among_similar: 1, dom_signature: "sig-right", name: "subject" });
  const a = registry.findOrCreate(originA, left, captureForOrigin(originA, left));
  const b = registry.findOrCreate(originA, right, captureForOrigin(originA, right));
  assert.notEqual(a.session_id, b.session_id);
  assert.equal(a.identity_certainty, "fresh");
  assert.equal(b.identity_certainty, "fresh");
});

test("3. parallel sessions across two origins isolate sign() to one field", () => {
  const { registry, clock } = makeRegistry();
  clock.set(100);
  const a1d = descriptor({ id: "a1", dom_signature: "a1" });
  const a2d = descriptor({ id: "a2", dom_signature: "a2", index_among_similar: 1 });
  const b1d = descriptor({ id: "b1", dom_signature: "b1" });

  const a1 = registry.findOrCreate(originA, a1d, captureForOrigin(originA, a1d));
  const a2 = registry.findOrCreate(originA, a2d, captureForOrigin(originA, a2d));
  const b1 = registry.findOrCreate(originB, b1d, captureForOrigin(originB, b1d));

  clock.set(200);
  registry.appendMutation(a1.session_id, { op: "insert", pos: 0, del_len: 0, ins_len: 5, source: "typing" });
  clock.set(220);
  registry.appendMutation(a2.session_id, { op: "insert", pos: 0, del_len: 0, ins_len: 3, source: "typing" });
  clock.set(240);
  registry.appendMutation(b1.session_id, { op: "insert", pos: 0, del_len: 0, ins_len: 4, source: "typing" });

  const draft = registry.sign(a1.session_id);
  assert.equal(draft.events.length, 1);

  const liveA2 = registry.get(a2.session_id);
  const liveB1 = registry.get(b1.session_id);
  assert.equal(liveA2.state, "active");
  assert.equal(liveB1.state, "active");
  assert.equal(liveA2.events.length, 1);
  assert.equal(liveB1.events.length, 1);
  registry.appendMutation(a2.session_id, { op: "insert", pos: 3, del_len: 0, ins_len: 2, source: "typing" });
  const refreshedA2 = registry.get(a2.session_id);
  assert.equal(refreshedA2.events.length, 2);
});

test("4. wall-clock idle gap is preserved (no compression)", () => {
  const { registry, clock } = makeRegistry();
  clock.set(1_000);
  const desc = descriptor();
  const session = registry.findOrCreate(originA, desc, captureForOrigin(originA, desc));
  clock.set(1_000);
  registry.appendMutation(session.session_id, { op: "insert", pos: 0, del_len: 0, ins_len: 2, source: "typing" });
  clock.set(1_200);
  registry.appendMutation(session.session_id, { op: "insert", pos: 2, del_len: 0, ins_len: 6, source: "paste" });
  clock.set(1_000 + 200 + 300_000);
  registry.appendMutation(session.session_id, { op: "insert", pos: 8, del_len: 0, ins_len: 1, source: "typing" });
  const live = registry.get(session.session_id);
  assert.deepEqual(live.events.map((event) => event.t), [0, 200, 300_200]);
});

test("5. resumed identity via storage round-trip", async () => {
  const storage = inMemoryStorage();
  const first = makeRegistry({ storage });
  first.clock.set(50);
  const desc = descriptor();
  const session = first.registry.findOrCreate(originA, desc, captureForOrigin(originA, desc));
  first.clock.set(60);
  first.registry.appendMutation(session.session_id, {
    op: "insert",
    pos: 0,
    del_len: 0,
    ins_len: 1,
    source: "typing",
  });
  await first.registry.persist();

  const second = makeRegistry({ storage });
  await second.registry.init();
  const sameDescriptor = descriptor();
  second.clock.set(900);
  const resumed = second.registry.findOrCreate(originA, sameDescriptor, captureForOrigin(originA, sameDescriptor));
  assert.equal(resumed.session_id, session.session_id);
  assert.equal(resumed.identity_certainty, "resumed");
  assert.equal(resumed.events.length, 1);
});

test("6. degraded identity surfaces a new session when dom signature changes", () => {
  const { registry } = makeRegistry();
  const original = descriptor({ dom_signature: "sig-1" });
  const session = registry.findOrCreate(originA, original, captureForOrigin(originA, original));
  const rewritten = descriptor({ dom_signature: "sig-2" });
  const next = registry.findOrCreate(originA, rewritten, captureForOrigin(originA, rewritten));
  assert.notEqual(session.session_id, next.session_id);
  assert.equal(next.identity_certainty, "degraded");
  assert.equal(registry.list().length, 2);
});

test("7. sign chain matches packages/format computeRecordHash", () => {
  const { registry, clock } = makeRegistry();
  const desc = descriptor();
  clock.set(0);
  const session = registry.findOrCreate(originA, desc, captureForOrigin(originA, desc));
  clock.set(0);
  registry.appendMutation(session.session_id, { op: "insert", pos: 0, del_len: 0, ins_len: 2, source: "typing" });
  clock.set(120);
  registry.appendMutation(session.session_id, { op: "insert", pos: 2, del_len: 0, ins_len: 6, source: "paste" });
  clock.set(180);
  registry.appendMutation(session.session_id, { op: "delete", pos: 7, del_len: 1, ins_len: 0, source: "cut" });
  clock.set(240);
  registry.appendMutation(session.session_id, { op: "insert", pos: 7, del_len: 0, ins_len: 1, source: "typing" });

  const draft = registry.sign(session.session_id);
  const recomputed = computeRecordHash(draft.events, session.session_id, draft.manifest.format_version);
  assert.equal(draft.manifest.record_hash, recomputed);
  assert.deepEqual(validateManifest(draft.manifest), []);
});

test("8. TTL sweep removes only sessions past the configured ttl", () => {
  const { registry, clock } = makeRegistry();
  const oneDay = 24 * 60 * 60 * 1000;
  clock.set(0);
  const a = registry.findOrCreate(originA, descriptor({ id: "x" }), captureForOrigin(originA, descriptor({ id: "x" })));
  clock.set(oneDay / 2);
  const b = registry.findOrCreate(originA, descriptor({ id: "y", dom_signature: "y" }), captureForOrigin(originA, descriptor({ id: "y", dom_signature: "y" })));
  clock.set(4.5 * oneDay);
  const c = registry.findOrCreate(originB, descriptor({ id: "z", dom_signature: "z" }), captureForOrigin(originB, descriptor({ id: "z", dom_signature: "z" })));

  clock.set(5 * oneDay);
  const removed = registry.sweep();
  const remaining = registry.list().map((record) => record.session_id);
  assert.equal(removed.length, 2);
  assert.deepEqual(remaining, [c.session_id]);
  assert.ok(removed.find((record) => record.session_id === a.session_id));
  assert.ok(removed.find((record) => record.session_id === b.session_id));
});

test("9. signing flips state and blocks further appendMutation until upload completes", () => {
  const { registry, clock } = makeRegistry();
  clock.set(0);
  const desc = descriptor();
  const session = registry.findOrCreate(originA, desc, captureForOrigin(originA, desc));
  registry.appendMutation(session.session_id, { op: "insert", pos: 0, del_len: 0, ins_len: 3, source: "typing" });

  registry.sign(session.session_id);
  assert.equal(registry.get(session.session_id).state, "signing");

  registry.markUploading(session.session_id);
  assert.throws(
    () => registry.appendMutation(session.session_id, { op: "insert", pos: 3, del_len: 0, ins_len: 1, source: "typing" }),
    SessionFrozenError,
  );

  registry.markUploaded(session.session_id, {
    record_hash: registry.get(session.session_id).events[0]?.t === 0 ? "b3:" + "0".repeat(64) : "b3:" + "0".repeat(64),
    short_signature: "Sig123ABCD",
    url: "https://example.test/Sig123ABCD",
    created: true,
  });
  const final = registry.get(session.session_id);
  assert.equal(final.state, "uploaded");
  assert.equal(final.uploaded_response?.short_signature, "Sig123ABCD");
});

test("10. failed upload retains events and reason; retry clears the reason on success", () => {
  const { registry, clock } = makeRegistry();
  clock.set(0);
  const desc = descriptor();
  const session = registry.findOrCreate(originA, desc, captureForOrigin(originA, desc));
  registry.appendMutation(session.session_id, { op: "insert", pos: 0, del_len: 0, ins_len: 4, source: "typing" });
  registry.sign(session.session_id);
  registry.markUploading(session.session_id);
  registry.markFailedUpload(session.session_id, "http 500 backend");
  const failed = registry.get(session.session_id);
  assert.equal(failed.state, "failed_upload");
  assert.equal(failed.last_failure_reason, "http 500 backend");
  assert.equal(failed.events.length, 1);

  registry.markUploading(session.session_id);
  assert.equal(registry.get(session.session_id).state, "uploading");
  assert.equal(registry.get(session.session_id).last_failure_reason, undefined);
  registry.markUploaded(session.session_id, {
    record_hash: "b3:" + "0".repeat(64),
    short_signature: "Recovered1",
    url: "https://example.test/Recovered1",
    created: true,
  });
  assert.equal(registry.get(session.session_id).state, "uploaded");
});

test("11. signing one session leaves siblings active and writable", () => {
  const { registry, clock } = makeRegistry();
  clock.set(0);
  const left = descriptor({ id: "left" });
  const right = descriptor({ id: "right", dom_signature: "sig-right", name: "right-name" });
  const sessionA = registry.findOrCreate(originA, left, captureForOrigin(originA, left));
  const sessionB = registry.findOrCreate(originA, right, captureForOrigin(originA, right));
  registry.appendMutation(sessionA.session_id, { op: "insert", pos: 0, del_len: 0, ins_len: 2, source: "typing" });
  registry.appendMutation(sessionB.session_id, { op: "insert", pos: 0, del_len: 0, ins_len: 3, source: "typing" });

  registry.sign(sessionA.session_id);
  registry.markUploading(sessionA.session_id);

  registry.appendMutation(sessionB.session_id, { op: "insert", pos: 3, del_len: 0, ins_len: 1, source: "typing" });
  assert.equal(registry.get(sessionB.session_id).events.length, 2);
});

test("12. canonicalizeEvent round-trip matches the bytes feeding computeRecordHash", () => {
  const { registry, clock } = makeRegistry();
  clock.set(0);
  const desc = descriptor();
  const session = registry.findOrCreate(originA, desc, captureForOrigin(originA, desc));
  registry.appendMutation(session.session_id, { op: "insert", pos: 0, del_len: 0, ins_len: 1, source: "typing" });
  clock.set(50);
  registry.appendMutation(session.session_id, { op: "insert", pos: 1, del_len: 0, ins_len: 1, source: "paste" });

  const draft = registry.sign(session.session_id);
  const canonicalLines = draft.events.map((event) => canonicalizeEvent(event));
  for (const line of canonicalLines) {
    assert.ok(line.startsWith("{") && line.endsWith("}"));
    assert.doesNotMatch(line, /\s/);
  }
  const recomputed = computeRecordHash(draft.events, session.session_id, draft.manifest.format_version);
  assert.equal(draft.manifest.record_hash, recomputed);
});

test("13. same kernel + different upload adapters produce identical manifests", async () => {
  const baseClock = mutableClock(0);
  const baseUuid = deterministicUuids();
  const seed = [];
  const storage1 = inMemoryStorage(seed);
  const storage2 = inMemoryStorage(seed);

  const r1 = new SessionRegistry({ clock: baseClock, uuid: baseUuid, storage: storage1, producer });
  const r2Uuid = deterministicUuids();
  const r2Clock = mutableClock(0);
  const r2 = new SessionRegistry({ clock: r2Clock, uuid: r2Uuid, storage: storage2, producer });

  baseClock.set(0);
  const session1 = r1.findOrCreate(originA, descriptor(), captureForOrigin(originA, descriptor()));
  baseClock.set(120);
  r1.appendMutation(session1.session_id, { op: "insert", pos: 0, del_len: 0, ins_len: 2, source: "typing" });

  r2Clock.set(0);
  const session2 = r2.findOrCreate(originA, descriptor(), captureForOrigin(originA, descriptor()));
  r2Clock.set(120);
  r2.appendMutation(session2.session_id, { op: "insert", pos: 0, del_len: 0, ins_len: 2, source: "typing" });

  assert.equal(session1.session_id, session2.session_id);
  const draft1 = r1.sign(session1.session_id);
  const draft2 = r2.sign(session2.session_id);
  assert.equal(draft1.manifest.record_hash, draft2.manifest.record_hash);
  assert.deepEqual(draft1.events, draft2.events);

  const upload1 = recordingUpload();
  const upload2 = recordingUpload();
  await upload1.postRecord(draft1);
  await upload2.postRecord(draft2);
  assert.deepEqual(upload1.calls[0].manifest, upload2.calls[0].manifest);
});

test("14. snapshot/load round-trip preserves identity and events", async () => {
  const storage = inMemoryStorage();
  const first = makeRegistry({ storage });
  first.clock.set(0);
  const desc = descriptor();
  const session = first.registry.findOrCreate(originA, desc, captureForOrigin(originA, desc));
  first.clock.set(50);
  first.registry.appendMutation(session.session_id, { op: "insert", pos: 0, del_len: 0, ins_len: 1, source: "typing" });
  await first.registry.persist();

  const second = makeRegistry({ storage });
  await second.registry.init();
  const reloaded = second.registry.get(session.session_id);
  assert.ok(reloaded);
  assert.equal(reloaded.events.length, 1);
  assert.equal(reloaded.events[0].t, 50);
  assert.equal(reloaded.state, "active");
});

test("public ingest shape never contains plaintext keys", () => {
  const { registry } = makeRegistry();
  const desc = descriptor();
  const session = registry.findOrCreate(originA, desc, captureForOrigin(originA, desc));
  registry.appendMutation(session.session_id, { op: "insert", pos: 0, del_len: 0, ins_len: 5, source: "typing" });
  const draft = registry.sign(session.session_id);
  const json = JSON.stringify(draft);
  for (const banned of ['"text"', '"plaintext"', '"content"', '"ins_text"', '"ins_hash"', '"final_text"']) {
    assert.ok(!json.includes(banned), `draft includes banned plaintext key ${banned}`);
  }
});

test("identity helpers expose match policy independently", () => {
  const left = descriptor();
  const exact = descriptor();
  assert.ok(isExactDescriptorMatch(left, exact));
  const drifted = descriptor({ dom_signature: "sig-shift" });
  assert.ok(!isExactDescriptorMatch(left, drifted));
  assert.ok(isPartialDescriptorMatch(left, drifted));
  const unrelated = { ...descriptor({ name: "other", id: "other-id", dom_signature: "other" }), index_among_similar: 5 };
  assert.ok(!isPartialDescriptorMatch(left, unrelated));
});

test("capture context strips query/hash and supports redaction", () => {
  const ctx = buildCaptureContext({
    origin: { ...originA, path: "/thread/1" },
    descriptor: descriptor(),
    page_title: "Reply on Thread 1",
  });
  assert.equal(ctx.browser?.url, "https://a.test/thread/1");
  assert.equal(ctx.browser?.title, "Reply on Thread 1");
  const redacted = redactCaptureContext(ctx, { drop_title: true, replace_label: "anonymous reply" });
  assert.equal(redacted.browser?.title, undefined);
  assert.equal(redacted.label, "anonymous reply");
});

test("stripQueryAndHash drops both query and fragment", () => {
  assert.equal(stripQueryAndHash("https://a.test/thread/1?x=1#top"), "https://a.test/thread/1");
  assert.equal(stripQueryAndHash("https://a.test/thread/1#top"), "https://a.test/thread/1");
  assert.equal(stripQueryAndHash("https://a.test/thread/1"), "https://a.test/thread/1");
});

test("resolveSession on an empty registry returns 'fresh'", () => {
  let counter = 0;
  const resolution = resolveSession(originA, descriptor(), [], () => {
    counter += 1;
    return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`;
  });
  assert.equal(resolution.certainty, "fresh");
  assert.equal(resolution.session_id, "00000000-0000-4000-8000-000000000001");
});

test("sweepExpired returns kept+removed without mutating input", () => {
  const sample = [
    {
      session_id: "00000000-0000-4000-8000-000000000001",
      format_version: "0.1",
      base_wall_ms: 0,
      last_edit_wall_ms: 0,
      origin: originA,
      descriptor: descriptor(),
      identity_certainty: "fresh",
      producer,
      capture_context: { surface: "browser" },
      events: [],
      state: "active",
    },
  ];
  const result = sweepExpired(sample, 4 * 86_400_000, {});
  assert.equal(result.kept.length, 0);
  assert.equal(result.removed.length, 1);
  assert.equal(sample.length, 1);
});

test("discard removes a single session by id and leaves siblings untouched", () => {
  const { registry } = makeRegistry();
  const a = registry.findOrCreate(originA, descriptor({ id: "a" }), captureForOrigin(originA, descriptor({ id: "a" })));
  const b = registry.findOrCreate(originA, descriptor({ id: "b", dom_signature: "sig-b" }), captureForOrigin(originA, descriptor({ id: "b", dom_signature: "sig-b" })));
  registry.appendMutation(a.session_id, { op: "insert", pos: 0, del_len: 0, ins_len: 1, source: "typing" });
  registry.appendMutation(b.session_id, { op: "insert", pos: 0, del_len: 0, ins_len: 2, source: "typing" });
  const removed = registry.discard(a.session_id);
  assert.ok(removed);
  assert.equal(removed.session_id, a.session_id);
  assert.equal(registry.get(a.session_id), undefined);
  assert.ok(registry.get(b.session_id));
  // discarding a non-existent session is a no-op that returns null
  assert.equal(registry.discard("00000000-0000-4000-8000-000000abcdef"), null);
});

test("UnknownSessionError surfaces explicit id", () => {
  const { registry } = makeRegistry();
  assert.throws(
    () => registry.appendMutation("00000000-0000-4000-8000-deadbeefdead", { op: "insert", pos: 0, del_len: 0, ins_len: 1, source: "typing" }),
    UnknownSessionError,
  );
});
