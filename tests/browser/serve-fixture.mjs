import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { computeRecordHash, createTextBinding } from "../../packages/format/src/index.ts";
import { BOUND_TEXT } from "./bound-fixture-text.mjs";

const rootDir = fileURLToPath(new URL("../..", import.meta.url));
const webDistDir = join(rootDir, "apps/web/dist");
const extensionDistDir = join(rootDir, "apps/browser-extension/dist");
const goldenPath = join(rootDir, "packages/conformance/vectors/golden-records.json");

const port = Number(process.env.PMBAH_FIXTURE_PORT ?? 4173);
const fixtureSlug = process.env.PMBAH_FIXTURE_SLUG ?? "smoke";
// An address with no record behind it.
const UNKNOWN_SLUG = "unknown";

const [golden] = JSON.parse(await readFile(goldenPath, "utf8"));
const record = JSON.parse(JSON.stringify(golden.record));

const captureContext = {
  surface: "browser",
  label: "Smoke test record",
  browser: {
    url: "https://example.test/thread/123",
    title: "Smoke Test Page Title",
    field_kind: "textarea",
  },
  emacs: {
    buffer_name: "smoke.md",
    major_mode: "markdown-mode",
  },
};
record.manifest.capture_context = captureContext;
record.manifest.ingested_server_t = "2026-05-28T00:00:00.000Z";

const stats = {
  record_hash: record.manifest.record_hash,
  event_count: 4,
  duration_ms: 240,
  observed_final_length: 8,
  insert_op_count: 3,
  delete_op_count: 1,
  replace_op_count: 0,
  typed_event_count: 2,
  paste_event_count: 1,
  cut_event_count: 1,
  drop_event_count: 0,
  ime_event_count: 0,
  autocomplete_event_count: 0,
  programmatic_event_count: 0,
  unknown_source_count: 0,
  inserted_codepoints_total: 9,
  deleted_codepoints_total: 1,
  largest_atomic_insert_codepoints: 6,
  inter_event_delay_min_ms: 60,
  inter_event_delay_p50_ms: 60,
  inter_event_delay_p90_ms: 120,
  inter_event_delay_p95_ms: 120,
  inter_event_delay_p99_ms: 120,
  inter_event_delay_max_ms: 120,
  active_time_ms: 240,
  idle_time_ms: 0,
  long_pause_count: 0,
  delay_histogram: [],
};

const signals = [
  {
    analyzer_id: "timing-distribution",
    analyzer_version: "0.1.0",
    applicable: true,
    measures: [
      { key: "event_count", value: 4 },
      { key: "interval_count", value: 3 },
      { key: "inter_event_delay_p50_ms", value: 60, unit: "ms" },
      { key: "inter_event_delay_max_ms", value: 120, unit: "ms" },
      { key: "long_pause_count", value: 0 },
    ],
    explanation:
      "Measured 3 inter-event intervals. Long pauses are intervals at or above 30000ms; the longest interval was 120ms, with 0 long pause(s).",
  },
  {
    analyzer_id: "edit-topology",
    analyzer_version: "0.1.0",
    applicable: true,
    measures: [
      { key: "event_count", value: 4 },
      { key: "small_edit_count", value: 3 },
      { key: "atomic_insert_max_len", value: 6, unit: "codepoints" },
      { key: "deletion_count", value: 1 },
    ],
    explanation:
      "Measured edit topology over 4 mutation event(s): 3 small edit(s), 0 large atomic insert(s), largest insert 6 codepoint(s), and 1 deletion event(s) across 1 deletion cluster(s). Deleted codepoints are reported as a revision/dead-end indicator, not a verdict. Source attribution is present: typing=2, paste=1, cut=1.",
  },
];

const observation = {
  state: "observed",
  observed_session_id: "00000000-0000-4000-8000-0000aaaaaaaa",
  commitments: [
    {
      checkpoint_id: "cp-1",
      event_count: 1,
      chain_tip: "b3:7c4a000000000000000000000000000000000000000000000000000000000abc",
      observed_at: "2026-05-28T14:02:11.000Z",
    },
    {
      checkpoint_id: "cp-2",
      event_count: 2,
      chain_tip: "b3:5183000000000000000000000000000000000000000000000000000000000def",
      observed_at: "2026-05-28T14:09:42.000Z",
    },
    {
      checkpoint_id: "cp-3",
      event_count: 3,
      chain_tip: "b3:2bd0000000000000000000000000000000000000000000000000000000000123",
      observed_at: "2026-05-28T14:18:03.000Z",
    },
    {
      checkpoint_id: "cp-4",
      event_count: 4,
      chain_tip: record.manifest.record_hash,
      observed_at: "2026-05-28T14:34:55.000Z",
    },
  ],
  checkpoint_count: 4,
  first_observed_at: "2026-05-28T14:02:11.000Z",
  last_observed_at: "2026-05-28T14:34:55.000Z",
  server_observed_span_ms: 1_964_000,
};

