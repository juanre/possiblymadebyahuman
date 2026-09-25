#!/usr/bin/env node
// Persistent local disk worker. Emacs keeps unacknowledged events until the
// journal and its small metadata snapshot are both durable.
import { open, mkdir, chmod, rename, rm, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { validateEvent } from "../../../packages/format/src/index.ts";

const MAX_STATE_BYTES = 1024 * 1024;
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

async function syncDirectory(directory) {
  const handle = await open(directory, "r");
  try {
    try { await handle.sync(); }
    catch (error) {
      // Some filesystems do not implement fsync for directory descriptors.
      if (!["EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes(error.code)) throw error;
    }
  } finally { await handle.close(); }
}

async function writeAll(handle, bytes, position) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, position + offset);
    if (!bytesWritten) throw new Error("journal write made no progress");
    offset += bytesWritten;
  }
}

async function persistSession(input) {
  if (!object(input) || !integer(input.expected_bytes) || !integer(input.expected_count) ||
      !Array.isArray(input.events) || input.events.length > 256 || !object(input.state) ||
      typeof input.journal_path !== "string" || typeof input.state_path !== "string" ||
      resolve(input.journal_path) === resolve(input.state_path) ||
      dirname(resolve(input.journal_path)) !== dirname(resolve(input.state_path))) {
    throw new Error("invalid session write request");
  }
  const { expected_bytes: expectedBytes, expected_count: expectedCount, events, state } = input;
  if (state.storage_version !== 2 || typeof state.session_id !== "string" || !state.session_id ||
      state.event_count !== expectedCount || state.journal_bytes !== expectedBytes) {
    throw new Error("session snapshot does not match the acknowledged cursor");
  }
  for (let index = 0; index < events.length; index++) {
    // Do not report validator details: unknown field names can contain text.
    if (validateEvent(events[index], expectedCount + index).length ||
        (index > 0 && events[index].t < events[index - 1].t)) {
      throw new Error("invalid content-blind event batch");
    }
  }
  const lines = events.map((event) => Buffer.from(`${JSON.stringify(event)}\n`, "utf8"));
  const bytes = Buffer.concat(lines);
  const finalCount = expectedCount + events.length;
  const finalBytes = expectedBytes + bytes.length;
  if (!integer(finalCount) || !integer(finalBytes)) throw new Error("session cursor exceeds its range");
  const metadata = JSON.stringify({ ...state, event_count: finalCount, journal_bytes: finalBytes });
  if (Buffer.byteLength(metadata) > MAX_STATE_BYTES) throw new Error("session metadata exceeds its size limit");
  const directory = dirname(resolve(input.state_path));
  let journal, temporary;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    try { journal = await open(input.journal_path, "r+"); }
    catch (error) {
      if (error.code !== "ENOENT" || expectedBytes !== 0 || expectedCount !== 0) throw error;
      journal = await open(input.journal_path, "wx+", 0o600);
    }
    await journal.chmod(0o600);
    const size = (await journal.stat()).size;
    if (size < expectedBytes || size > finalBytes) throw new Error("journal size conflicts with the pending batch");

    let persisted;
    try {
      const raw = await readFile(input.state_path, "utf8");
      if (Buffer.byteLength(raw) > MAX_STATE_BYTES) throw new Error("saved metadata exceeds its size limit");
      try { persisted = JSON.parse(raw); }
      catch { throw new Error("saved metadata is invalid"); }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (persisted !== undefined) {
      if (!object(persisted) || persisted.session_id !== state.session_id ||
          !integer(persisted.event_count) || !integer(persisted.journal_bytes) ||
          persisted.event_count > finalCount || persisted.journal_bytes > size ||
          persisted.journal_bytes > finalBytes ||
          (persisted.event_count === expectedCount && persisted.journal_bytes !== expectedBytes) ||
          (persisted.journal_bytes === expectedBytes && persisted.event_count !== expectedCount)) {
        throw new Error("saved metadata conflicts with the journal cursor");
      }
      // An acknowledged-lost retry may already have committed part or all of
      // this batch. Its metadata must name an actual line boundary in it.
      if (persisted.event_count > expectedCount || persisted.journal_bytes > expectedBytes) {
        const prefixCount = persisted.event_count - expectedCount;
        const prefixBytes = lines.slice(0, prefixCount).reduce((sum, line) => sum + line.length, 0);
        if (prefixCount < 0 || persisted.journal_bytes !== expectedBytes + prefixBytes) {
          throw new Error("saved metadata conflicts with the pending batch");
        }
      }
    }

    // Never truncate an uncertain append. Reuse only a byte-identical prefix,
    // including a partial last line; reject any different or longer suffix.
    const existing = Buffer.alloc(size - expectedBytes);
    let offset = 0;
    while (offset < existing.length) {
      const { bytesRead } = await journal.read(existing, offset, existing.length - offset, expectedBytes + offset);
      if (!bytesRead) throw new Error("journal changed while checking the pending batch");
      offset += bytesRead;
    }
    if (!existing.equals(bytes.subarray(0, existing.length))) throw new Error("journal suffix conflicts with the pending batch");
    await writeAll(journal, bytes.subarray(existing.length), size);
    await journal.sync();

    // Emacs owns the session lock and runs only one request at a time. A fixed
    // private filename lets the next worker remove an orphan after SIGKILL.
    // Remove it before exclusive creation so a stale symlink is never followed.
    const candidate = `${input.state_path}.writer.tmp`;
    await rm(candidate, { force: true });
    const file = await open(candidate, "wx", 0o600);
    temporary = candidate;
    try { await file.writeFile(metadata, "utf8"); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, input.state_path);
    temporary = undefined;
    await syncDirectory(directory);
    return { id: input.id, ok: true, event_count: finalCount, byte_length: finalBytes };
  } finally {
    try { if (journal) await journal.close(); }
    finally { if (temporary) await rm(temporary, { force: true }); }
  }
}

