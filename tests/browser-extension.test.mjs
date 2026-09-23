import assert from "node:assert/strict";
import test from "node:test";

import { createTextBinding, verifyRecord, verifyTextBindingCandidate } from "../packages/format/src/index.ts";
import {
  buildTextFieldMutation,
  codepointCount,
  codepointOffsetOf,
  collapsedDeletionMutation,
  compositionMutation,
  contentEditableInsertedCodepoints,
  insertedCodepointsForInput,
  measuredReplacementMutation,
  netLengthChangeMutation,
  operationFor,
  sourceFromInputType,
} from "../apps/browser-extension/src/lib/codepoint.ts";
import { readFile } from "node:fs/promises";
import {
  domSignature,
  extractDescriptor,
  fieldKindFor,
  indexAmongSimilar,
  isEligibleTag,
} from "../apps/browser-extension/src/lib/descriptor.ts";
import { findResumableSession, isFieldEligible } from "../apps/browser-extension/src/lib/policy.ts";
import { BackgroundDispatcher } from "../apps/browser-extension/src/lib/dispatcher.ts";
import { createFetchUploadAdapter } from "../apps/browser-extension/src/lib/adapters.ts";
import { IngestUploadError } from "../packages/producer-core/src/index.ts";

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

test("content-script binding uses selected text or all field content", async () => {
  const module = await import("../apps/browser-extension/src/content/capture.ts");
  const { bindingTextForElement } = module.__test;
  const field = {
    tagName: "TEXTAREA",
    value: "quoted header\nSigned body\nfooter",
    selectionStart: 14,
    selectionEnd: 25,
  };
  assert.equal(bindingTextForElement(field), "Signed body");
  field.selectionStart = 0;
  field.selectionEnd = 0;
  assert.equal(bindingTextForElement(field), "quoted header\nSigned body\nfooter");
});

