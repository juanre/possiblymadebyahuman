import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  b3HashText,
  canonicalizeJson,
  canonicalizeTextForBinding,
  codepointLength,
  computeEventHashChain,
  computeObservedLength,
  computeRecordHash,
  createTextBinding,
  validateEvent,
  validateManifest,
  verifyRecord,
  verifyTextBindingCandidate,
} from "../packages/format/src/index.ts";
import { runConformanceVectors } from "../packages/conformance/src/index.ts";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

test("BLAKE3 b3: hashes use the shared prefix convention", () => {
  assert.equal(
    b3HashText("abc"),
    "b3:6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85",
  );
});

test("canonical JSON sorts object keys recursively and emits no whitespace", () => {
  assert.equal(canonicalizeJson({ z: 1, a: { b: 2, a: 1 }, m: [3, { y: 2, x: 1 }] }), "{\"a\":{\"a\":1,\"b\":2},\"m\":[3,{\"x\":1,\"y\":2}],\"z\":1}");
});

test("conformance vectors pass", async () => {
  const vectors = {
    canonicalization: await readJson("packages/conformance/vectors/canonicalization.json"),
    hashChains: await readJson("packages/conformance/vectors/hash-chain.json"),
    processLengths: await readJson("packages/conformance/vectors/process-length.json"),
    goldenRecords: await readJson("packages/conformance/vectors/golden-records.json"),
    capabilityAccuracy: await readJson("packages/conformance/vectors/capability-accuracy.json"),
    textCanonicalization: await readJson("packages/conformance/vectors/text-canonicalization.json"),
    textBindings: await readJson("packages/conformance/vectors/text-binding.json"),
  };
  const result = runConformanceVectors(vectors);
  assert.deepEqual(result.results.filter((check) => !check.passed), []);
  assert.equal(result.passed, true);
});

test("hash-chain helpers reproduce the hash-chain vector", async () => {
  const [vector] = await readJson("packages/conformance/vectors/hash-chain.json");
  assert.deepEqual(computeEventHashChain(vector.events, vector.session_id, vector.format_version), vector.chain);
  assert.equal(computeRecordHash(vector.events, vector.session_id, vector.format_version, vector.text_binding), vector.record_hash);
});

test("canon-letters/0.1 normalizes local text without retaining plaintext", () => {
  assert.equal(canonicalizeTextForBinding(" Hello, World! 123 "), "helloworld123");
  assert.equal(canonicalizeTextForBinding("漢 字 １２３"), "漢字123");
  assert.equal(canonicalizeTextForBinding("ﬃ ① Ａ"), "ffi1a");
  assert.equal(canonicalizeTextForBinding("ΟΣ ς Σ"), "οσσσ");
  assert.equal(canonicalizeTextForBinding("ΐ ΰ ᾷ ῇ"), "ΐΰᾶιῆι");
  assert.equal(canonicalizeTextForBinding("A𝟘🙂B"), "a0b");
  assert.equal(canonicalizeTextForBinding("🎉 — !!"), "");
  assert.throws(
    () => createTextBinding("🎉 — !!", "123e4567-e89b-42d3-a456-426614174002"),
    /canonical form must not be empty/,
  );
});

test("text binding verification uses bounded edge-window candidate text only", () => {
  const sessionId = "123e4567-e89b-42d3-a456-426614174002";
  const binding = createTextBinding("Hello, World!", sessionId);
  const trailingMatch = verifyTextBindingCandidate(binding, "hello world!!! appended", sessionId);
  assert.equal(trailingMatch.valid, true, trailingMatch.errors.join("; "));
  assert.equal(trailingMatch.trailingCanonicalLength, 8);
  const leadingMatch = verifyTextBindingCandidate(binding, `${"x".repeat(160)}hello world`, sessionId);
  assert.equal(leadingMatch.valid, true, leadingMatch.errors.join("; "));
  assert.equal(leadingMatch.leadingCanonicalLength, 160);
  const surroundingMatch = verifyTextBindingCandidate(binding, `${"x".repeat(10)}hello world${"y".repeat(10)}`, sessionId);
  assert.equal(surroundingMatch.valid, true, surroundingMatch.errors.join("; "));
  assert.equal(surroundingMatch.leadingCanonicalLength, 10);
  assert.equal(surroundingMatch.trailingCanonicalLength, 10);
  assert.equal(verifyTextBindingCandidate(binding, `${"x".repeat(161)}hello world${"y".repeat(161)}`, sessionId).valid, false);
  assert.equal(verifyTextBindingCandidate(binding, "hullo world", sessionId).valid, false);
});

