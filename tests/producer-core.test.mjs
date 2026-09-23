import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalizeEvent,
  computeRecordHash,
  computeEventHashChain,
  createTextBinding,
  verifyRecord,
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
  const registry = new SessionRegistry({ clock, uuid, storage, producer, signedFinishTime: opts.signedFinishTime });
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

test("loading an interrupted signing operation preserves a frozen, exactly retryable record", () => {
  const { registry } = makeRegistry();
  const desc = descriptor();
  const session = registry.findOrCreate(originA, desc, captureForOrigin(originA, desc));
  registry.appendMutation(session.session_id, { op: "insert", pos: 0, del_len: 0, ins_len: 3, source: "typing" });
  const signed = registry.sign(session.session_id);
  const snapshot = registry.snapshot();
  assert.equal(snapshot[0].state, "signing");
  const { registry: restarted } = makeRegistry();
  restarted.load(snapshot);
  assert.equal(restarted.get(session.session_id).state, "failed_upload");
  assert.throws(() => restarted.appendMutation(session.session_id, { op: "insert", pos: 3, del_len: 0, ins_len: 1, source: "typing" }), SessionFrozenError);
  assert.deepEqual(restarted.sign(session.session_id), signed);
});

test("reopen resumes an uploaded session so editing and re-signing continue the same record", () => {
  const { registry, clock } = makeRegistry();
  clock.set(0);
  const desc = descriptor();
  const session = registry.findOrCreate(originA, desc, captureForOrigin(originA, desc));
  registry.appendMutation(session.session_id, { op: "insert", pos: 0, del_len: 0, ins_len: 3, source: "typing" });
  const firstDraft = registry.sign(session.session_id);
  registry.markUploading(session.session_id);
  registry.markUploaded(session.session_id, { record_hash: firstDraft.manifest.record_hash, short_signature: "First12345", url: "https://example.test/First12345", created: true });
  assert.equal(registry.get(session.session_id).state, "uploaded");
  assert.equal(firstDraft.events.length, 1);

  const reopened = registry.reopen(session.session_id);
  assert.equal(reopened.state, "active");
  assert.equal(reopened.events.length, 1, "events are kept across reopen");
  assert.equal(registry.get(session.session_id).uploaded_response, undefined);

  // Continue writing and sign again: the new record covers the whole process.
  registry.appendMutation(session.session_id, { op: "insert", pos: 3, del_len: 0, ins_len: 2, source: "typing" });
  const secondDraft = registry.sign(session.session_id);
  assert.equal(secondDraft.events.length, 2, "re-signed record spans original + new edits");
  assert.notEqual(secondDraft.manifest.record_hash, firstDraft.manifest.record_hash);

  // reopen is only valid from an uploaded session.
  assert.throws(() => registry.reopen(session.session_id), SessionFrozenError);
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

test("signed finish includes a two-month trailing pause without an edit and freezes retries", async () => {
  const { registry, clock, storage } = makeRegistry({ signedFinishTime: true });
  const desc = descriptor();
  const session = registry.findOrCreate(originA, desc, captureForOrigin(originA, desc));
  clock.set(1000);
  registry.appendMutation(session.session_id, { op: "insert", pos: 0, del_len: 0, ins_len: 1, source: "typing" });
  clock.set(60 * 86400000);
  const signed = registry.sign(session.session_id, { textBinding: createTextBinding("a", session.session_id) });
  assert.equal(signed.manifest.format_version, "0.3");
  assert.equal(signed.manifest.duration_ms, 60 * 86400000);
  assert.equal(signed.events.length, 1);
  assert.equal(signed.events[0].t, 1000);
  assert.equal(verifyRecord(signed).valid, true);
  registry.markUploading(session.session_id);
  await registry.persist();
  clock.advance(60 * 86400000);
  const { registry: restarted } = makeRegistry({ clock, storage, signedFinishTime: true });
  await restarted.init();
  assert.equal(restarted.get(session.session_id).state, "failed_upload");
  assert.deepEqual(restarted.sign(session.session_id, { textBinding: createTextBinding("different", session.session_id) }), signed);
});

test("0.2 draft upgrades at finish preserving checkpoint chain; old failed uploads keep their old hashes", () => {
  const { registry, clock } = makeRegistry();
  const desc = descriptor();
  const session = registry.findOrCreate(originA, desc, captureForOrigin(originA, desc));
  clock.set(1000);
  registry.appendMutation(session.session_id, { op: "insert", pos: 0, del_len: 0, ins_len: 1, source: "typing" });
  const oldSnapshot = registry.snapshot();
  const { registry: upgraded } = makeRegistry({ clock, signedFinishTime: true });
  upgraded.load(oldSnapshot);
  clock.set(60 * 86400000);
  const signed = upgraded.sign(session.session_id);
  assert.equal(signed.manifest.format_version, "0.3");
  assert.equal(signed.manifest.duration_ms, clock.now());
  assert.equal(computeEventHashChain(signed.events, session.session_id, "0.3").at(-1), oldSnapshot[0].last_event_chain_tip);
  const legacySigned = registry.sign(session.session_id);
  registry.markUploading(session.session_id);
  registry.markFailedUpload(session.session_id, "network unavailable");
  upgraded.load(registry.snapshot());
  clock.advance(60 * 86400000);
  assert.deepEqual(upgraded.sign(session.session_id), legacySigned);
});

test("explicit continuation keeps prior saved links and starts its clock at the signed finish", () => {
  const { registry, clock } = makeRegistry({ signedFinishTime: true });
  const desc = descriptor();
  const session = registry.findOrCreate(originA, desc, captureForOrigin(originA, desc));
  clock.set(1000);
  registry.appendMutation(session.session_id, { op: "insert", pos: 0, del_len: 0, ins_len: 1, source: "typing" });
  clock.set(5000);
  const first = registry.sign(session.session_id);
  registry.markUploading(session.session_id);
  registry.markUploaded(session.session_id, { record_hash: first.manifest.record_hash, short_signature: "saved", url: "https://example.test/saved", created: true });
  clock.advance(60 * 86400000);
  registry.sweep({ ttl_ms: Infinity, retain_uploaded_anchors: true });
  const anchor = registry.get(session.session_id);
  assert.equal(anchor.events.length, 0);
  const continuation = registry.continueFrom(session.session_id, { origin: originA, descriptor: desc });
  assert.notEqual(continuation.session_id, session.session_id);
  assert.equal(continuation.base_wall_ms, 5000);
  assert.equal(continuation.parent_record, first.manifest.record_hash);
  assert.deepEqual(registry.get(session.session_id), anchor);
  registry.appendMutation(continuation.session_id, { op: "insert", pos: 1, del_len: 0, ins_len: 1, source: "typing" });
  const second = registry.sign(continuation.session_id);
  assert.equal(second.events[0].pos, null, "pre-existing field content is not imported into the new segment");
  assert.equal(second.events[0].t, 60 * 86400000);
  assert.equal(second.manifest.duration_ms, 60 * 86400000);
  assert.equal(second.manifest.parent_record, first.manifest.record_hash);
  assert.equal(verifyRecord(second).valid, true);
  assert.equal(registry.get(session.session_id).uploaded_response.url, "https://example.test/saved");
});

test("finish after a backward clock adjustment never precedes the last recorded edit", () => {
  const { registry, clock } = makeRegistry({ signedFinishTime: true });
  const desc = descriptor();
  const session = registry.findOrCreate(originA, desc, captureForOrigin(originA, desc));
  clock.set(1000);
  registry.appendMutation(session.session_id, { op: "insert", pos: 0, del_len: 0, ins_len: 1, source: "typing" });
  clock.set(100);
  assert.equal(registry.sign(session.session_id).manifest.duration_ms, 1000);
});

test("failed persisted removal restores saved links without losing other drafts' concurrent edits", async () => {
  const { registry, clock, storage } = makeRegistry();
  const desc = descriptor();
  const saved = registry.findOrCreate(originA, desc, captureForOrigin(originA, desc));
  registry.appendMutation(saved.session_id, { op: "insert", pos: 0, del_len: 0, ins_len: 1, source: "typing" });
  const signed = registry.sign(saved.session_id);
  registry.markUploading(saved.session_id);
  registry.markUploaded(saved.session_id, { record_hash: signed.manifest.record_hash, short_signature: "saved", url: "https://example.test/saved", created: true });
  const active = registry.findOrCreate(originB, desc, captureForOrigin(originB, desc));
  await registry.persist();
  const write = storage.write;
  let first = true;
  storage.write = async snapshot => {
    if (first) {
      first = false;
      clock.advance(1000);
      registry.appendMutation(active.session_id, { op: "insert", pos: 0, del_len: 0, ins_len: 1, source: "typing" });
      throw new Error("Storage unavailable");
    }
    await write(snapshot);
  };
  await assert.rejects(registry.discardPersisted([saved.session_id]), /Storage unavailable/);
  assert.equal(registry.get(saved.session_id).uploaded_response.url, "https://example.test/saved");
  assert.equal(registry.get(active.session_id).events.length, 1);
  assert.equal(storage.peek().find(record => record.session_id === saved.session_id).uploaded_response.url, "https://example.test/saved");
  await registry.discardPersisted([saved.session_id]);
  assert.equal(registry.get(saved.session_id), undefined);
  assert.equal(storage.peek().some(record => record.session_id === saved.session_id), false);
});
