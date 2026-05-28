import assert from "node:assert/strict";
import test from "node:test";

import { verifyRecord } from "../packages/format/src/index.ts";
import {
  buildTextFieldMutation,
  codepointCount,
  codepointOffsetOf,
  insertedCodepointsForInput,
  operationFor,
  sourceFromInputType,
} from "../apps/browser-extension/src/lib/codepoint.ts";
import {
  domSignature,
  extractDescriptor,
  fieldKindFor,
  indexAmongSimilar,
  isEligibleTag,
} from "../apps/browser-extension/src/lib/descriptor.ts";
import { findResumableSession, isFieldEligible } from "../apps/browser-extension/src/lib/policy.ts";
import { BackgroundDispatcher } from "../apps/browser-extension/src/lib/dispatcher.ts";

function shapeTarget({
  tagName,
  attrs = {},
  parentTag = "FORM",
  siblings = [],
}) {
  const target = {
    tagName,
    getAttribute(name) { return Object.hasOwn(attrs, name) ? attrs[name] : null; },
    closest(selector) {
      if (selector === "form" && parentTag === "FORM") {
        return { getAttribute: () => null };
      }
      return null;
    },
    matches() { return false; },
    parentElement: null,
  };
  const parent = {
    tagName: parentTag,
    children: [...siblings.map((sib) => ({ tagName: sib })), target],
    parentElement: null,
  };
  target.parentElement = parent;
  return target;
}

test("descriptor: textarea is eligible; password input is not", () => {
  assert.equal(isEligibleTag(shapeTarget({ tagName: "TEXTAREA" })), true);
  assert.equal(isEligibleTag(shapeTarget({ tagName: "INPUT", attrs: { type: "text" } })), true);
  assert.equal(isEligibleTag(shapeTarget({ tagName: "INPUT", attrs: { type: "email" } })), true);
  assert.equal(isEligibleTag(shapeTarget({ tagName: "INPUT", attrs: { type: "password" } })), false);
  assert.equal(isEligibleTag(shapeTarget({ tagName: "INPUT", attrs: { type: "checkbox" } })), false);
  assert.equal(isEligibleTag(shapeTarget({ tagName: "DIV", attrs: { contenteditable: "true" } })), true);
  assert.equal(isEligibleTag(shapeTarget({ tagName: "DIV", attrs: { contenteditable: "plaintext-only" } })), true);
  assert.equal(isEligibleTag(shapeTarget({ tagName: "DIV", attrs: { contenteditable: "false" } })), false);
  assert.equal(isEligibleTag(shapeTarget({ tagName: "DIV" })), false);
});

test("descriptor: fieldKindFor produces input:text / textarea / contenteditable", () => {
  assert.equal(fieldKindFor(shapeTarget({ tagName: "TEXTAREA" })), "textarea");
  assert.equal(fieldKindFor(shapeTarget({ tagName: "INPUT", attrs: { type: "search" } })), "input:search");
  assert.equal(fieldKindFor(shapeTarget({ tagName: "INPUT" })), "input:text");
  assert.equal(fieldKindFor(shapeTarget({ tagName: "P", attrs: { contenteditable: "true" } })), "contenteditable");
});

test("descriptor: domSignature is deterministic and ignores text content", () => {
  const a = shapeTarget({ tagName: "TEXTAREA", siblings: ["LABEL", "INPUT"] });
  const b = shapeTarget({ tagName: "TEXTAREA", siblings: ["LABEL", "INPUT"] });
  assert.equal(domSignature(a), domSignature(b));
  const drift = shapeTarget({ tagName: "TEXTAREA", siblings: ["LABEL", "INPUT", "SPAN"] });
  assert.notEqual(domSignature(a), domSignature(drift));
  // Same structural shape but different attributes should keep the signature stable.
  const sameStruct = shapeTarget({ tagName: "TEXTAREA", siblings: ["LABEL", "INPUT"], attrs: { id: "alt", name: "other" } });
  assert.equal(domSignature(a), domSignature(sameStruct));
});