test("format 0.2 seals text binding into record_hash and detects tampering", () => {
  const sessionId = "123e4567-e89b-42d3-a456-426614174002";
  const events = [{ seq: 0, t: 0, op: "insert", pos: 0, del_len: 0, ins_len: 5, source: "typing" }];
  const textBinding = createTextBinding("Hello, World!", sessionId);
  const record = {
    manifest: {
      format_version: "0.2",
      record_hash: computeRecordHash(events, sessionId, "0.2", textBinding),
      session_id: sessionId,
      producer: { id: "fixture", version: "0.2.0", capabilities: ["timing"] },
      text_binding: textBinding,
      event_count: events.length,
      duration_ms: 0,
      created_client_t: null,
      ingested_server_t: null,
      parent_record: null,
      attestations: [],
    },
    events,
  };
  assert.equal(verifyRecord(record).valid, true);

  const policyRecord = JSON.parse(JSON.stringify(record));
  policyRecord.manifest.text_binding.policy = "prefix";
  const policyVerification = verifyRecord(policyRecord);
  assert.equal(policyVerification.valid, false);
  assert.ok(policyVerification.errors.some((error) => error.includes("text_binding contains unknown field policy")));

  const tampered = JSON.parse(JSON.stringify(record));
  tampered.manifest.text_binding.commitment = `${tampered.manifest.text_binding.commitment.slice(0, -1)}${tampered.manifest.text_binding.commitment.endsWith("0") ? "1" : "0"}`;
  const tamperedVerification = verifyRecord(tampered);
  assert.equal(tamperedVerification.valid, false);
  assert.ok(tamperedVerification.errors.some((error) => error.includes("record_hash mismatch")));

  const legacy = JSON.parse(JSON.stringify(record));
  legacy.manifest.format_version = "0.1";
  legacy.manifest.record_hash = computeRecordHash(events, sessionId, "0.1");
  const legacyVerification = verifyRecord(legacy);
  assert.equal(legacyVerification.valid, false);
  assert.ok(legacyVerification.errors.some((error) => error.includes("text_binding is not valid for format_version 0.1")));
});

test("process length math uses Unicode codepoint counts supplied by producers", () => {
  assert.equal(codepointLength("A🙂B"), 3);
  assert.equal(codepointLength("👩‍💻"), 3);
  assert.equal(codepointLength("e\u0301"), 2);
  assert.equal(computeObservedLength([
    { seq: 0, t: 0, op: "insert", pos: 0, del_len: 0, ins_len: 3, source: "typing" },
    { seq: 1, t: 1, op: "delete", pos: 1, del_len: 1, ins_len: 0, source: "typing" },
    { seq: 2, t: 2, op: "replace", pos: 1, del_len: 1, ins_len: 2, source: "unknown" },
  ]), 3);
  assert.equal(computeObservedLength([
    { seq: 0, t: 0, op: "insert", pos: 0, del_len: 0, ins_len: 3, source: "typing" },
    { seq: 1, t: 1, op: "insert", pos: null, del_len: null, ins_len: null, source: "unknown" },
  ]), null);
});

test("positions beyond inferred length make final observed length unknown without invalidating the record", async () => {
  assert.equal(computeObservedLength([
    { seq: 0, t: 0, op: "insert", pos: 5, del_len: 0, ins_len: 2, source: "typing" },
    { seq: 1, t: 1, op: "delete", pos: 1, del_len: 1, ins_len: 0, source: "typing" },
  ]), null);

  const [golden] = await readJson("packages/conformance/vectors/golden-records.json");
  const record = JSON.parse(JSON.stringify(golden.record));
  record.events = [{ seq: 0, t: 0, op: "insert", pos: 5, del_len: 0, ins_len: 1, source: "typing" }];
  record.manifest.event_count = record.events.length;
  record.manifest.duration_ms = 0;
  record.manifest.record_hash = computeRecordHash(record.events, record.manifest.session_id, record.manifest.format_version);
  const verification = verifyRecord(record);
  assert.equal(verification.valid, true, verification.errors.join("; "));
});

test("unknown process measurements are explicit null, not omitted", () => {
  assert.deepEqual(validateEvent({
    seq: 0,
    t: 0,
    op: "insert",
    pos: null,
    del_len: null,
    ins_len: null,
    source: "unknown",
  }), []);

  const omittedErrors = validateEvent({
    seq: 0,
    t: 0,
    op: "insert",
    source: "unknown",
  });
  assert.ok(omittedErrors.some((error) => error.includes("pos must be a non-negative integer or null")));
  assert.ok(omittedErrors.some((error) => error.includes("del_len must be a non-negative integer or null")));
  assert.ok(omittedErrors.some((error) => error.includes("ins_len must be a non-negative integer or null")));
});

