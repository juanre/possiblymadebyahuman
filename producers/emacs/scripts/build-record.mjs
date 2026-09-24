#!/usr/bin/env node
import { stdin, stdout, stderr, exit } from "node:process";
import { runJournalOperation } from "./event-journal.mjs";

import {
  FORMAT_VERSION,
  FORMAT_VERSION_0_2,
  FORMAT_VERSION_0_3,
  canonicalizeTextForBinding,
  computeRecordHash,
  createTextBinding,
  verifyRecord,
} from "../../../packages/format/src/index.ts";

async function readStdin() {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function fail(message, details = []) {
  stderr.write(`${message}${details.length > 0 ? `: ${details.join("; ")}` : ""}\n`);
  exit(1);
}

function parseInput(raw) {
  // The parser's own message can quote the offending input, which may be the
  // transient final text; report only that the input was not valid JSON.
  try {
    return JSON.parse(raw);
  } catch {
    return fail("stdin is not valid JSON");
  }
}

try {
  const raw = await readStdin();
  const input = parseInput(raw);
  // Existing user configurations name this script explicitly. Delegate new
  // journal descriptors; the array branch below is only the legacy CLI export.
  if (typeof input.journal_path === "string" || input.operation === "read-recovery") {
    stdout.write(JSON.stringify(await runJournalOperation(input)) + "\n");
    exit(0);
  }

  if (!Array.isArray(input.events)) fail("events must be an array");
  if (typeof input.session_id !== "string") fail("session_id must be a string");

  const events = input.events;

  // `final_text` is accepted transiently SOLELY to compute the content-blind
  // text binding locally (SOT 3.10 local-transient-compute exception). It is
  // never echoed into the output, logged, persisted, or uploaded; only the
  // sealed {scheme, canonical_length, commitment} object survives.
  const finalText = typeof input.final_text === "string" ? input.final_text : null;
  const textBinding =
    finalText !== null && canonicalizeTextForBinding(finalText).length > 0
      ? createTextBinding(finalText, input.session_id)
      : undefined;

  // An explicit version is authoritative, including frozen legacy retries.
  const formatVersion = input.format_version ?? (textBinding ? FORMAT_VERSION_0_2 : FORMAT_VERSION);
  if (formatVersion === "0.1" && textBinding) fail("format 0.1 does not support text binding");
  const duration = Math.max(0, Number(input.duration_ms ?? events.at(-1)?.t ?? 0));
  const parentRecord = input.parent_record ?? null;
  const recordHash = computeRecordHash(events, input.session_id, formatVersion, textBinding,
    formatVersion === FORMAT_VERSION_0_3 ? { duration_ms: duration, parent_record: parentRecord } : undefined);

  const record = {
    manifest: {
      format_version: formatVersion,
      record_hash: recordHash,
      session_id: input.session_id,
      producer: input.producer ?? {
        id: "emacs",
        version: "0.1.0",
        capabilities: ["timing", "pause_fidelity"],
      },
      capture_context: input.capture_context ?? null,
      ...(textBinding ? { text_binding: textBinding } : {}),
      event_count: events.length,
      duration_ms: duration,
      created_client_t: input.created_client_t ?? new Date().toISOString(),
      ingested_server_t: null,
      parent_record: parentRecord,
      attestations: [],
    },
    events,
  };

  const verification = verifyRecord(record);
  if (!verification.valid) fail("generated record failed verification", verification.errors);

  stdout.write(JSON.stringify({ record, verification }) + "\n");
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