test("descriptor: indexAmongSimilar counts only same-tag siblings", () => {
  const target = shapeTarget({ tagName: "TEXTAREA", siblings: ["INPUT", "TEXTAREA", "LABEL"] });
  assert.equal(indexAmongSimilar(target), 1);
  const first = shapeTarget({ tagName: "TEXTAREA", siblings: ["INPUT", "LABEL"] });
  assert.equal(indexAmongSimilar(first), 0);
});

test("descriptor: extractDescriptor produces the producer-core shape", () => {
  const target = shapeTarget({
    tagName: "TEXTAREA",
    attrs: { name: "reply", id: "reply-box", "aria-label": "Reply" },
    siblings: ["LABEL"],
  });
  const descriptor = extractDescriptor(target);
  assert.equal(descriptor.tag_name, "TEXTAREA");
  assert.equal(descriptor.field_kind, "textarea");
  assert.equal(descriptor.name, "reply");
  assert.equal(descriptor.id, "reply-box");
  assert.equal(descriptor.aria_label, "Reply");
  assert.equal(typeof descriptor.dom_signature, "string");
  assert.match(descriptor.dom_signature, /^[0-9a-f]{8}$/);
  assert.equal(descriptor.index_among_similar, 0);
});

test("codepoint: count is surrogate-pair safe", () => {
  assert.equal(codepointCount("ab"), 2);
  assert.equal(codepointCount("a😀b"), 3); // emoji + 'a' + 'b'
  assert.equal(codepointOffsetOf("a😀b", 0), 0);
  assert.equal(codepointOffsetOf("a😀b", 1), 1);
  assert.equal(codepointOffsetOf("a😀b", 3), 2); // utf16 idx 3 = after emoji = codepoint 2
  assert.equal(codepointOffsetOf("a😀b", 4), 3);
});

test("codepoint: operationFor classifies insert/delete/replace", () => {
  assert.equal(operationFor({ ins_len: 1, del_len: 0 }), "insert");
  assert.equal(operationFor({ ins_len: 0, del_len: 2 }), "delete");
  assert.equal(operationFor({ ins_len: 3, del_len: 2 }), "replace");
});

test("codepoint: sourceFromInputType maps to format enum, unknown when ambiguous", () => {
  assert.equal(sourceFromInputType("insertText"), "typing");
  assert.equal(sourceFromInputType("insertLineBreak"), "typing");
  assert.equal(sourceFromInputType("insertParagraph"), "typing");
  assert.equal(sourceFromInputType("insertFromPaste"), "paste");
  assert.equal(sourceFromInputType("insertFromDrop"), "drop");
  assert.equal(sourceFromInputType("insertCompositionText"), "ime");
  assert.equal(sourceFromInputType("insertReplacementText"), "autocomplete");
  assert.equal(sourceFromInputType("deleteByCut"), "cut");
  assert.equal(sourceFromInputType("deleteContentBackward"), "typing");
  assert.equal(sourceFromInputType("formatBold"), "unknown");
  assert.equal(sourceFromInputType(null), "unknown");
});

test("codepoint: buildTextFieldMutation computes codepoint pos/del/ins from selection", () => {
  // Insert "x" at offset 2 of "abc": no selection, caret at index 2.
  let m = buildTextFieldMutation({
    text: "abc",
    selectionStartUtf16: 2,
    selectionEndUtf16: 2,
    insertedText: "x",
    inputType: "insertText",
  });
  assert.deepEqual(m, { op: "insert", pos: 2, del_len: 0, ins_len: 1, source: "typing" });
  // Replace selected "bc" with "yy".
  m = buildTextFieldMutation({
    text: "abc",
    selectionStartUtf16: 1,
    selectionEndUtf16: 3,
    insertedText: "yy",
    inputType: "insertText",
  });
  assert.deepEqual(m, { op: "replace", pos: 1, del_len: 2, ins_len: 2, source: "typing" });
  // Delete one char via backspace at end of "abc".
  m = buildTextFieldMutation({
    text: "abc",
    selectionStartUtf16: 2,
    selectionEndUtf16: 3,
    insertedText: "",
    inputType: "deleteContentBackward",
  });
  assert.deepEqual(m, { op: "delete", pos: 2, del_len: 1, ins_len: 0, source: "typing" });
});

