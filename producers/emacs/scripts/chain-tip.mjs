#!/usr/bin/env node
// Computes the public hash-chain tip of a session's event prefix for a
// server-observed checkpoint. Input on stdin: {session_id, format_version,
// events}. Output: {event_count, chain_tip}. Nothing else is accepted, so no
// text can reach this helper, and nothing from the input is echoed back.
import { stdin, stdout, stderr, exit } from "node:process";

import { FORMAT_VERSION, FORMAT_VERSIONS, computeEventHashChain } from "../../../packages/format/src/index.ts";

const ACCEPTED_FIELDS = new Set(["session_id", "format_version", "events"]);

async function readStdin() {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function fail(message) {
  stderr.write(`${message}\n`);
  exit(1);
}

function parseInput(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return fail("stdin is not valid JSON");
  }
}

try {
  const input = parseInput(await readStdin());
  if (typeof input !== "object" || input === null || Array.isArray(input)) fail("input must be an object");
  const unexpected = Object.keys(input).filter((key) => !ACCEPTED_FIELDS.has(key));
  if (unexpected.length > 0) fail(`unexpected field ${unexpected.join(", ")}`);
  if (typeof input.session_id !== "string") fail("session_id must be a string");
  if (!Array.isArray(input.events) || input.events.length === 0) fail("events must be a non-empty array");
  const formatVersion = input.format_version ?? FORMAT_VERSION;
  if (!FORMAT_VERSIONS.includes(formatVersion)) fail("format_version is not supported");

  const chain = computeEventHashChain(input.events, input.session_id, formatVersion);
  stdout.write(JSON.stringify({ event_count: input.events.length, chain_tip: chain.at(-1) }) + "\n");
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