test("record verification checks public process structure and hash chain only", async () => {
  const [golden] = await readJson("packages/conformance/vectors/golden-records.json");
  const verification = verifyRecord(golden.record);
  assert.equal(verification.valid, true);
  assert.deepEqual(verification.errors, []);
  assert.equal(verification.computedRecordHash, golden.record.manifest.record_hash);
});

test("validation rejects plaintext fixture fields and text hashes on public events", () => {
  const textErrors = validateEvent({
    seq: 0,
    t: 0,
    op: "insert",
    pos: 0,
    del_len: 0,
    ins_len: 1,
    source: "typing",
    ins_text: "x",
  });
  assert.ok(textErrors.some((error) => error.includes("unknown field ins_text")));

  const hashErrors = validateEvent({
    seq: 0,
    t: 0,
    op: "insert",
    pos: 0,
    del_len: 0,
    ins_len: 1,
    source: "typing",
    ins_hash: "b3:6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85",
  });
  assert.ok(hashErrors.some((error) => error.includes("unknown field ins_hash")));
});

test("public manifest validation rejects text-derived fields", async () => {
  const [golden] = await readJson("packages/conformance/vectors/golden-records.json");
  assert.deepEqual(validateManifest(golden.record.manifest), []);
  const errors = validateManifest({
    ...golden.record.manifest,
    final_text_hash: "b3:6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85",
    final_text_length: 2,
  });
  assert.ok(errors.some((error) => error.includes("final_text_hash is not a content-blind public manifest field")));
  assert.ok(errors.some((error) => error.includes("final_text_length is not a content-blind public manifest field")));
});

test("public manifest validation rejects any description of where the text was written", async () => {
  const [golden] = await readJson("packages/conformance/vectors/golden-records.json");
  assert.equal("capture_context" in golden.record.manifest, false, "golden records carry no capture context");
  for (const capture_context of [{ surface: "browser", browser: { title: "Drafts - someone@example.com" } }, { surface: "emacs" }, null]) {
    const errors = validateManifest({ ...golden.record.manifest, capture_context });
    assert.ok(errors.some((error) => error.includes("capture_context is not a public manifest field")), JSON.stringify(capture_context));
  }
});

test("public manifest validation rejects storage-only parent_record_hash", async () => {
  const [golden] = await readJson("packages/conformance/vectors/golden-records.json");
  const errors = validateManifest({
    ...golden.record.manifest,
    parent_record_hash: golden.record.manifest.record_hash,
  });
  assert.ok(errors.some((error) => error.includes("parent_record_hash is not a public manifest field")));
});

test("manifest validation requires UUIDv4 session ids", async () => {
  const [golden] = await readJson("packages/conformance/vectors/golden-records.json");
  assert.deepEqual(validateManifest(golden.record.manifest), []);
  const errors = validateManifest({
    ...golden.record.manifest,
    session_id: "123e4567-e89b-12d3-a456-426614174000",
  });
  assert.ok(errors.some((error) => error.includes("session_id must be a lowercase UUIDv4 string")));
  const uppercase = validateManifest({
    ...golden.record.manifest,
    session_id: golden.record.manifest.session_id.toUpperCase(),
  });
  assert.ok(uppercase.some((error) => error.includes("session_id must be a lowercase UUIDv4 string")));
});

test("time fields accept exact long durations while counts retain their existing bounds", async () => {
  const [golden] = await readJson("packages/conformance/vectors/golden-records.json");
  const event = golden.record.events[0];
  const manifest = golden.record.manifest;
  for (const elapsed of [2 ** 31, 60 * 86400000, 5 * 365 * 86400000, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(validateEvent({...event, t: elapsed}), []);
    assert.deepEqual(validateManifest({...manifest, duration_ms: elapsed}), []);
  }
  for (const elapsed of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, "5184000000"]) {
    assert.match(validateEvent({...event, t: elapsed}).join(" "), /safe integer/);
    assert.match(validateManifest({...manifest, duration_ms: elapsed}).join(" "), /safe integer/);
  }
  for (const field of ["seq", "pos", "ins_len", "del_len"]) {
    assert.notDeepEqual(validateEvent({...event, [field]: 2 ** 31}), []);
  }
  assert.notDeepEqual(validateManifest({...manifest, event_count: 2 ** 31}), []);
});