test("codepoint: line break inputTypes count as one inserted codepoint", () => {
  assert.equal(insertedCodepointsForInput("insertParagraph", ""), 1);
  assert.equal(insertedCodepointsForInput("insertLineBreak", ""), 1);
  assert.equal(insertedCodepointsForInput("insertLineBreak", "\n\n"), 2);
  assert.equal(insertedCodepointsForInput("insertText", ""), 0);
  assert.equal(insertedCodepointsForInput("insertText", "🙂"), 1);

  for (const inputType of ["insertParagraph", "insertLineBreak"]) {
    const m = buildTextFieldMutation({
      text: "alpha",
      selectionStartUtf16: 2,
      selectionEndUtf16: 2,
      insertedText: "",
      inputType,
    });
    assert.deepEqual(m, { op: "insert", pos: 2, del_len: 0, ins_len: 1, source: "typing" });
  }
});

test("codepoint: buildTextFieldMutation handles surrogate-pair text without retaining the snapshot", () => {
  // Insert "a" after "🙂" in "🙂xyz". UTF-16 caret index 2 (after the emoji),
  // which is codepoint 1. The pre-change text is passed as a parameter and
  // dies with the call; tests do not (and the helper does not) cache it.
  const m = buildTextFieldMutation({
    text: "🙂xyz",
    selectionStartUtf16: 2,
    selectionEndUtf16: 2,
    insertedText: "a",
    inputType: "insertText",
  });
  assert.deepEqual(m, { op: "insert", pos: 1, del_len: 0, ins_len: 1, source: "typing" });
});

test("content-script ambiguous fallback emits null pos/del_len rather than retain text", async () => {
  const module = await import("../apps/browser-extension/src/content/capture.ts");
  const { ambiguousMutation } = module.__test;
  assert.deepEqual(ambiguousMutation("", null), {
    op: "delete",
    pos: null,
    del_len: null,
    ins_len: 0,
    source: "unknown",
  });
  assert.deepEqual(ambiguousMutation("formatting", "formatBold"), {
    op: "insert",
    pos: null,
    del_len: null,
    ins_len: 10,
    source: "unknown",
  });
  assert.deepEqual(ambiguousMutation("", "insertParagraph"), {
    op: "insert",
    pos: null,
    del_len: null,
    ins_len: 1,
    source: "typing",
  });
});

test("policy: fresh empty field is eligible; non-empty without resumable session is INELIGIBLE", () => {
  const baseOrigin = { origin: "https://a.test", path: "/post", tab_id: 1, frame_id: 0 };
  const baseDescriptor = {
    tag_name: "TEXTAREA",
    field_kind: "textarea",
    name: "reply",
    id: "reply",
    aria_label: null,
    nearest_form_id: null,
    dom_signature: "deadbeef",
    index_among_similar: 0,
  };
  assert.deepEqual(
    isFieldEligible({ origin: baseOrigin, descriptor: baseDescriptor, field_is_empty: true, existing_sessions: [] }),
    { eligible: true, reason: "fresh" },
  );
  assert.deepEqual(
    isFieldEligible({ origin: baseOrigin, descriptor: baseDescriptor, field_is_empty: false, existing_sessions: [] }),
    { eligible: false, reason: "non_empty_field_no_resumable_session" },
  );
  const resumable = {
    session_id: "s-1",
    origin: baseOrigin,
    descriptor: baseDescriptor,
    state: "active",
    events: [{ seq: 0, t: 0, op: "insert", pos: 0, del_len: 0, ins_len: 1, source: "typing" }],
  };
  assert.deepEqual(
    isFieldEligible({ origin: baseOrigin, descriptor: baseDescriptor, field_is_empty: false, existing_sessions: [resumable] }),
    { eligible: true, reason: "resumable" },
  );
});

