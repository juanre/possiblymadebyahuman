#!/usr/bin/env node
// Private local event journal. Every line is one content-blind public event.
import { createReadStream } from "node:fs";
import { stat, truncate, readFile, open, rename, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  advanceEventHash, sealRecordHash, createTextBinding, canonicalizeTextForBinding,
  EventStreamVerifier,
  validateManifest,
} from "../../../packages/format/src/index.ts";
import { validateUploadResponse } from "../../../packages/producer-core/src/upload-response.ts";

const MAX_LINE_BYTES = 4096;
export async function* journalEvents(path, { startByte = 0, endByte } = {}) {
  if (!Number.isSafeInteger(startByte) || startByte < 0 ||
      (endByte !== undefined && (!Number.isSafeInteger(endByte) || endByte < startByte))) {
    throw new Error("invalid journal byte range");
  }
  if (endByte === startByte) return;
  const stream = createReadStream(path, { start: startByte, ...(endByte === undefined ? {} : { end: endByte - 1 }), highWaterMark: 64 * 1024 });
  let pending = Buffer.alloc(0), offset = startByte;
  for await (const chunk of stream) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let newline;
    while ((newline = pending.indexOf(10)) >= 0) {
      if (newline > MAX_LINE_BYTES) throw new Error("journal event line exceeds the numeric-event limit");
      const line = pending.subarray(0, newline);
      const end = offset + newline + 1;
      let event;
      try { event = JSON.parse(line.toString("utf8")); }
      catch { throw new Error(`journal contains an invalid complete event at byte ${offset}`); }
      yield { event, startByte: offset, endByte: end };
      pending = pending.subarray(newline + 1);
      offset = end;
    }
    if (pending.length > MAX_LINE_BYTES) throw new Error("journal event line exceeds the numeric-event limit");
  }
  // A newline is the durable append boundary. Never interpret a partial tail
  // as an event; inspectJournal explicitly repairs only this final suffix.
  if (pending.length) return { truncatedTail: true, endByte: offset };
}

export async function inspectJournal(input) {
  if (input.repair_tail && (input.event_count !== undefined || input.end_byte !== undefined || input.previous_byte_offset !== undefined)) {
    throw new Error("tail repair requires an unbounded scan from the journal start");
  }
  let count = input.previous_event_count ?? 0;
  let tip = input.previous_chain_tip ?? null;
  let offset = input.previous_byte_offset ?? 0;
  let lastTime = input.previous_t ?? 0;
  const tail = [];
  const maxCount = input.event_count ?? Number.MAX_SAFE_INTEGER;
  // These are independently persisted commitments, not starting cursors. Check
  // them while streaming from zero, before adopting a suffix or repairing bytes.
  const anchors = new Map();
  const addAnchor = (anchor, label, requireHash = false) => {
    if (!anchor || !Number.isSafeInteger(anchor.event_count) || anchor.event_count < 0 ||
        (requireHash && (anchor.event_count < 1 || !/^b3:[0-9a-f]{64}$/.test(anchor.chain_tip))) ||
        (anchor.byte_length !== undefined && (!Number.isSafeInteger(anchor.byte_length) || anchor.byte_length < 0)) ||
        (anchor.last_t !== undefined && (!Number.isSafeInteger(anchor.last_t) || anchor.last_t < 0))) {
      throw new Error(`invalid ${label} journal anchor`);
    }
    const entries = anchors.get(anchor.event_count) ?? [];
    entries.push({ ...anchor, label });
    anchors.set(anchor.event_count, entries);
  };
  if (input.acknowledged_event_count !== undefined) {
    addAnchor({ event_count: input.acknowledged_event_count,
      ...(input.acknowledged_byte_length !== undefined ? { byte_length: input.acknowledged_byte_length } : {}) }, "acknowledged");
  }
  if (input.chain_anchor != null) addAnchor(input.chain_anchor, "cached hash", true);
  if (input.observation_anchors != null) {
    if (!Array.isArray(input.observation_anchors) || input.observation_anchors.length > 32) throw new Error("invalid observation journal anchors");
    for (const anchor of input.observation_anchors) addAnchor(anchor, "observation", true);
  }
  const frozen = input.frozen_manifest;
  if (frozen != null) {
    if (validateManifest(frozen).length || frozen.session_id !== input.session_id || frozen.format_version !== input.format_version) {
      throw new Error("invalid frozen journal manifest");
    }
    addAnchor({ event_count: frozen.event_count,
      ...(input.frozen_byte_length != null ? { byte_length: input.frozen_byte_length } : {}) }, "frozen");
  }
  if (anchors.size && (count !== 0 || offset !== 0 || tip !== null)) throw new Error("journal anchors require a scan from the start");
  const checkAnchors = () => {
    for (const anchor of anchors.get(count) ?? []) {
      if ((anchor.chain_tip !== undefined && anchor.chain_tip !== tip) ||
          (anchor.byte_length !== undefined && anchor.byte_length !== offset) ||
          (anchor.last_t !== undefined && anchor.last_t !== lastTime)) {
        throw new Error(`${anchor.label} journal anchor does not match event ${count}`);
      }
    }
    anchors.delete(count);
    if (frozen && count === frozen.event_count &&
        sealRecordHash(tip, input.format_version, frozen.text_binding,
          { duration_ms: frozen.duration_ms, parent_record: frozen.parent_record }) !== frozen.record_hash) {
      throw new Error("frozen record hash does not match its journal prefix");
    }
  };
  checkAnchors();
  if (![count, offset, maxCount].every((n) => Number.isSafeInteger(n) && n >= 0)) throw new Error("invalid journal prefix cursor");
  if (count > maxCount || (count > 0 && !tip)) throw new Error("invalid journal chain cursor");
  for await (const item of journalEvents(input.journal_path, { startByte: offset, endByte: input.end_byte })) {
    if (count === maxCount) break;
    const { event } = item;
    if (event.seq !== count || event.t < lastTime) throw new Error(`journal sequence or time is invalid at event ${count}`);
    tip = advanceEventHash(tip, event, input.session_id, input.format_version);
    count += 1;
    lastTime = event.t;
    offset = item.endByte;
    checkAnchors();
    tail.push(event);
    if (tail.length > 256) tail.shift();
  }
  if (input.event_count !== undefined && count !== maxCount) throw new Error("journal is shorter than the immutable event prefix");
  if (anchors.size) throw new Error("journal is shorter than a persisted anchor");
  if (frozen && count !== frozen.event_count) throw new Error("frozen record does not match its journal event count");
  if (input.repair_tail) {
    const size = (await stat(input.journal_path)).size;
    if (size !== offset) await truncate(input.journal_path, offset);
  }
  return { event_count: count, chain_tip: tip, byte_length: offset, last_t: lastTime, tail };
}

