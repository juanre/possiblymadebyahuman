import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";

import { DraftStore, adoptSessions, createCoalescingWriter, draftTitle } from "../apps/web/src/drafts.ts";

let databaseCounter = 0;
const freshStore = () => new DraftStore({ name: `pmbah.write.drafts.test.${++databaseCounter}` });

function draft(overrides = {}) {
  return {
    draft_id: "d1",
    name: null,
    text: "",
    text_tag: null,
    session_ids: ["s1"],
    created_ms: 1000,
    updated_ms: 1000,
    ...overrides,
  };
}

function session(id, overrides = {}) {
  return {
    session_id: id,
    state: "active",
    base_wall_ms: 100,
    last_edit_wall_ms: 200,
    capture_context: { surface: "web-draft" },
    ...overrides,
  };
}

test("draft titles prefer a private name, then the first written line", () => {
  assert.equal(draftTitle(draft({ name: "Letter to Ana", text: "Dear Ana" })), "Letter to Ana");
  assert.equal(draftTitle(draft({ text: "\n\n   Dear   Ana,\nthank you" })), "Dear Ana,");
  assert.equal(draftTitle(draft({ text: "x".repeat(80) })), `${"x".repeat(59)}…`);
  assert.equal(draftTitle(draft({ text: "  \n\t" })), "Untitled draft");
  assert.equal(draftTitle(draft({ name: "   ", text: "" })), "Untitled draft");
});

test("the draft store keeps text in its own database and lists newest first", async () => {
  const store = freshStore();
  await store.put(draft({ draft_id: "old", updated_ms: 1 }));
  await store.put(draft({ draft_id: "new", text: "hello", updated_ms: 5 }));
  assert.deepEqual((await store.list()).map(row => row.draft_id), ["new", "old"]);
  assert.equal((await store.get("new")).text, "hello");
  await store.delete("new");
  assert.equal(await store.get("new"), undefined);
  assert.deepEqual((await store.list()).map(row => row.draft_id), ["old"]);
});

test("existing sessions become drafts, one per continuation chain, with no text", () => {
  const adopted = adoptSessions([], [
    session("a", { state: "uploaded", last_edit_wall_ms: 300, uploaded_response: { record_hash: "b3:a" } }),
    session("b", { parent_record: "b3:a", last_edit_wall_ms: 400 }),
    session("c", { state: "failed_upload", base_wall_ms: 50, last_edit_wall_ms: 90 }),
    session("x", { capture_context: { surface: "browser" } }),
  ], () => "generated");
  assert.equal(adopted.length, 2);
  const chain = adopted.find(row => row.session_ids.includes("a"));
  assert.deepEqual(chain.session_ids, ["a", "b"]);
  assert.equal(chain.text, "");
  assert.equal(chain.text_tag, null);
  assert.equal(chain.updated_ms, 400);
  assert.deepEqual(adopted.find(row => row.session_ids.includes("c")).session_ids, ["c"]);
});

test("sessions already owned by a draft are not adopted again", () => {
  const owned = draft({ session_ids: ["a", "b"] });
  const adopted = adoptSessions([owned], [
    session("a", { state: "uploaded", uploaded_response: { record_hash: "b3:a" } }),
    session("b", { parent_record: "b3:a" }),
  ], () => "generated");
  assert.deepEqual(adopted, []);
});

test("a continuation of an owned record joins that draft instead of starting another", () => {
  const owned = draft({ session_ids: ["a"] });
  const adopted = adoptSessions([owned], [
    session("a", { state: "uploaded", uploaded_response: { record_hash: "b3:a" } }),
    session("b", { parent_record: "b3:a", last_edit_wall_ms: 900 }),
  ], () => "generated");
  assert.equal(adopted.length, 1);
  assert.equal(adopted[0].draft_id, "d1");
  assert.deepEqual(adopted[0].session_ids, ["a", "b"]);
});

test("the coalescing writer saves only the latest value, in order, and flush waits for it", async () => {
  const written = [];
  let release;
  const writer = createCoalescingWriter(async value => {
    if (value === 1) await new Promise(resolve => { release = resolve; });
    written.push(value);
  }, 0);
  writer.schedule(1);
  await new Promise(resolve => setTimeout(resolve, 5));
  writer.schedule(2);
  writer.schedule(3);
  const flushed = writer.flush();
  release();
  await flushed;
  assert.deepEqual(written, [1, 3]);
});

test("a failed coalesced write is reported and the value stays pending for retry", async () => {
  let fail = true;
  const written = [];
  const writer = createCoalescingWriter(async value => {
    if (fail) throw new Error("quota exceeded");
    written.push(value);
  }, 0);
  writer.schedule("draft");
  await assert.rejects(writer.flush(), /quota exceeded/);
  fail = false;
  await writer.flush();
  assert.deepEqual(written, ["draft"]);
});

test("saving text updates an existing draft and never recreates a deleted one", async () => {
  const store = freshStore();
  await store.put(draft({ draft_id: "kept", text: "one" }));
  assert.equal(await store.update("kept", { text: "two", updated_ms: 2 }), true);
  assert.equal((await store.get("kept")).text, "two");
  await store.delete("kept");
  assert.equal(await store.update("kept", { text: "late save", updated_ms: 3 }), false);
  assert.equal(await store.get("kept"), undefined);
});

test("a scheduled value settles after the debounced write and reports its failure", async () => {
  const written = [];
  let fail = false;
  const writer = createCoalescingWriter(async value => {
    if (fail) throw new Error("disk full");
    written.push(value);
  }, 10);
  const first = writer.schedule("a");
  const second = writer.schedule("b");
  assert.equal(writer.hasPending(), true);
  await Promise.all([first, second]);
  assert.deepEqual(written, ["b"]);
  assert.equal(writer.hasPending(), false);
  fail = true;
  await assert.rejects(writer.schedule("c"), /disk full/);
  assert.equal(writer.hasPending(), true);
});