test("policy: resumable session match is path+kind scoped, not cross-site", () => {
  const aOrigin = { origin: "https://a.test", path: "/x", tab_id: 1, frame_id: 0 };
  const bOrigin = { origin: "https://b.test", path: "/x", tab_id: 1, frame_id: 0 };
  const descriptor = {
    tag_name: "TEXTAREA",
    field_kind: "textarea",
    name: "reply",
    id: "r",
    aria_label: null,
    nearest_form_id: null,
    dom_signature: "abc123",
    index_among_similar: 0,
  };
  const sessionOnA = { session_id: "s-1", origin: aOrigin, descriptor, state: "active", events: [] };
  // Field on B with the same descriptor: must NOT resume the A session.
  assert.equal(findResumableSession(bOrigin, descriptor, [sessionOnA]), null);
  assert.equal(findResumableSession(aOrigin, descriptor, [sessionOnA])?.session_id, "s-1");
});

// --- Dispatcher integration -----------------------------------------------

function mutableClock(start = 0) {
  let t = start;
  return { now: () => t, advance(ms) { t += ms; return t; } };
}

function deterministicUuid(prefix = "00000000-0000-4000-8000-") {
  let counter = 0;
  return { uuid: () => `${prefix}${(counter += 1).toString(16).padStart(12, "0")}` };
}

function inMemoryStorage() {
  let snapshot = [];
  return {
    async read() { return snapshot.map((entry) => structuredClone(entry)); },
    async write(next) { snapshot = next.map((entry) => structuredClone(entry)); },
  };
}

function recordingUpload(response) {
  const calls = [];
  let next = response;
  return {
    async postRecord(payload) {
      calls.push(payload);
      if (next instanceof Error) throw next;
      return next ?? {
        record_hash: payload.manifest.record_hash,
        short_signature: "TestSig123",
        url: "https://example.test/TestSig123",
        created: true,
      };
    },
    calls,
    queueError(err) { next = err; },
  };
}

function recordingCheckpoint() {
  const calls = [];
  let counter = 0;
  return {
    async postCheckpoint(request) {
      calls.push(request);
      counter += 1;
      return {
        ok: true,
        response: {
          observed_session_id: request.observed_session_id,
          token: `tok-${counter}`,
          checkpoint_id: `cp-${counter}`,
          event_count: request.event_count,
          chain_tip: request.chain_tip,
          server_t: new Date(1_700_000_000_000 + counter).toISOString(),
          created: true,
        },
      };
    },
    calls,
  };
}

const PRODUCER = { id: "browser-extension", version: "0.1.0", capabilities: ["timing", "source_attribution"] };

function makeDispatcher() {
  const clock = mutableClock(1000);
  const uuid = deterministicUuid();
  const storage = inMemoryStorage();
  const upload = recordingUpload();
  const checkpoint = recordingCheckpoint();
  const dispatcher = new BackgroundDispatcher({
    clock, uuid, storage, upload, checkpoint, producer: PRODUCER,
  });
  return { dispatcher, clock, uuid, storage, upload, checkpoint };
}

const SAMPLE_DESCRIPTOR = {
  tag_name: "TEXTAREA",
  field_kind: "textarea",
  name: "reply",
  id: "reply",
  aria_label: null,
  nearest_form_id: null,
  dom_signature: "ext00001",
  index_among_similar: 0,
};