const fixtureRecord = { manifest: record.manifest, events: record.events, stats, signals, observation };

// /api/records/tampered: the same record with one event altered after signing,
// so the browser's recomputed hash no longer matches manifest.record_hash.
const tamperedEvents = JSON.parse(JSON.stringify(record.events));
tamperedEvents[0].ins_len += 1;
const tamperedRecord = {
  manifest: record.manifest,
  events: tamperedEvents,
  stats,
  signals,
  observation: {
    state: "not_requested",
    observed_session_id: null,
    commitments: [],
    checkpoint_count: 0,
    first_observed_at: null,
    last_observed_at: null,
    server_observed_span_ms: null,
  },
};

// /api/records/unknownlength: a capture that started inside a non-empty buffer,
// so absolute positions exceed the length inferable from the events alone and
// the observed length is unknown. Observation was requested but never committed.
const unknownSessionId = record.manifest.session_id;
const unknownEvents = [
  { seq: 0, t: 0, op: "insert", pos: 40, del_len: 0, ins_len: 1, source: "typing" },
  { seq: 1, t: 120, op: "insert", pos: 41, del_len: 0, ins_len: 1, source: "typing" },
  { seq: 2, t: 260, op: "insert", pos: 42, del_len: 0, ins_len: 24, source: "paste" },
  { seq: 3, t: 400, op: "delete", pos: 60, del_len: 2, ins_len: 0, source: "typing" },
];
const unknownManifest = {
  ...record.manifest,
  format_version: "0.2",
  parent_record: record.manifest.record_hash,
  capture_context: { surface: "emacs", label: "essay.md", emacs: { buffer_name: "essay.md", major_mode: "markdown-mode" } },
  event_count: unknownEvents.length,
  duration_ms: 400,
  record_hash: computeRecordHash(unknownEvents, unknownSessionId, "0.2"),
};
delete unknownManifest.text_binding;
const unknownRecord = {
  manifest: unknownManifest,
  events: unknownEvents,
  stats: { ...stats, record_hash: unknownManifest.record_hash, event_count: 4, duration_ms: 400, observed_final_length: null, paste_event_count: 1, cut_event_count: 0, largest_atomic_insert_codepoints: 24 },
  signals,
  observation: {
    state: "unobserved",
    observed_session_id: null,
    commitments: [],
    checkpoint_count: 0,
    first_observed_at: null,
    last_observed_at: null,
    server_observed_span_ms: null,
  },
};

// A second fixture served at /api/records/bound: a format 0.2 record that
// actually carries a text binding, so the record-page checker has a real
// commitment to verify against. record_hash is resealed over the binding so
// the chain still verifies in the browser.
const boundSessionId = record.manifest.session_id;
const boundBinding = createTextBinding(BOUND_TEXT, boundSessionId);

// A richer synthetic process for the demo so the writing-rhythm fingerprint has
// real shape: a typing cadence (~60-200ms gaps), a couple of pastes, small
// thinking gaps, and two long pauses (8s, 45s) to exercise the log-scale tail.
// Deterministic (no randomness) so the fixture is stable.
const typingGaps = [70, 95, 120, 80, 150, 60, 110, 90, 200, 75, 130, 85, 160, 100];
const boundEvents = [];
let bt = 0;
let bpos = 0;
for (let i = 0; i < 64; i += 1) {
  let gap = typingGaps[i % typingGaps.length];
  if (i === 21) gap = 45_000;
  else if (i === 44) gap = 8_000;
  else if (i === 6 || i === 33) gap = 1_500;
  if (i > 0) bt += gap;
  const paste = i === 12 || i === 50;
  const insLen = paste ? 38 : 1;
  boundEvents.push({ seq: i, t: bt, op: "insert", pos: bpos, del_len: 0, ins_len: insLen, source: paste ? "paste" : "typing" });
  bpos += insLen;
}
const boundDelays = boundEvents.slice(1).map((event, index) => event.t - boundEvents[index].t);
const sortedDelays = [...boundDelays].sort((a, b) => a - b);
const percentile = (p) => sortedDelays.length === 0 ? null : sortedDelays[Math.min(sortedDelays.length - 1, Math.floor((p / 100) * sortedDelays.length))];
const boundManifest = {
  ...record.manifest,
  format_version: "0.2",
  text_binding: boundBinding,
  event_count: boundEvents.length,
  duration_ms: boundEvents[boundEvents.length - 1].t,
  record_hash: computeRecordHash(boundEvents, boundSessionId, "0.2", boundBinding),
};
const boundStats = {
  ...stats,
  record_hash: boundManifest.record_hash,
  event_count: boundEvents.length,
  duration_ms: boundManifest.duration_ms,
  observed_final_length: bpos,
  insert_op_count: boundEvents.length,
  delete_op_count: 0,
  replace_op_count: 0,
  typed_event_count: boundEvents.filter((event) => event.source === "typing").length,
  paste_event_count: boundEvents.filter((event) => event.source === "paste").length,
  cut_event_count: 0,
  inserted_codepoints_total: bpos,
  largest_atomic_insert_codepoints: 38,
  inter_event_delay_min_ms: sortedDelays[0] ?? null,
  inter_event_delay_p50_ms: percentile(50),
  inter_event_delay_p90_ms: percentile(90),
  inter_event_delay_p95_ms: percentile(95),
  inter_event_delay_p99_ms: percentile(99),
  inter_event_delay_max_ms: sortedDelays[sortedDelays.length - 1] ?? null,
  active_time_ms: boundDelays.filter((delay) => delay < 30_000).reduce((sum, delay) => sum + delay, 0),
  idle_time_ms: boundDelays.filter((delay) => delay >= 30_000).reduce((sum, delay) => sum + delay, 0),
  long_pause_count: boundDelays.filter((delay) => delay >= 30_000).length,
};
const boundObservation = {
  ...observation,
  commitments: observation.commitments.map((commitment) =>
    commitment.event_count === 4
      ? { ...commitment, event_count: boundEvents.length, chain_tip: boundManifest.record_hash }
      : commitment,
  ),
};
const boundRecord = { manifest: boundManifest, events: boundEvents, stats: boundStats, signals, observation: boundObservation };

