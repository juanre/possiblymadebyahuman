import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  b3HashText,
  canonicalizeJson,
  codepointLength,
  computeEventHashChain,
  computeObservedLength,
  computeRecordHash,
  validateEvent,
  validateManifest,
  verifyRecord,
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
  };
  const result = runConformanceVectors(vectors);
  assert.deepEqual(result.results.filter((check) => !check.passed), []);
  assert.equal(result.passed, true);
});

test("hash-chain helpers reproduce the hash-chain vector", async () => {
  const [vector] = await readJson("packages/conformance/vectors/hash-chain.json");
  assert.deepEqual(computeEventHashChain(vector.events, vector.session_id), vector.chain);
  assert.equal(computeRecordHash(vector.events, vector.session_id), vector.record_hash);
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