test("dispatcher: register → append → sign → upload → marks uploaded", async () => {
  const { dispatcher, upload, checkpoint } = makeDispatcher();
  const reg = await dispatcher.handle({
    kind: "register_field",
    tab_id: 1, frame_id: 0,
    origin_url: "https://a.test", page_path: "/post", page_title: "Reply",
    descriptor: SAMPLE_DESCRIPTOR, field_is_empty: true,
  });
  assert.equal(reg.kind, "register_field_result");
  assert.equal(reg.result.kind, "registered");
  const sid = reg.result.session_id;
  await dispatcher.handle({
    kind: "append_mutation",
    session_id: sid,
    mutation: { op: "insert", pos: 0, del_len: 0, ins_len: 3, source: "typing" },
  });
  await dispatcher.registry.awaitObservationIdle(sid);
  const signed = await dispatcher.handle({ kind: "sign_session", session_id: sid });
  assert.equal(signed.kind, "sign_session_result");
  assert.equal(signed.result.kind, "uploaded");
  assert.equal(upload.calls.length, 1);
  assert.equal(upload.calls[0].observation.observed_session_id.length > 0, true);
  assert.equal(checkpoint.calls.length >= 1, true);
  const live = dispatcher.registry.get(sid);
  assert.equal(live.state, "uploaded");
});

test("dispatcher: signed manifest passes packages/format.verifyRecord", async () => {
  const { dispatcher, upload } = makeDispatcher();
  const reg = await dispatcher.handle({
    kind: "register_field",
    tab_id: 1, frame_id: 0,
    origin_url: "https://a.test", page_path: "/post", page_title: "Reply",
    descriptor: SAMPLE_DESCRIPTOR, field_is_empty: true,
  });
  const sid = reg.result.session_id;
  for (let i = 0; i < 3; i++) {
    await dispatcher.handle({
      kind: "append_mutation", session_id: sid,
      mutation: { op: "insert", pos: i, del_len: 0, ins_len: 1, source: "typing" },
    });
  }
  await dispatcher.registry.awaitObservationIdle(sid);
  await dispatcher.handle({ kind: "sign_session", session_id: sid });
  const payload = upload.calls[0];
  const result = verifyRecord({ manifest: payload.manifest, events: payload.events });
  assert.equal(result.valid, true, result.errors?.join("; "));
});

test("dispatcher: line break event keeps extension record verifiable", async () => {
  const { dispatcher, upload } = makeDispatcher();
  const reg = await dispatcher.handle({
    kind: "register_field",
    tab_id: 1, frame_id: 0,
    origin_url: "https://a.test", page_path: "/post", page_title: "Reply",
    descriptor: SAMPLE_DESCRIPTOR, field_is_empty: true,
  });
  const sid = reg.result.session_id;
  for (const mutation of [
    { op: "insert", pos: 0, del_len: 0, ins_len: 1, source: "typing" },
    buildTextFieldMutation({ text: "a", selectionStartUtf16: 1, selectionEndUtf16: 1, insertedText: "", inputType: "insertParagraph" }),
    { op: "insert", pos: 2, del_len: 0, ins_len: 1, source: "typing" },
  ]) {
    await dispatcher.handle({ kind: "append_mutation", session_id: sid, mutation });
  }
  await dispatcher.registry.awaitObservationIdle(sid);
  await dispatcher.handle({ kind: "sign_session", session_id: sid });
  const payload = upload.calls[0];
  assert.deepEqual(payload.events.map(({ op, pos, del_len, ins_len }) => ({ op, pos, del_len, ins_len })), [
    { op: "insert", pos: 0, del_len: 0, ins_len: 1 },
    { op: "insert", pos: 1, del_len: 0, ins_len: 1 },
    { op: "insert", pos: 2, del_len: 0, ins_len: 1 },
  ]);
  const result = verifyRecord({ manifest: payload.manifest, events: payload.events });
  assert.equal(result.valid, true, result.errors?.join("; "));
});

test("dispatcher: non-empty field with no resumable session reports ineligible", async () => {
  const { dispatcher } = makeDispatcher();
  const reg = await dispatcher.handle({
    kind: "register_field",
    tab_id: 1, frame_id: 0,
    origin_url: "https://a.test", page_path: "/post", page_title: "Reply",
    descriptor: SAMPLE_DESCRIPTOR, field_is_empty: false,
  });
  assert.equal(reg.kind, "register_field_result");
  assert.equal(reg.result.kind, "ineligible");
  assert.equal(reg.result.reason, "non_empty_field_no_resumable_session");
  assert.equal(dispatcher.registry.list().length, 0);
});

