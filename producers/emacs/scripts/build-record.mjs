#!/usr/bin/env node
import { stdin, stdout, stderr, exit } from "node:process";

import {
  FORMAT_VERSION,
  FORMAT_VERSION_0_2,
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

try {
  const raw = await readStdin();
  const input = JSON.parse(raw);

  if (!Array.isArray(input.events)) fail("events must be an array");
  if (typeof input.session_id !== "string") fail("session_id must be a string");

  const events = input.events;

  // `final_text` is accepted transiently SOLELY to compute the content-blind
  // text binding locally (SOT 3.10 local-transient-compute exception). It is
  // never echoed into the output, logged, persisted, or uploaded; only the
  // sealed {scheme, policy, canonical_length, commitment} object survives.
  const bindPolicy = input.bind_policy === "exact" ? "exact" : "prefix";
  const finalText = typeof input.final_text === "string" ? input.final_text : null;
  const textBinding =
    finalText !== null && canonicalizeTextForBinding(finalText).length > 0
      ? createTextBinding(finalText, input.session_id, bindPolicy)
      : undefined;

  const formatVersion = textBinding ? FORMAT_VERSION_0_2 : input.format_version ?? FORMAT_VERSION;
  const recordHash = computeRecordHash(events, input.session_id, formatVersion, textBinding);

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
      duration_ms: Math.max(0, Number(input.duration_ms ?? events.at(-1)?.t ?? 0)),
      created_client_t: input.created_client_t ?? new Date().toISOString(),
      ingested_server_t: null,
      parent_record: null,
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