export async function buildJournalManifest(input) {
  const scan = await inspectJournal(input);
  if (!scan.event_count || !scan.chain_tip) throw new Error("cannot sign an empty journal");
  const version = input.format_version;
  const finalText = typeof input.final_text === "string" ? input.final_text : null;
  const binding = finalText !== null && canonicalizeTextForBinding(finalText).length
    ? createTextBinding(finalText, input.session_id) : undefined;
  if (version === "0.1" && binding) throw new Error("format 0.1 does not support text binding");
  const duration = input.duration_ms ?? scan.last_t;
  if (!Number.isSafeInteger(duration) || duration < scan.last_t) throw new Error("finish time precedes the captured prefix");
  const parent = input.parent_record ?? null;
  const manifest = {
    format_version: version,
    record_hash: sealRecordHash(scan.chain_tip, version, binding, { duration_ms: duration, parent_record: parent }),
    session_id: input.session_id,
    producer: input.producer,
    capture_context: input.capture_context ?? null,
    ...(binding ? { text_binding: binding } : {}),
    event_count: scan.event_count,
    duration_ms: duration,
    created_client_t: input.created_client_t,
    ingested_server_t: null,
    parent_record: parent,
    attestations: [],
  };
  const errors = validateManifest(manifest);
  if (errors.length) throw new Error(`generated manifest is invalid: ${errors.join("; ")}`);
  return { manifest, byte_length: scan.byte_length, chain_tip: scan.chain_tip };
}