test("dispatcher: parallel fields across sites stay independent", async () => {
  const { dispatcher } = makeDispatcher();
  const fields = [
    { origin: "https://a.test", path: "/post", id: "a1" },
    { origin: "https://a.test", path: "/post", id: "a2" },
    { origin: "https://b.test", path: "/forum", id: "b1" },
  ];
  const ids = [];
  for (const [i, f] of fields.entries()) {
    const reg = await dispatcher.handle({
      kind: "register_field",
      tab_id: 1, frame_id: 0,
      origin_url: f.origin, page_path: f.path, page_title: `field ${i}`,
      descriptor: { ...SAMPLE_DESCRIPTOR, id: f.id, dom_signature: `sig-${i}` },
      field_is_empty: true,
    });
    ids.push(reg.result.session_id);
  }
  assert.equal(new Set(ids).size, 3);
  for (const sid of ids) {
    await dispatcher.handle({
      kind: "append_mutation", session_id: sid,
      mutation: { op: "insert", pos: 0, del_len: 0, ins_len: 1, source: "typing" },
    });
  }
  await Promise.all(ids.map((sid) => dispatcher.registry.awaitObservationIdle(sid)));
  await dispatcher.handle({ kind: "sign_session", session_id: ids[0] });
  const live = ids.map((sid) => dispatcher.registry.get(sid));
  assert.equal(live[0].state, "uploaded");
  assert.equal(live[1].state, "active");
  assert.equal(live[2].state, "active");
});

test("dispatcher: discard removes the targeted session only", async () => {
  const { dispatcher } = makeDispatcher();
  const r1 = await dispatcher.handle({
    kind: "register_field",
    tab_id: 1, frame_id: 0,
    origin_url: "https://a.test", page_path: "/post", page_title: "x",
    descriptor: { ...SAMPLE_DESCRIPTOR, id: "one", dom_signature: "one" }, field_is_empty: true,
  });
  const r2 = await dispatcher.handle({
    kind: "register_field",
    tab_id: 1, frame_id: 0,
    origin_url: "https://a.test", page_path: "/post", page_title: "y",
    descriptor: { ...SAMPLE_DESCRIPTOR, id: "two", dom_signature: "two" }, field_is_empty: true,
  });
  await dispatcher.handle({ kind: "discard_session", session_id: r1.result.session_id });
  assert.equal(dispatcher.registry.get(r1.result.session_id), undefined);
  assert.ok(dispatcher.registry.get(r2.result.session_id));
});

test("dispatcher: failed_upload retry surfaces the discard-and-resign requirement honestly", async () => {
  const { dispatcher, upload } = makeDispatcher();
  upload.queueError(new Error("ingest_failed status=500 reason=down"));
  const reg = await dispatcher.handle({
    kind: "register_field",
    tab_id: 1, frame_id: 0,
    origin_url: "https://a.test", page_path: "/post", page_title: "x",
    descriptor: SAMPLE_DESCRIPTOR, field_is_empty: true,
  });
  const sid = reg.result.session_id;
  await dispatcher.handle({
    kind: "append_mutation", session_id: sid,
    mutation: { op: "insert", pos: 0, del_len: 0, ins_len: 1, source: "typing" },
  });
  await dispatcher.registry.awaitObservationIdle(sid);
  const signResp = await dispatcher.handle({ kind: "sign_session", session_id: sid });
  assert.equal(signResp.result.kind, "failed");
  assert.equal(dispatcher.registry.get(sid).state, "failed_upload");
  const retry = await dispatcher.handle({ kind: "retry_failed_upload", session_id: sid });
  assert.equal(retry.result.kind, "failed");
  assert.equal(retry.result.reason, "retry_requires_discard_and_resign");
});
