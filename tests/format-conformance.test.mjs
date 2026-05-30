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
      capture_context: null,
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
  assert.ok(errors.some((error) => error.includes("session_id must be a UUIDv4 string")));
});