async function requestJson(base, route, body) {
  const response = await fetch(`${base.replace(/\/$/, "")}${route}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  let data;
  try { data = await response.json(); } catch { throw new Error(`upload returned invalid JSON (HTTP ${response.status})`); }
  if (!response.ok) {
    const error = new Error(`upload failed (HTTP ${response.status})`);
    error.code = typeof data.error === "string" ? data.error : undefined;
    throw error;
  }
  return data;
}

export async function publishJournal(input) {
  const { manifest, upload_id, observation } = input;
  const begun = await requestJson(input.api_base_url, "/api/record-uploads", { upload_id, manifest, ...(observation ? { observation } : {}) });
  if (begun.upload_id !== upload_id) throw new Error("server returned a different upload capability");
  const validateResponse = (response) => validateUploadResponse(response, manifest.record_hash);
  if (begun.completed) return validateResponse(begun.completed);
  const next = begun.next_seq;
  if (!Number.isSafeInteger(next) || next < 0 || next > manifest.event_count) throw new Error("server returned an invalid upload cursor");
  const chunkSize = Math.min(4096, begun.max_chunk_events ?? 4096);
  if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new Error("server returned an invalid chunk size");
  const verifier = new EventStreamVerifier(manifest);
  let events = [], start = next, seen = 0;
  const flush = async () => {
    if (!events.length) return;
    const reply = await requestJson(input.api_base_url, `/api/record-uploads/${upload_id}/chunks`, { start_seq: start, events });
    const expected = start + events.length;
    if (reply.upload_id !== upload_id || reply.next_seq !== expected) throw new Error("server acknowledged an unexpected event prefix");
    start = expected;
    events = [];
  };
  for await (const { event } of journalEvents(input.journal_path, { endByte: input.end_byte })) {
    if (seen >= manifest.event_count) throw new Error("frozen journal contains events beyond its prefix");
    verifier.append(event);
    seen += 1;
    if (event.seq >= next) {
      events.push(event);
      if (events.length === chunkSize) await flush();
    }
  }
  const verified = verifier.finish();
  if (!verified.valid) throw new Error(`frozen journal failed verification: ${verified.errors.join("; ")}`);
  await flush();
  const response = await requestJson(input.api_base_url, `/api/record-uploads/${upload_id}/finalize`, {});
  return validateResponse(response);
}

function parseRecoveryJson(json, label) {
  try { return JSON.parse(json); }
  catch { throw new Error(`${label} is not valid JSON`); }
}

const RECOVERY_FIELDS = [
  "session_id", "capture_enabled", "session_start_ms", "format_version", "parent_record",
  "storage_version", "event_count", "journal_bytes", "frozen_byte_length", "upload_id",
  "pending_gap", "uploaded_response", "uploaded_at_ms", "signed_duration_ms", "save_failure",
  "chain_tip", "chain_tip_event_count", "chain_tip_byte_offset", "chain_tip_last_time", "observation",
];

// Read legacy arrays in the worker, never into the editor's live recovery state.
export async function readRecoveryState(path, { skipPaused = false } = {}) {
  const source = parseRecoveryJson(await readFile(path, "utf8"), "recovery metadata");
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("invalid recovery metadata");
  if (skipPaused && source.capture_enabled === false) return { capture_enabled: false };
  const state = Object.fromEntries(RECOVERY_FIELDS.filter((key) => Object.hasOwn(source, key)).map((key) => [key, source[key]]));
  if (state.storage_version !== 2) {
    if (!Array.isArray(source.events)) throw new Error("legacy recovery has no event array");
    state.legacy_event_count = source.events.length;
  }
  // Old frozen envelopes can contain the entire event array too. Only the
  // manifest and observation are recovery metadata; events are verified below.
  if (source.frozen_record) {
    state.frozen_record = JSON.stringify({ manifest: parseRecoveryJson(source.frozen_record, "frozen record")?.manifest });
  }
  if (source.frozen_upload) {
    state.frozen_upload = JSON.stringify({ observation: parseRecoveryJson(source.frozen_upload, "frozen upload")?.observation });
  }
  // Valid recovery metadata is small even after years of capture. Reject
  // malformed oversized metadata before it can stall Emacs's JSON parser.
  if (Buffer.byteLength(JSON.stringify(state)) > 1024 * 1024) throw new Error("recovery metadata exceeds its size limit");
  return state;
}

async function inspectRecovery(input) {
  if (!input.legacy_state_path) return inspectJournal(input);
  const state = parseRecoveryJson(await readFile(input.legacy_state_path, "utf8"), "legacy recovery metadata");
  if (state.session_id !== input.session_id || state.format_version !== input.format_version ||
      !Array.isArray(state.events) || state.events.length !== input.acknowledged_event_count) {
    throw new Error("legacy recovery metadata changed during verification");
  }
  // Verify the complete migration before replacing any existing journal. The
  // metadata stays legacy until Emacs durably installs the verified cursor.
  const temporary = `${input.journal_path}.migrating`;
  let file;
  try {
    await rm(temporary, { force: true });
    file = await open(temporary, "wx", 0o600);
    let batch = "";
    for (const event of state.events) {
      batch += `${JSON.stringify(event)}\n`;
      if (batch.length >= 65536) { await file.writeFile(batch); batch = ""; }
    }
    if (batch) await file.writeFile(batch);
    await file.sync();
    await file.close(); file = undefined;
    const scan = await inspectJournal({ ...input, journal_path: temporary, repair_tail: false });
    await rename(temporary, input.journal_path);
    return scan;
  } finally {
    if (file) await file.close();
    await rm(temporary, { force: true });
  }
}

export async function runJournalOperation(input) {
  switch (input.operation) {
    case "read-recovery": return readRecoveryState(input.state_path, { skipPaused: input.skip_paused === true });
    case "inspect": return inspectRecovery(input);
    case "truncate": await truncate(input.journal_path, input.byte_length); return { ok: true };
    case "manifest": return buildJournalManifest(input);
    case "publish": {
      try { return await publishJournal(input); }
      catch (error) { return { error: { code: error.code ?? "upload_error", message: error.message } }; }
    }
    case "export": {
      const built = await buildJournalManifest(input);
      const events = [];
      for await (const { event } of journalEvents(input.journal_path, { endByte: built.byte_length })) events.push(event);
      return { record: { manifest: built.manifest, events } };
    }
    default: throw new Error("unknown journal operation");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let input;
  try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { process.stderr.write("journal helper input is not valid JSON\n"); process.exit(1); }
  try { process.stdout.write(`${JSON.stringify(await runJournalOperation(input))}\n`); }
  catch (error) {
    // Never echo input: it may contain a transient binding selection.
    process.stderr.write(`${error.code ?? "journal_error"}: ${error.message}\n`);
    process.exit(1);
  }
}