test("0.3 seals finish duration and continuation without rewriting 0.2 checkpoint prefixes", async () => {
  const [golden] = await readJson("packages/conformance/vectors/golden-records.json");
  const record = structuredClone(golden.record);
  record.manifest.format_version = "0.3";
  record.manifest.duration_ms = 60 * 86400000;
  const oldChain = computeEventHashChain(record.events, record.manifest.session_id, "0.2");
  assert.deepEqual(computeEventHashChain(record.events, record.manifest.session_id, "0.3"), oldChain);
  record.manifest.record_hash = computeRecordHash(record.events, record.manifest.session_id, "0.3", undefined, record.manifest);
  assert.notEqual(record.manifest.record_hash, oldChain.at(-1));
  assert.equal(verifyRecord(record).valid, true);
  for (const change of [{ duration_ms: record.manifest.duration_ms + 1 }, { parent_record: oldChain.at(-1) }, { text_binding: createTextBinding("one", record.manifest.session_id) }]) {
    assert.equal(verifyRecord({ ...record, manifest: { ...record.manifest, ...change } }).valid, false, JSON.stringify(change));
  }
  const bound = { ...record.manifest, text_binding: createTextBinding("one", record.manifest.session_id) };
  bound.record_hash = computeRecordHash(record.events, bound.session_id, "0.3", bound.text_binding, bound);
  assert.equal(verifyRecord({ manifest: bound, events: record.events }).valid, true);
  assert.equal(verifyRecord({ manifest: { ...bound, text_binding: { ...bound.text_binding, canonical_length: 0 } }, events: record.events }).valid, false);
  assert.throws(() => computeRecordHash(record.events, record.manifest.session_id, "0.3"), /duration_ms/);
});

test("0.3 finalization canonical vector remains stable", () => {
  const events = [{ seq: 0, t: 1000, op: "insert", pos: 0, del_len: 0, ins_len: 1, source: "typing" }];
  assert.equal(computeRecordHash(events, "00000000-0000-4000-8000-000000000001", "0.3", undefined, { duration_ms: 5184000000, parent_record: null }),
    "b3:91e988e0a466dfaf60be4864ed3b69cc26421f28474fc7c9df9841c1ea50662c");
});

test("known operation sizes remain constrained when other measurements are unknown", () => {
  const base = { seq: 0, t: 0, pos: null, source: "unknown" };
  for (const sizes of [
    { op: "insert", del_len: 100, ins_len: 0 },
    { op: "insert", del_len: 1, ins_len: null },
    { op: "insert", del_len: null, ins_len: 0 },
    { op: "delete", del_len: null, ins_len: 1 },
    { op: "delete", del_len: 0, ins_len: null },
    { op: "replace", del_len: 0, ins_len: null },
    { op: "replace", del_len: null, ins_len: 0 },
  ]) assert.ok(validateEvent({ ...base, ...sizes }).length, JSON.stringify(sizes));
  for (const op of ["insert", "delete", "replace"]) {
    assert.deepEqual(validateEvent({ ...base, op, del_len: null, ins_len: null }), []);
  }
});

test("observed length can start from a continuation's parent length", async () => {
  const { computeObservedLength } = await import("../packages/format/src/index.ts");
  const events = [
    { seq: 0, t: 0, op: "insert", pos: 120, del_len: 0, ins_len: 3, source: "typing" },
    { seq: 1, t: 10, op: "delete", pos: 50, del_len: 5, ins_len: 0, source: "typing" },
  ];
  assert.equal(computeObservedLength(events), null, "without a starting length, an edit inside existing text is unknown");
  assert.equal(computeObservedLength(events, 200), 198);
  assert.equal(computeObservedLength(events, 100), null, "an edit beyond the starting length is unknown");
  assert.equal(computeObservedLength(events, null), null, "an unknown starting length stays unknown");
  const gap = [{ ...events[0], pos: null }, events[1]];
  assert.equal(computeObservedLength(gap, 200), null, "a gap at the first edit keeps the length unknown");
});

test("only a signed-finish continuation starts from its parent's final length", async () => {
  const { startingLength } = await import("../packages/format/src/index.ts");
  const parent = "b3:" + "a".repeat(64);
  assert.equal(startingLength({ format_version: "0.3", parent_record: parent }, 812), 812);
  assert.equal(startingLength({ format_version: "0.3", parent_record: parent }, null), null, "an unknown or removed parent leaves the start unknown");
  assert.equal(startingLength({ format_version: "0.3", parent_record: null }, 812), 0, "a first record starts empty");
  assert.equal(startingLength({ format_version: "0.2", parent_record: parent }, 812), 0, "older formats keep starting empty");
});
