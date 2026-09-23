import assert from "node:assert/strict";
import test from "node:test";
import { finishRecord, OperationGuard, copyRecordLink } from "../apps/browser-extension/src/popup/finish.ts";

const SID = "example-session";
const binding = { scheme: "canon-letters/0.1", canonical_length: 12, commitment: "b3:example" };

test("requested binding failure never signs and process-only requires a separate operation", async () => {
  const requests = [];
  const send = async request => {
    requests.push(request);
    if (request.kind === "prepare_finish") return { kind: "prepare_finish_result", text_binding: null, ...(request.bind ? { reason: "The chosen editor is closed." } : {}) };
    return { kind: "sign_session_result", result: { kind: "uploaded", response: { url: "https://example.com/record" } } };
  };
  assert.deepEqual(await finishRecord(send, SID, true, {}), { kind: "binding_unavailable", reason: "The chosen editor is closed." });
  assert.deepEqual(requests.map(request => request.kind), ["prepare_finish"]);
  await finishRecord(send, SID, false, { drop_url: true });
  assert.deepEqual(requests[2], { kind: "sign_session", session_id: SID, capture_context_redactions: { drop_url: true } });
  assert.equal(requests[1].bind, false);
});

test("successful binding is forwarded only after the exact session was prepared", async () => {
  const requests = [];
  await finishRecord(async request => {
    requests.push(request);
    return request.kind === "prepare_finish"
      ? { kind: "prepare_finish_result", text_binding: binding }
      : { kind: "sign_session_result", result: { kind: "failed", reason: "offline" } };
  }, SID, true, {});
  assert.deepEqual(requests, [
    { kind: "prepare_finish", session_id: SID, bind: true },
    { kind: "sign_session", session_id: SID, text_binding: binding },
  ]);
});

test("preparation failure cannot be converted into an upload, even process-only", async () => {
  for (const prepared of [{ kind: "error", reason: "flush failed" }, { kind: "prepare_finish_result", text_binding: null, reason: "flush failed" }]) {
    let calls = 0;
    const result = await finishRecord(async () => { calls++; return prepared; }, SID, false, {});
    assert.equal(calls, 1);
    assert.equal(result.response.kind, "error");
  }
});

test("competing clicks are rejected until completion, and a failure releases the guard", async () => {
  const guard = new OperationGuard();
  let finish;
  const pending = guard.run(() => new Promise(resolve => { finish = resolve; }));
  assert.equal(await guard.run(async () => { assert.fail("second click ran"); }), false);
  finish();
  assert.equal(await pending, true);
  await assert.rejects(guard.run(async () => { throw new Error("offline"); }), /offline/);
  assert.equal(guard.busy, false);
  assert.equal(await guard.run(async () => {}), true);
});

test("clipboard denial cannot erase upload success or claim copied", async () => {
  const denied = await copyRecordLink("https://example.com/record", { writeText: async () => { throw new Error("denied"); } });
  assert.match(denied, /your record is saved/);
  assert.doesNotMatch(denied, /Link copied/);
  let finish;
  const pending = copyRecordLink("https://example.com/record", { writeText: () => new Promise(resolve => { finish = resolve; }) });
  let completed = false;
  pending.then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  finish();
  assert.equal(await pending, "Link copied.");
});
