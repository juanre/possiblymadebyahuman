import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  b3HashText,
  canonicalizeJson,
  codepointLength,
  computeEventHashChain,
  computeFinalTextMetadata,
  computeRecordHash,
  replayEventsWithText,
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
    replays: await readJson("packages/conformance/vectors/replay-codepoint.json"),
    goldenRecords: await readJson("packages/conformance/vectors/golden-records.json"),
    capabilityHonesty: await readJson("packages/conformance/vectors/capability-honesty.json"),
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

test("deterministic replay uses Unicode codepoint offsets", async () => {
  const vectors = await readJson("packages/conformance/vectors/replay-codepoint.json");
  for (const vector of vectors) {
    const replay = replayEventsWithText(vector.events);
    assert.equal(replay.finalText, vector.final_text, vector.name);
    assert.equal(replay.finalTextLength, vector.final_text_length, vector.name);
    assert.equal(replay.finalTextHash, vector.final_text_hash, vector.name);
  }
  assert.equal(codepointLength("A🙂B"), 3);
  assert.equal(codepointLength("👩‍💻"), 3);
  assert.equal(codepointLength("e\u0301"), 2);
});

test("record verification checks chain and optional local final-text determinism", async () => {
  const [golden] = await readJson("packages/conformance/vectors/golden-records.json");
  const verification = verifyRecord(golden.record, {
    getInsertedText: (event) => golden.replay_insertions_by_seq[String(event.seq)] ?? "",
  });
  assert.equal(verification.valid, true);
  assert.deepEqual(verification.errors, []);
  assert.equal(verification.computedRecordHash, golden.record.manifest.record_hash);
  assert.equal(verification.computedFinalTextHash, golden.record.manifest.final_text_hash);
});

test("validation rejects UTF-16-ish plaintext fixture fields on public events", () => {
  const errors = validateEvent({
    seq: 0,
    t: 0,
    op: "insert",
    pos: 0,
    del_len: 0,
    ins_len: 1,
    source: "typing",
    ins_text: "x",
  });
  assert.ok(errors.some((error) => error.includes("unknown field ins_text")));
});

test("final text metadata counts codepoints and hashes UTF-8 text", () => {
  assert.deepEqual(computeFinalTextMetadata("🙂a"), {
    finalTextLength: 2,
    finalTextHash: b3HashText("🙂a"),
  });
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