export async function writeSession(input) {
  try { return await persistSession(input); }
  catch (error) {
    // Filesystem errors (including cleanup failures) include local paths.
    if (error.code) throw new Error(`session storage failed (${error.code})`);
    throw error;
  }
}

// One small frame is sent only after ready/credit. The editor therefore never
// writes a whole large request into a pipe whose reader is still starting up
// or blocked on durable storage. Credits acknowledge transport, never events.
export async function runWriter(input = process.stdin, output = process.stdout, save = writeSession) {
  const reply = async (value) => {
    if (!output.write(`${JSON.stringify(value)}\n`)) await once(output, "drain");
  };
  const frames = createInterface({ input, crlfDelay: Infinity });
  let requestId = null, chunks = [], size = 0;
  const reset = () => { requestId = null; chunks = []; size = 0; };
  await reply({ ready: true });
  for await (const line of frames) {
    let frame;
    try {
      if (Buffer.byteLength(line) + 1 > 4096) throw new Error("session transport frame exceeds its size limit");
      try { frame = JSON.parse(line); }
      catch { throw new Error("session transport frame is not valid JSON"); }
      if (!object(frame) || !integer(frame.id) || typeof frame.chunk !== "string" || frame.chunk.length === 0 || typeof frame.final !== "boolean" ||
          Object.keys(frame).some((key) => !["id", "chunk", "final"].includes(key))) {
        throw new Error("invalid session transport frame");
      }
      if (requestId !== null && requestId !== frame.id) throw new Error("session transport frame is out of order");
      requestId = frame.id;
      size += Buffer.byteLength(frame.chunk);
      if (size > MAX_STATE_BYTES + 256 * 4096) throw new Error("session write request exceeds its size limit");
      chunks.push(frame.chunk);
      if (!frame.final) {
        await reply({ id: frame.id, credit: true });
        continue;
      }
      let request;
      try { request = JSON.parse(chunks.join("")); }
      catch { throw new Error("session write request is not valid JSON"); }
      if (!object(request) || request.id !== requestId) throw new Error("session write request has an unexpected id");
      reset();
      await reply(await save(request));
    } catch (error) {
      const id = integer(frame?.id) ? frame.id : requestId;
      reset();
      await reply({ id, ok: false, error: error.message });
    }
  }
  if (requestId !== null) await reply({ id: requestId, ok: false, error: "session transport ended before the final frame" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runWriter();
}
