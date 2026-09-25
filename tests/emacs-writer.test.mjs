import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm, stat, readdir, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { writeSession } from "../producers/emacs/scripts/session-writer.mjs";

const eventsFor = (count, start = 0) => Array.from({ length: count }, (_, index) => ({
  seq: start + index, t: 10 * (start + index), op: "insert", pos: start + index,
  del_len: 0, ins_len: 1, source: "typing",
}));
const serialize = (events) => events.map((event) => `${JSON.stringify(event)}\n`).join("");
const frame = (id, chunk, final = true) => JSON.stringify({ id, chunk, final });
const framesFor = (request, size = 1000) => {
  const raw = JSON.stringify(request), lines = [];
  for (let offset = 0; offset < raw.length; offset += size) {
    lines.push(frame(request.id, raw.slice(offset, offset + size), offset + size >= raw.length));
  }
  return lines;
};
function protocol(lines) {
  const result = spawnSync(process.execPath, [resolve("producers/emacs/scripts/session-writer.mjs")], {
    input: lines.join("\n") + "\n", encoding: "utf8", timeout: 10_000, maxBuffer: 1_000_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.includes("PRIVATE-"), false);
  const replies = result.stdout.trim().split("\n").map(JSON.parse);
  assert.deepEqual(replies.shift(), { ready: true });
  return replies;
}

async function fixture(fn) {
  const directory = await mkdtemp(join(tmpdir(), "pmbah-session-writer-"));
  const request = (events, count = 0, bytes = 0) => ({
    id: 1, state_path: join(directory, "state.json"), journal_path: join(directory, "events.jsonl"),
    expected_count: count, expected_bytes: bytes, events,
    state: { storage_version: 2, session_id: "writer-test", event_count: count, journal_bytes: bytes, capture_enabled: true },
  });
  try { await fn(request, directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("worker durably advances bounded batches and saves metadata-only changes", async () => {
  await fixture(async (request, directory) => {
    const first = request(eventsFor(256));
    const ack = await writeSession(first);
    assert.deepEqual(ack, { id: 1, ok: true, event_count: 256, byte_length: Buffer.byteLength(serialize(first.events)) });
    const second = request(eventsFor(2, 256), ack.event_count, ack.byte_length);
    const next = await writeSession(second);
    const paused = request([], next.event_count, next.byte_length);
    paused.state.capture_enabled = false;
    assert.deepEqual(await writeSession(paused), next);
    const saved = JSON.parse(await readFile(first.state_path, "utf8"));
    assert.equal(saved.capture_enabled, false);
    assert.equal(saved.event_count, 258);
    assert.equal(saved.journal_bytes, next.byte_length);
    assert.equal(await readFile(first.journal_path, "utf8"), serialize([...first.events, ...second.events]));
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    for (const path of [first.state_path, first.journal_path]) assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(directory)).sort(), ["events.jsonl", "state.json"]);
  });
});

test("acknowledgement loss retries an already committed batch without duplicating or truncating", async () => {
  await fixture(async (request) => {
    const input = request(eventsFor(3));
    const first = await writeSession(input);
    const before = await readFile(input.journal_path);
    assert.deepEqual(await writeSession(input), first);
    assert.deepEqual(await readFile(input.journal_path), before);
    assert.equal(JSON.parse(await readFile(input.state_path)).event_count, 3);
  });
});

test("retry reuses a complete or partial matching append after a failed metadata save", async () => {
  for (const partial of [false, true]) {
    await fixture(async (request) => {
      const baseline = await writeSession(request(eventsFor(1)));
      const input = request(eventsFor(3, 1), baseline.event_count, baseline.byte_length);
      const suffix = serialize(input.events);
      await writeFile(input.journal_path, serialize(eventsFor(1)) + (partial ? suffix.slice(0, 130) : suffix));
      const result = await writeSession(input);
      assert.equal(result.event_count, 4);
      assert.equal(await readFile(input.journal_path, "utf8"), serialize(eventsFor(4)));
    });
  }
});

test("metadata creation failure preserves the appended journal and retry can acknowledge it", async () => {
  await fixture(async (request, directory) => {
    const input = request(eventsFor(3));
    // The destination is a valid filename, but the worker's temporary suffix
    // exceeds NAME_MAX. This fails after the journal append and its fsync.
    const failed = { ...input, state_path: join(directory, "s".repeat(245)) };
    await assert.rejects(writeSession(failed), /session storage failed \(ENAMETOOLONG\)/);
    assert.equal(await readFile(input.journal_path, "utf8"), serialize(input.events));
    await assert.rejects(stat(failed.state_path), { code: "ENOENT" });
    assert.equal((await writeSession(input)).event_count, 3);
    assert.equal(await readFile(input.journal_path, "utf8"), serialize(input.events));
    assert.deepEqual((await readdir(directory)).sort(), ["events.jsonl", "state.json"]);
  });
});

test("writer replaces an orphan temporary file without following a stale symlink", async () => {
  await fixture(async (request, directory) => {
    const input = request(eventsFor(1));
    const target = join(directory, "unrelated.txt");
    await writeFile(target, "PRIVATE-CANARY");
    await symlink(target, `${input.state_path}.writer.tmp`);
    await writeSession(input);
    assert.equal(await readFile(target, "utf8"), "PRIVATE-CANARY");
    await writeFile(`${input.state_path}.writer.tmp`, "orphan after SIGKILL");
    await writeSession(input);
    await assert.rejects(stat(`${input.state_path}.writer.tmp`), { code: "ENOENT" });
    assert.equal(JSON.parse(await readFile(input.state_path)).event_count, 1);
  });
});

test("retry refuses conflicting and too-long suffixes without changing persisted bytes", async () => {
  for (const suffix of [serialize(eventsFor(1)).replace('"typing"', '"pasted"'), serialize(eventsFor(3))]) {
    await fixture(async (request) => {
      const input = request(eventsFor(2));
      await writeFile(input.journal_path, suffix);
      await assert.rejects(writeSession(input), /conflicts/);
      assert.equal(await readFile(input.journal_path, "utf8"), suffix);
      await assert.rejects(stat(input.state_path), { code: "ENOENT" });
    });
  }
});

test("persisted state cannot outrun journal or be rolled back by a stale retry", async () => {
  await fixture(async (request) => {
    const initial = request(eventsFor(1));
    const ack = await writeSession(initial);
    await writeSession(request(eventsFor(1, 1), ack.event_count, ack.byte_length));
    await assert.rejects(writeSession(initial), /conflicts/);
    const complete = await readFile(initial.journal_path);
    const saved = JSON.parse(await readFile(initial.state_path));
    await writeFile(initial.journal_path, complete.subarray(0, ack.byte_length));
    await assert.rejects(writeSession(request(eventsFor(1, 1), ack.event_count, ack.byte_length)), /metadata conflicts/);
    assert.deepEqual(JSON.parse(await readFile(initial.state_path)), saved);
  });
});

test("saved cursor inside a retry batch must fall on the correct event boundary", async () => {
  await fixture(async (request) => {
    const input = request(eventsFor(3));
    await writeFile(input.journal_path, serialize(input.events));
    await writeFile(input.state_path, JSON.stringify({ ...input.state, event_count: 1, journal_bytes: 10 }));
    await assert.rejects(writeSession(input), /metadata conflicts/);
    await writeFile(input.state_path, JSON.stringify({ ...input.state, event_count: 1, journal_bytes: Buffer.byteLength(serialize(input.events.slice(0, 1))) }));
    assert.equal((await writeSession(input)).event_count, 3);
  });
});

test("worker rejects plaintext, invalid sequences, timestamps and oversized batches before writing", async () => {
  await fixture(async (request, directory) => {
    for (const events of [
      [{ ...eventsFor(1)[0], inserted_text: "PRIVATE-CANARY" }],
      eventsFor(1, 1),
      [eventsFor(1)[0], { ...eventsFor(1, 1)[0], t: -1 }],
      eventsFor(257),
    ]) await assert.rejects(writeSession(request(events)), /invalid/);
    assert.deepEqual(await readdir(directory), []);
    const input = request(eventsFor(1));
    input.state.event_count = 1;
    await assert.rejects(writeSession(input), /snapshot/);
    assert.deepEqual(await readdir(directory), []);
  });
});

test("persistent protocol processes multiple requests sequentially and survives invalid input", async () => {
  await fixture(async (request) => {
    const first = request(eventsFor(2));
    const second = { ...request(eventsFor(2, 2), 2, Buffer.byteLength(serialize(first.events))), id: 2 };
    const privateInput = { ...request([{ ...eventsFor(1)[0], "PRIVATE-FIELD-CANARY": "PRIVATE-VALUE-CANARY" }]), id: 3 };
    const fourth = { ...request([], 4, Buffer.byteLength(serialize(eventsFor(4)))), id: 4 };
    const replies = protocol([...framesFor(first, 250), "PRIVATE-INVALID-JSON", ...framesFor(second),
      ...framesFor(privateInput), ...framesFor(fourth)]).filter((reply) => !reply.credit);
    assert.deepEqual(replies.map(({ id, ok }) => ({ id, ok })), [
      { id: 1, ok: true }, { id: null, ok: false }, { id: 2, ok: true }, { id: 3, ok: false }, { id: 4, ok: true },
    ]);
    assert.equal(replies.at(-1).event_count, 4);
    assert.equal(await readFile(first.journal_path, "utf8"), serialize(eventsFor(4)));
  });
});

test("transport credits each bounded nonfinal frame without acknowledging storage early", async () => {
  await fixture(async (request) => {
    const input = request(eventsFor(256));
    const frames = framesFor(input);
    assert.ok(frames.length > 20);
    for (const line of frames) assert.ok(Buffer.byteLength(line) + 1 <= 4096);
    const replies = protocol(frames);
    assert.equal(replies.length, frames.length);
    for (const reply of replies.slice(0, -1)) assert.deepEqual(reply, { id: 1, credit: true });
    assert.equal(replies.at(-1).ok, true);
    assert.equal(replies.at(-1).event_count, 256);
  });
});

test("transport rejects malformed, out-of-order and oversized frames then accepts a fresh request", async () => {
  await fixture(async (request) => {
    const lines = [
      frame(1, "{", false), frame(2, "}", true),
      JSON.stringify({ id: 3, chunk: "PRIVATE-CHUNK", final: "yes" }),
      frame(4, "x".repeat(4096)),
      frame(5, JSON.stringify({ ...request([]), id: 6 })),
      frame(7, "PRIVATE-INVALID-REQUEST"),
      frame(8, "", false), frame(9, "", true),
      ...framesFor({ ...request(eventsFor(1)), id: 8 }),
    ];
    const replies = protocol(lines);
    assert.deepEqual(replies[0], { id: 1, credit: true });
    assert.deepEqual(replies.slice(1, -1).map((reply) => reply.ok), [false, false, false, false, false, false, false]);
    assert.match(replies[1].error, /out of order/);
    assert.match(replies[3].error, /frame exceeds/);
    assert.match(replies[4].error, /unexpected id/);
    assert.match(replies[6].error, /invalid session transport frame/);
    assert.match(replies[7].error, /invalid session transport frame/);
    assert.equal(replies.at(-1).event_count, 1);
  });
});

test("transport bounds aggregate request size and rejects an incomplete request on EOF", async () => {
  await fixture(async (request) => {
    const chunks = Array.from({ length: 525 }, () => frame(1, "x".repeat(4000), false));
    const replies = protocol([...chunks, ...framesFor({ ...request(eventsFor(1)), id: 2 }), frame(3, "{", false)]);
    const meaningful = replies.filter((reply) => !reply.credit);
    assert.equal(meaningful.length, 3);
    assert.match(meaningful[0].error, /request exceeds/);
    assert.equal(meaningful[1].event_count, 1);
    assert.match(meaningful[2].error, /ended before the final frame/);
  });
});