test("content-script binding uses contenteditable selection when it stays inside the editor", async () => {
  const module = await import("../apps/browser-extension/src/content/capture.ts");
  const { bindingTextForElement } = module.__test;
  const previousWindow = globalThis.window;
  const previousNode = globalThis.Node;
  const editor = {
    tagName: "DIV",
    isContentEditable: true,
    textContent: "quoted header Signed body footer",
    contains(node) { return node === editor || node?.parentElement === editor; },
  };
  const anchorNode = { nodeType: 3, parentElement: editor };
  const focusNode = { nodeType: 3, parentElement: editor };
  try {
    globalThis.Node = { ELEMENT_NODE: 1 };
    globalThis.window = {
      getSelection: () => ({
        isCollapsed: false,
        rangeCount: 1,
        anchorNode,
        focusNode,
        toString: () => "Signed body",
      }),
    };
    assert.equal(bindingTextForElement(editor), "Signed body");
    globalThis.window = { getSelection: () => ({ isCollapsed: true, rangeCount: 1 }) };
    assert.equal(bindingTextForElement(editor), "quoted header Signed body footer");
  } finally {
    globalThis.window = previousWindow;
    globalThis.Node = previousNode;
  }
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
  let oneShot = null;
  return {
    async postRecord(payload) {
      calls.push(payload);
      if (oneShot) {
        const error = oneShot;
        oneShot = null;
        throw error;
      }
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
    // Throws on the next call only; later calls fall back to the default response.
    failNext(err) { oneShot = err; },
  };
}

function recordingCheckpoint() {
  const calls = [];
  const programmed = [];
  let counter = 0;
  return {
    async postCheckpoint(request) {
      calls.push(request);
      counter += 1;
      const next = programmed.shift();
      if (next) return next;
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
    // Responses returned, in order, in place of the default success; `undefined` keeps the default.
    queue(...responses) { programmed.push(...responses); },
    calls,
  };
}

const PRODUCER = { id: "browser-extension", version: "0.1.0", capabilities: ["timing", "source_attribution"] };

function makeDispatcher({ checkpoint = recordingCheckpoint() } = {}) {
  const clock = mutableClock(1000);
  const uuid = deterministicUuid();
  const storage = inMemoryStorage();
  const upload = recordingUpload();
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

test("dispatcher: a session the server never committed uploads as unobserved without a sign-time checkpoint", async () => {
  const checkpoint = recordingCheckpoint();
  checkpoint.queue({ ok: false, kind: "transient", status: 503, reason: "upstream unavailable" });
  const { dispatcher, upload } = makeDispatcher({ checkpoint });
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
  assert.equal(checkpoint.calls.length, 1);
  const signed = await dispatcher.handle({ kind: "sign_session", session_id: sid });
  assert.equal(signed.result.kind, "uploaded");
  assert.equal(signed.result.observation_note, undefined);
  assert.equal(checkpoint.calls.length, 1, "signing must not create a first commitment");
  assert.deepEqual(upload.calls[0].observation, { state: "unobserved" });
});

test("dispatcher: a diverged session uploads as unobserved and the result says so", async () => {
  const checkpoint = recordingCheckpoint();
  checkpoint.queue(undefined, { ok: false, kind: "conflict", status: 409, reason: "chain mismatch" });
  const { dispatcher, upload } = makeDispatcher({ checkpoint });
  const reg = await dispatcher.handle({
    kind: "register_field",
    tab_id: 1, frame_id: 0,
    origin_url: "https://a.test", page_path: "/post", page_title: "Reply",
    descriptor: SAMPLE_DESCRIPTOR, field_is_empty: true,
  });
  const sid = reg.result.session_id;
  for (let i = 0; i < 51; i++) {
    await dispatcher.handle({
      kind: "append_mutation", session_id: sid,
      mutation: { op: "insert", pos: i, del_len: 0, ins_len: 1, source: "typing" },
    });
  }
  await dispatcher.registry.awaitObservationIdle(sid);
  assert.equal(dispatcher.registry.get(sid).observation.state, "diverged");
  const signed = await dispatcher.handle({ kind: "sign_session", session_id: sid });
  assert.equal(signed.result.kind, "uploaded", signed.result.reason);
  assert.equal(typeof signed.result.observation_note, "string");
  assert.ok(signed.result.observation_note.length > 0);
  assert.deepEqual(upload.calls[0].observation, { state: "unobserved" });
  assert.equal(dispatcher.registry.get(sid).state, "uploaded");
});

test("createFetchUploadAdapter surfaces the ingest error code on a rejected upload", async () => {
  const rejected = createFetchUploadAdapter({
    records_endpoint: "https://ingest.test/api/records",
    fetch: async () => ({
      ok: false,
      status: 409,
      text: async () => JSON.stringify({ error: "observation_mismatch", details: ["checkpoint cp-1 does not match final record prefix"] }),
      json: async () => ({}),
    }),
  });
  await assert.rejects(rejected.postRecord({ manifest: {}, events: [] }), (error) => {
    assert.ok(error instanceof IngestUploadError);
    assert.equal(error.status, 409);
    assert.equal(error.code, "observation_mismatch");
    assert.match(error.message, /ingest_failed status=409/);
    return true;
  });
  const opaque = createFetchUploadAdapter({
    records_endpoint: "https://ingest.test/api/records",
    fetch: async () => ({ ok: false, status: 502, text: async () => "bad gateway", json: async () => ({}) }),
  });
  await assert.rejects(opaque.postRecord({ manifest: {}, events: [] }), (error) => {
    assert.ok(error instanceof IngestUploadError);
    assert.equal(error.status, 502);
    assert.equal(error.code, null);
    return true;
  });
});

async function registerAndType(dispatcher, count) {
  const reg = await dispatcher.handle({
    kind: "register_field",
    tab_id: 1, frame_id: 0,
    origin_url: "https://a.test", page_path: "/post", page_title: "Reply",
    descriptor: SAMPLE_DESCRIPTOR, field_is_empty: true,
  });
  const sid = reg.result.session_id;
  for (let i = 0; i < count; i++) {
    await dispatcher.handle({
      kind: "append_mutation", session_id: sid,
      mutation: { op: "insert", pos: i, del_len: 0, ins_len: 1, source: "typing" },
    });
  }
  await dispatcher.registry.awaitObservationIdle(sid);
  return sid;
}

test("dispatcher: an upload rejected with observation_mismatch retries as unobserved and says so", async () => {
  const { dispatcher, upload, checkpoint } = makeDispatcher();
  const sid = await registerAndType(dispatcher, 3);
  upload.failNext(new IngestUploadError(409, "observation_mismatch", "ingest_failed status=409 reason=observation_mismatch"));
  const signed = await dispatcher.handle({ kind: "sign_session", session_id: sid });
  assert.equal(signed.result.kind, "failed");
  assert.ok(upload.calls[0].observation.token, "the first attempt bound the commitment");
  assert.equal(dispatcher.registry.get(sid).observation.state, "diverged");
  const checkpointCalls = checkpoint.calls.length;
  const retried = await dispatcher.handle({ kind: "retry_failed_upload", session_id: sid });
  assert.equal(retried.kind, "retry_result");
  assert.equal(retried.result.kind, "uploaded", retried.result.reason);
  assert.equal(typeof retried.result.observation_note, "string");
  assert.equal(upload.calls.length, 2);
  assert.deepEqual(upload.calls[1].observation, { state: "unobserved" });
  assert.equal(checkpoint.calls.length, checkpointCalls, "a diverged session is not checkpointed again");
  assert.equal(dispatcher.registry.get(sid).state, "uploaded");
});

test("dispatcher: an upload rejected with observation_unavailable retries as unobserved", async () => {
  const { dispatcher, upload, checkpoint } = makeDispatcher();
  const sid = await registerAndType(dispatcher, 3);
  upload.failNext(new IngestUploadError(404, "observation_unavailable", "ingest_failed status=404 reason=observation_unavailable"));
  const signed = await dispatcher.handle({ kind: "sign_session", session_id: sid });
  assert.equal(signed.result.kind, "failed");
  const obs = dispatcher.registry.get(sid).observation;
  assert.equal(obs.state, "unknown");
  assert.equal(obs.last_observed_token, null);
  const checkpointCalls = checkpoint.calls.length;
  const retried = await dispatcher.handle({ kind: "retry_failed_upload", session_id: sid });
  assert.equal(retried.result.kind, "uploaded", retried.result.reason);
  assert.equal(retried.result.observation_note, undefined);
  assert.deepEqual(upload.calls[1].observation, { state: "unobserved" });
  assert.equal(checkpoint.calls.length, checkpointCalls, "no commitment is minted at retry for a reset session");
  assert.equal(dispatcher.registry.get(sid).state, "uploaded");
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

test("dispatcher: sign with a content-blind text binding seals it and stays verifiable", async () => {
  const { dispatcher, upload } = makeDispatcher();
  const reg = await dispatcher.handle({
    kind: "register_field",
    tab_id: 1, frame_id: 0,
    origin_url: "https://a.test", page_path: "/post", page_title: "Reply",
    descriptor: SAMPLE_DESCRIPTOR, field_is_empty: true,
  });
  const sid = reg.result.session_id;
  await dispatcher.handle({
    kind: "append_mutation", session_id: sid,
    mutation: { op: "insert", pos: 0, del_len: 0, ins_len: 11, source: "typing" },
  });
  await dispatcher.registry.awaitObservationIdle(sid);

  // The popup computes the binding in the content script and passes only the
  // commitment object into sign_session — never the text.
  const documentText = "Hello there, this is the field I actually wrote.";
  const textBinding = createTextBinding(documentText, sid);
  await dispatcher.handle({ kind: "sign_session", session_id: sid, text_binding: textBinding });

  const payload = upload.calls[0];
  assert.equal(payload.manifest.format_version, "0.2");
  assert.deepEqual(payload.manifest.text_binding, textBinding);
  // record_hash is sealed over the binding — the chain still verifies.
  assert.equal(verifyRecord({ manifest: payload.manifest, events: payload.events }).valid, true);
  // The bound text (and an appended line) verifies against the sealed commitment.
  const check = verifyTextBindingCandidate(payload.manifest.text_binding, `${documentText}\n-- sig`, sid);
  assert.equal(check.valid, true);
  // The uploaded payload carries no plaintext, only the commitment.
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes("Hello there"), false);
  assert.equal(serialized.includes("field I actually wrote"), false);
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

test("dispatcher: a retry that fails again stays in failed_upload with the new reason", async () => {
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
  upload.queueError(new Error("ingest_failed status=503 reason=still down"));
  const retry = await dispatcher.handle({ kind: "retry_failed_upload", session_id: sid });
  assert.equal(retry.result.kind, "failed");
  assert.match(retry.result.reason, /still down/);
  assert.equal(dispatcher.registry.get(sid).state, "failed_upload");
  assert.equal(dispatcher.registry.get(sid).last_failure_reason, retry.result.reason);
});


test("codepoint: collapsed deletions are measured from the field length before and after the edit", () => {
  assert.deepEqual(
    collapsedDeletionMutation({ lengthBefore: 5, lengthAfter: 4, caretAfterCodepoints: 4, source: "typing" }),
    { op: "delete", pos: 4, del_len: 1, ins_len: 0, source: "typing" },
  );
  assert.deepEqual(
    collapsedDeletionMutation({ lengthBefore: 12, lengthAfter: 7, caretAfterCodepoints: 3, source: "typing" }),
    { op: "delete", pos: 3, del_len: 5, ins_len: 0, source: "typing" },
  );
  // Backspace at the start of the field changes nothing and records nothing.
  assert.equal(collapsedDeletionMutation({ lengthBefore: 5, lengthAfter: 5, caretAfterCodepoints: 0, source: "typing" }), null);
});

test("codepoint: a spellcheck replacement is sized from the inserted text and the length difference", () => {
  // "teh" (3) replaced by "the" (3): lengths equal, caret lands after the word.
  assert.deepEqual(
    measuredReplacementMutation({ lengthBefore: 10, lengthAfter: 10, insLen: 3, caretAfterCodepoints: 7, source: "autocomplete" }),
    { op: "replace", pos: 4, del_len: 3, ins_len: 3, source: "autocomplete" },
  );
  assert.deepEqual(
    measuredReplacementMutation({ lengthBefore: 10, lengthAfter: 12, insLen: 5, caretAfterCodepoints: 9, source: "autocomplete" }),
    { op: "replace", pos: 4, del_len: 3, ins_len: 5, source: "autocomplete" },
  );
});

test("codepoint: undo/redo and formatting record the net length change with unknown position", () => {
  assert.deepEqual(netLengthChangeMutation({ lengthBefore: 10, lengthAfter: 13 }), { op: "insert", pos: null, del_len: 0, ins_len: 3, source: "unknown" });
  assert.deepEqual(netLengthChangeMutation({ lengthBefore: 10, lengthAfter: 7 }), { op: "delete", pos: null, del_len: 3, ins_len: 0, source: "unknown" });
  assert.equal(netLengthChangeMutation({ lengthBefore: 10, lengthAfter: 10 }), null);
});

test("codepoint: an IME composition is one ime event sized by the committed text", () => {
  assert.deepEqual(compositionMutation({ pos: 2, del_len: 0, committedText: "日本語" }), { op: "insert", pos: 2, del_len: 0, ins_len: 3, source: "ime" });
  assert.deepEqual(compositionMutation({ pos: 2, del_len: 1, committedText: "語" }), { op: "replace", pos: 2, del_len: 1, ins_len: 1, source: "ime" });
  assert.deepEqual(compositionMutation({ pos: null, del_len: null, committedText: "語" }), { op: "insert", pos: null, del_len: null, ins_len: 1, source: "ime" });
  assert.equal(compositionMutation({ pos: 2, del_len: 0, committedText: "" }), null);
});

test("codepoint: dragging text out of a field is a drag-and-drop source, never typing", () => {
  assert.equal(sourceFromInputType("deleteByDrag"), "drop");
});

test("codepoint: contenteditable insert sizes fall back to the transferred text and otherwise stay unknown", () => {
  assert.equal(contentEditableInsertedCodepoints("insertFromPaste", null, "hello 🎉"), 7);
  assert.equal(contentEditableInsertedCodepoints("insertText", "x", null), 1);
  assert.equal(contentEditableInsertedCodepoints("insertParagraph", null, null), 1);
  assert.equal(contentEditableInsertedCodepoints("insertFromPaste", null, null), null);
});

test("content script handles compositions, dedupes listeners, and finishes collapsed deletes on input", async () => {
  const source = await readFile("apps/browser-extension/src/content/capture.ts", "utf8");
  assert.match(source, /addEventListener\("compositionstart"/);
  assert.match(source, /addEventListener\("compositionend"/);
  assert.match(source, /addEventListener\("input"/);
  assert.match(source, /listening\.has\(element\)/);
  assert.match(source, /collapsedDeletionMutation/);
  assert.match(source, /netLengthChangeMutation/);
  // The browser activation tests cover terminal finish/stop. Automatic
  // continuation remains a kernel capability, not an extension capture path.
});

test("dispatcher: editing after upload starts a continuation session linked to the signed record", async () => {
  const { dispatcher, upload } = makeDispatcher();
  const reg = await dispatcher.handle({
    kind: "register_field",
    tab_id: 1, frame_id: 0,
    origin_url: "https://a.test", page_path: "/post", page_title: "Reply",
    descriptor: SAMPLE_DESCRIPTOR, field_is_empty: true,
  });
  const sid = reg.result.session_id;
  await dispatcher.handle({ kind: "append_mutation", session_id: sid, mutation: { op: "insert", pos: 0, del_len: 0, ins_len: 3, source: "typing" } });
  await dispatcher.registry.awaitObservationIdle(sid);
  await dispatcher.handle({ kind: "sign_session", session_id: sid });
  assert.equal(dispatcher.registry.get(sid).state, "uploaded");

  const uploadedHash = dispatcher.registry.get(sid).uploaded_response.record_hash;
  const append = await dispatcher.handle({ kind: "append_mutation", session_id: sid, mutation: { op: "insert", pos: 3, del_len: 0, ins_len: 1, source: "typing" } });
  assert.equal(append.kind, "append_mutation_result");
  assert.ok(append.session_id && append.session_id !== sid, "the content script is told which session now records the field");
  const signed = dispatcher.registry.get(sid);
  assert.equal(signed.state, "uploaded", "the signed session stays frozen with its link");
  assert.equal(signed.events.length, 1);
  const continuation = dispatcher.registry.get(append.session_id);
  assert.equal(continuation.state, "active");
  assert.equal(continuation.events.length, 1, "the continuation holds only the new edit");
  assert.equal(continuation.parent_record, uploadedHash);
  assert.deepEqual(continuation.capture_context, signed.capture_context);

  await dispatcher.registry.awaitObservationIdle(append.session_id);
  const second = await dispatcher.handle({ kind: "sign_session", session_id: append.session_id });
  assert.equal(second.result.kind, "uploaded");
  const manifest = upload.calls.at(-1).manifest;
  assert.equal(manifest.parent_record, uploadedHash);
  assert.equal(verifyRecord({ manifest, events: upload.calls.at(-1).events }).valid, true);
});

test("dispatcher: a non-empty field whose session was uploaded registers a continuation of it", async () => {
  const { dispatcher } = makeDispatcher();
  const reg = await dispatcher.handle({
    kind: "register_field",
    tab_id: 1, frame_id: 0,
    origin_url: "https://a.test", page_path: "/post", page_title: "Reply",
    descriptor: SAMPLE_DESCRIPTOR, field_is_empty: true,
  });
  const sid = reg.result.session_id;
  await dispatcher.handle({ kind: "append_mutation", session_id: sid, mutation: { op: "insert", pos: 0, del_len: 0, ins_len: 3, source: "typing" } });
  await dispatcher.registry.awaitObservationIdle(sid);
  await dispatcher.handle({ kind: "sign_session", session_id: sid });

  const again = await dispatcher.handle({
    kind: "register_field",
    tab_id: 7, frame_id: 0,
    origin_url: "https://a.test", page_path: "/post", page_title: "Reply",
    descriptor: SAMPLE_DESCRIPTOR, field_is_empty: false,
  });
  assert.equal(again.result.kind, "registered");
  assert.notEqual(again.result.session_id, sid);
  assert.equal(dispatcher.registry.get(sid).state, "uploaded");
  const continuation = dispatcher.registry.get(again.result.session_id);
  assert.equal(continuation.state, "active");
  assert.equal(continuation.parent_record, dispatcher.registry.get(sid).uploaded_response.record_hash);
  assert.equal(continuation.origin.tab_id, 7, "the continuation records the tab the field now lives in");
  assert.equal(continuation.identity_certainty, "resumed");
});

test("dispatcher: expired sessions are swept when the worker initialises and when a field registers", async () => {
  const clock = mutableClock(10 * 24 * 60 * 60 * 1000);
  const storage = inMemoryStorage();
  const stale = {
    session_id: "00000000-0000-4000-8000-00000000aaaa",
    format_version: "0.2",
    base_wall_ms: 0,
    last_edit_wall_ms: 0,
    origin: { origin: "https://old.test", path: "/", tab_id: 1, frame_id: 0 },
    descriptor: SAMPLE_DESCRIPTOR,
    identity_certainty: "fresh",
    producer: PRODUCER,
    capture_context: { surface: "browser" },
    events: [],
    last_event_chain_tip: null,
    state: "active",
    observation: { state: "disabled", commitments: [], observed_session_id: null, last_observed_token: null, last_committed_event_count: 0, last_attempt_at_wall_ms: null, last_failure: null, in_flight: false, queued: false, next_backoff_ms: 0 },
  };
  await storage.write([stale]);
  const dispatcher = new BackgroundDispatcher({ clock, uuid: deterministicUuid(), storage, upload: recordingUpload(), checkpoint: recordingCheckpoint(), producer: PRODUCER });
  await dispatcher.ensureInitialised();
  assert.equal(dispatcher.registry.list().length, 0);
  assert.equal((await storage.read()).length, 0, "the sweep is persisted");
});

test("dispatcher: retrying a failed upload re-signs the same session and keeps its binding", async () => {
  const { dispatcher, upload } = makeDispatcher();
  upload.queueError(new Error("ingest_failed status=500 reason=down"));
  const reg = await dispatcher.handle({
    kind: "register_field",
    tab_id: 1, frame_id: 0,
    origin_url: "https://a.test", page_path: "/post", page_title: "x",
    descriptor: SAMPLE_DESCRIPTOR, field_is_empty: true,
  });
  const sid = reg.result.session_id;
  await dispatcher.handle({ kind: "append_mutation", session_id: sid, mutation: { op: "insert", pos: 0, del_len: 0, ins_len: 5, source: "typing" } });
  await dispatcher.registry.awaitObservationIdle(sid);
  const binding = createTextBinding("hello", sid);
  const signResp = await dispatcher.handle({ kind: "sign_session", session_id: sid, text_binding: binding });
  assert.equal(signResp.result.kind, "failed");
  assert.equal(dispatcher.registry.get(sid).state, "failed_upload");

  upload.queueError(undefined);
  const retry = await dispatcher.handle({ kind: "retry_failed_upload", session_id: sid });
  assert.equal(retry.result.kind, "uploaded");
  assert.equal(dispatcher.registry.get(sid).state, "uploaded");
  assert.deepEqual(upload.calls.at(-1).manifest.text_binding, binding);
  assert.equal(verifyRecord({ manifest: upload.calls.at(-1).manifest, events: upload.calls.at(-1).events }).valid, true);
});

test("dispatcher: capture-context redactions chosen at sign time are applied to the uploaded manifest", async () => {
  const { dispatcher, upload } = makeDispatcher();
  const reg = await dispatcher.handle({
    kind: "register_field",
    tab_id: 1, frame_id: 0,
    origin_url: "https://a.test", page_path: "/post?draft=1", page_title: "My secret draft title",
    descriptor: SAMPLE_DESCRIPTOR, field_is_empty: true,
  });
  const sid = reg.result.session_id;
  await dispatcher.handle({ kind: "append_mutation", session_id: sid, mutation: { op: "insert", pos: 0, del_len: 0, ins_len: 5, source: "typing" } });
  await dispatcher.registry.awaitObservationIdle(sid);
  await dispatcher.handle({
    kind: "sign_session",
    session_id: sid,
    capture_context_redactions: { drop_title: true, replace_label: "forum reply" },
  });
  const context = upload.calls[0].manifest.capture_context;
  assert.equal(context.label, "forum reply");
  assert.equal(context.browser.title, undefined);
  assert.equal(context.browser.url, "https://a.test/post");
  assert.equal(JSON.stringify(upload.calls[0]).includes("secret draft"), false);
});


test("dispatcher: rapid edits to a frozen session share one continuation", async () => {
  const { dispatcher } = makeDispatcher();
  const reg = await dispatcher.handle({
    kind: "register_field",
    tab_id: 1, frame_id: 0,
    origin_url: "https://a.test", page_path: "/post", page_title: "Reply",
    descriptor: SAMPLE_DESCRIPTOR, field_is_empty: true,
  });
  const sid = reg.result.session_id;
  await dispatcher.handle({ kind: "append_mutation", session_id: sid, mutation: { op: "insert", pos: 0, del_len: 0, ins_len: 3, source: "typing" } });
  await dispatcher.registry.awaitObservationIdle(sid);
  await dispatcher.handle({ kind: "sign_session", session_id: sid });

  // The content script fires appends without awaiting, so two keystrokes can
  // both carry the frozen session id.
  const [first, second] = await Promise.all([
    dispatcher.handle({ kind: "append_mutation", session_id: sid, mutation: { op: "insert", pos: 3, del_len: 0, ins_len: 1, source: "typing" } }),
    dispatcher.handle({ kind: "append_mutation", session_id: sid, mutation: { op: "insert", pos: 4, del_len: 0, ins_len: 1, source: "typing" } }),
  ]);
  assert.equal(first.session_id, second.session_id);
  const continuation = dispatcher.registry.get(first.session_id);
  assert.equal(continuation.events.length, 2);
  assert.equal(dispatcher.registry.list().filter((session) => session.state === "active").length, 1);
});

test("dispatcher: registering a field with an active continuation resumes it instead of starting another", async () => {
  const { dispatcher } = makeDispatcher();
  const reg = await dispatcher.handle({
    kind: "register_field",
    tab_id: 1, frame_id: 0,
    origin_url: "https://a.test", page_path: "/post", page_title: "Reply",
    descriptor: SAMPLE_DESCRIPTOR, field_is_empty: true,
  });
  const sid = reg.result.session_id;
  await dispatcher.handle({ kind: "append_mutation", session_id: sid, mutation: { op: "insert", pos: 0, del_len: 0, ins_len: 3, source: "typing" } });
  await dispatcher.registry.awaitObservationIdle(sid);
  await dispatcher.handle({ kind: "sign_session", session_id: sid });
  const continued = await dispatcher.handle({ kind: "append_mutation", session_id: sid, mutation: { op: "insert", pos: 3, del_len: 0, ins_len: 1, source: "typing" } });

  // Page re-mounts the field while the uploaded session is still within its grace period.
  const again = await dispatcher.handle({
    kind: "register_field",
    tab_id: 1, frame_id: 0,
    origin_url: "https://a.test", page_path: "/post", page_title: "Reply",
    descriptor: SAMPLE_DESCRIPTOR, field_is_empty: false,
  });
  assert.equal(again.result.session_id, continued.session_id);
  assert.equal(dispatcher.registry.list().filter((session) => session.state === "active").length, 1);
});

test("dispatcher: uploaded continuation survives grace sweep and worker restart", async () => {
  const { dispatcher, storage, clock, uuid, upload, checkpoint } = makeDispatcher();
  const registration = { kind: "register_field", tab_id: 1, frame_id: 0, origin_url: "https://a.test", page_path: "/post", page_title: "Reply", descriptor: SAMPLE_DESCRIPTOR, field_is_empty: true };
  const first = await dispatcher.handle(registration);
  const sid = first.result.session_id;
  await dispatcher.handle({ kind: "append_mutation", session_id: sid, mutation: { op: "insert", pos: 0, del_len: 0, ins_len: 3, source: "typing" } });
  await dispatcher.registry.awaitObservationIdle(sid);
  const binding = createTextBinding("abc", sid);
  const signed = await dispatcher.handle({ kind: "sign_session", session_id: sid, text_binding: binding });
  const parent = signed.result.response.record_hash;
  clock.advance(61_000);
  await dispatcher.sweepExpired();
  assert.deepEqual(dispatcher.registry.get(sid).events, []);
  assert.equal(dispatcher.registry.get(sid).observation.last_observed_token, null);
  const saved = (await dispatcher.handle({ kind: "list_sessions" })).sessions;
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].signed_text_binding, binding);
  assert.equal(saved[0].uploaded_response.url, signed.result.response.url);
  assert.equal(saved[0].continuation_anchor, true);
  const restarted = new BackgroundDispatcher({ storage, clock, uuid, upload, checkpoint, producer: PRODUCER });
  const afterRestart = await restarted.handle({ kind: "list_sessions" });
  assert.equal(afterRestart.sessions[0].uploaded_response.url, signed.result.response.url);
  assert.deepEqual(afterRestart.sessions[0].signed_text_binding, binding);
  assert.deepEqual(afterRestart.sessions[0].events, []);
  const resumed = await restarted.handle({ ...registration, tab_id: 2, field_is_empty: false });
  assert.equal(resumed.result.kind, "registered");
  assert.notEqual(resumed.result.session_id, sid);
  assert.equal(restarted.registry.get(resumed.result.session_id).parent_record, parent);
  const otherTab = await restarted.handle({ ...registration, tab_id: 3, field_is_empty: false });
  assert.equal(otherTab.result.session_id, resumed.result.session_id, "same document across tabs continues sharing its session");
  clock.advance(3 * 24 * 60 * 60 * 1000 + 1);
  await restarted.sweepExpired();
  assert.equal(restarted.registry.get(sid), undefined);
});
