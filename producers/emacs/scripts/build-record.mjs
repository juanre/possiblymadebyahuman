#!/usr/bin/env node
import { stdin, stdout, stderr, exit } from "node:process";

import {
  FORMAT_VERSION,
  computeFinalTextMetadata,
  computeRecordHash,
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
  if (typeof input.final_text !== "string") fail("final_text must be a local string");
  if (typeof input.session_id !== "string") fail("session_id must be a string");

  const events = input.events;
  const finalText = input.final_text;
  const metadata = computeFinalTextMetadata(finalText);
  const recordHash = computeRecordHash(events, input.session_id, input.format_version ?? FORMAT_VERSION);

  const record = {
    manifest: {
      format_version: FORMAT_VERSION,
      record_hash: recordHash,
      session_id: input.session_id,
      producer: input.producer ?? {
        id: "emacs",
        version: "0.1.0",
        capabilities: ["timing", "pause_fidelity"],
      },
      capture_context: input.capture_context ?? null,
      event_count: events.length,
      duration_ms: Math.max(0, Number(input.duration_ms ?? events.at(-1)?.t ?? 0)),
      final_text_hash: metadata.finalTextHash,
      final_text_length: metadata.finalTextLength,
      created_client_t: input.created_client_t ?? new Date().toISOString(),
      ingested_server_t: null,
      parent_record: null,
      attestations: [],
    },
    events,
  };

  const replayInsertions = input.replay_insertions_by_seq;
  const verification = verifyRecord(
    record,
    replayInsertions && typeof replayInsertions === "object"
      ? { getInsertedText: (event) => replayInsertions[String(event.seq)] ?? "" }
      : undefined,
  );

  if (!verification.valid) fail("generated record failed verification", verification.errors);

  stdout.write(JSON.stringify({ record, verification }) + "\n");
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
