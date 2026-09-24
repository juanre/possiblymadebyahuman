#!/usr/bin/env node
// Computes the public hash-chain tip of a session's event prefix for a
// server-observed checkpoint. Normal input is a private journal descriptor with
// a cached tip/count/byte cursor; only its new numeric suffix is read. Legacy
// array input remains for older installations. Output contains only the public
// tip/count and the new private cursor, never document text.
import { stdin, stdout, stderr, exit } from "node:process";
import { inspectJournal } from "./event-journal.mjs";

import {
  FORMAT_VERSION,
  FORMAT_VERSIONS,
  advanceEventHash,
  isB3Hash,
  validateEvent,
} from "../../../packages/format/src/index.ts";

const ACCEPTED_FIELDS = new Set(["session_id", "format_version", "events", "previous_chain_tip", "previous_event_count", "journal_path", "event_count", "end_byte", "previous_byte_offset", "previous_t"]);

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

// Array input remains only for older producer installations using this helper.
function advanceChain(previousTip, events, previousEventCount, sessionId, formatVersion) {
  let tip = previousTip;
  let lastTime = null;
  events.forEach((event, index) => {
    const errors = validateEvent(event, previousEventCount + index);
    if (errors.length > 0) fail(`event ${previousEventCount + index} is invalid: ${errors.join("; ")}`);
    if (lastTime !== null && event.t < lastTime) fail("event times must be nondecreasing");
    tip = advanceEventHash(tip, event, sessionId, formatVersion);
    lastTime = event.t;
  });
  return tip;
}

try {
  const input = parseInput(await readStdin());
  if (typeof input !== "object" || input === null || Array.isArray(input)) fail("input must be an object");
  const unexpected = Object.keys(input).filter((key) => !ACCEPTED_FIELDS.has(key));
  if (unexpected.length > 0) fail(`unexpected field ${unexpected.join(", ")}`);
  if (typeof input.journal_path === "string") {
    const result = await inspectJournal(input);
    stdout.write(JSON.stringify({ event_count: result.event_count, chain_tip: result.chain_tip, byte_length: result.byte_length, last_t: result.last_t }) + "\n");
    exit(0);
  }
  if (typeof input.session_id !== "string") fail("session_id must be a string");
  if (!Array.isArray(input.events) || input.events.length === 0) fail("events must be a non-empty array");
  const formatVersion = input.format_version ?? FORMAT_VERSION;
  if (!FORMAT_VERSIONS.includes(formatVersion)) fail("format_version is not supported");

  const hasPreviousTip = input.previous_chain_tip !== undefined && input.previous_chain_tip !== null;
  const hasPreviousCount = input.previous_event_count !== undefined && input.previous_event_count !== null;
  if (hasPreviousTip !== hasPreviousCount) fail("previous_chain_tip and previous_event_count must be given together");

  if (hasPreviousTip) {
    if (!isB3Hash(input.previous_chain_tip)) fail("previous_chain_tip must be a b3: hash");
    if (!Number.isInteger(input.previous_event_count) || input.previous_event_count < 1) {
      fail("previous_event_count must be an integer >= 1");
    }
    if (input.events[0].seq !== input.previous_event_count) {
      fail(`previous_event_count ${input.previous_event_count} does not match the first event seq ${input.events[0].seq}`);
    }
    const chainTip = advanceChain(input.previous_chain_tip, input.events, input.previous_event_count, input.session_id, formatVersion);
    stdout.write(JSON.stringify({ event_count: input.previous_event_count + input.events.length, chain_tip: chainTip }) + "\n");
  } else {
    const chainTip = advanceChain(null, input.events, 0, input.session_id, formatVersion);
    stdout.write(JSON.stringify({ event_count: input.events.length, chain_tip: chainTip }) + "\n");
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