// Optional: serve a real fetched record (content-blind public JSON) at
// /api/records/real for local design review. Inert unless PMBAH_REAL_RECORD is set.
let realRecord = null;
if (process.env.PMBAH_REAL_RECORD) {
  try {
    realRecord = JSON.parse(await readFile(process.env.PMBAH_REAL_RECORD, "utf8"));
  } catch {
    realRecord = null;
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname.startsWith("/api/records/")) {
      const requestedSlug = url.pathname.slice("/api/records/".length);
      if (requestedSlug === UNKNOWN_SLUG) {
        res.statusCode = 404;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.setHeader("cache-control", "no-store");
        res.end(JSON.stringify({ error: "record_not_found" }));
        return;
      }
      const body = requestedSlug === "bound"
        ? boundRecord
        : requestedSlug === "tampered"
        ? tamperedRecord
        : requestedSlug === "unknownlength"
        ? unknownRecord
        : requestedSlug === "real" && realRecord
        ? realRecord
        : fixtureRecord;
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.end(JSON.stringify(body));
      return;
    }

    // A plain page hosting the built content script as Chrome would inject it
    // (a classic script), with chrome.runtime stubbed to record what the script
    // sends. Lets the browser suite drive real key events through the capture code.
    if (url.pathname === "/extension-harness") {
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.end(EXTENSION_HARNESS_HTML);
      return;
    }
    if (url.pathname === "/extension/content.js") {
      await serveFile(res, join(extensionDistDir, "content.js"));
      return;
    }

    if (url.pathname.startsWith("/record-assets/")) {
      const relative = url.pathname.replace(/^\/record-assets\//, "");
      await serveFile(res, join(webDistDir, normalize(relative).replace(/^(\.\.[/\\])+/, "")));
      return;
    }

    if (url.pathname === "/favicon.ico") {
      res.statusCode = 404;
      res.end();
      return;
    }

    // Like the production server, an address with no record gets the app shell
    // with a 404 status.
    await serveFile(res, join(webDistDir, "index.html"), url.pathname === `/${UNKNOWN_SLUG}` ? 404 : 200);
  } catch (error) {
    res.statusCode = 500;
    res.end(String(error));
  }
});

async function serveFile(res, path, status = 200) {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("not a file");
    res.statusCode = status;
    res.setHeader("content-type", contentType(path));
    res.setHeader("cache-control", "no-store");
    createReadStream(path).pipe(res);
  } catch {
    res.statusCode = 404;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("not_found");
  }
}

function contentType(path) {
  switch (extname(path)) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    default: return "application/octet-stream";
  }
}

const EXTENSION_HARNESS_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>extension harness</title></head>
<body>
<textarea id="plain" aria-label="plain field"></textarea>
<div id="rich" contenteditable="true" aria-label="rich field" style="min-height:2em;border:1px solid #999"></div>
<script>
  window.__pmbah = { messages: [] };
  window.chrome = {
    runtime: {
      id: "harness",
      onMessage: { addListener() {} },
      async sendMessage(message) {
        window.__pmbah.messages.push(message);
        if (message.kind === "register_field") {
          return { kind: "register_field_result", result: { kind: "registered", session_id: "00000000-0000-4000-8000-00000000c0de", certainty: "fresh" } };
        }
        if (message.kind === "append_mutation") return { kind: "append_mutation_result" };
        return { kind: "error", reason: "unexpected " + message.kind };
      },
    },
  };
</script>
<script src="/extension/content.js"></script>
</body></html>`;

server.listen(port, "127.0.0.1", () => {
  console.log(`fixture server listening on http://127.0.0.1:${port} (slug=${fixtureSlug})`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
