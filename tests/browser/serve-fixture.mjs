import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../..", import.meta.url));
const webDistDir = join(rootDir, "apps/web/dist");
const goldenPath = join(rootDir, "packages/conformance/vectors/golden-records.json");

const port = Number(process.env.PMBAH_FIXTURE_PORT ?? 4173);
const fixtureSlug = process.env.PMBAH_FIXTURE_SLUG ?? "smoke";

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
  final_text_length: 8,
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

const fixtureRecord = { manifest: record.manifest, events: record.events, stats, signals };

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname.startsWith("/api/records/")) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify(fixtureRecord));
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

    await serveFile(res, join(webDistDir, "index.html"));
  } catch (error) {
    res.statusCode = 500;
    res.end(String(error));
  }
});

async function serveFile(res, path) {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("not a file");
    res.statusCode = 200;
    res.setHeader("content-type", contentType(path));
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

server.listen(port, "127.0.0.1", () => {
  console.log(`fixture server listening on http://127.0.0.1:${port} (slug=${fixtureSlug})`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
