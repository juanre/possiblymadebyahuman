#!/usr/bin/env node
// Full-scale native evidence, deliberately separate from the quick test suite.
import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdtemp, writeFile, readFile, stat, rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const events = Number(process.argv[2] ?? 4_000_000);
const appendCount = Number(process.argv[3] ?? 400);
const twoYears = 2 * 365 * 24 * 60 * 60 * 1000;
const directory = await mkdtemp(join(tmpdir(), "pmbah-emacs-scale-"));
const sessionIds = ["00000000-0000-4000-8000-000000000071", "00000000-0000-4000-8000-000000000072"];
try {
  for (const [index, count] of [100, events].entries()) {
    const id = sessionIds[index];
    const path = join(directory, `events-${id}.jsonl`);
    const output = createWriteStream(path, { mode: 0o600 });
    for (let start = 0; start < count; start += 4096) {
      let block = "";
      for (let seq = start; seq < Math.min(start + 4096, count); seq += 1) {
        block += JSON.stringify({ seq, t: Math.floor(seq * twoYears / Math.max(1, count - 1)), op: "insert", pos: seq, del_len: 0, ins_len: 1, source: "typing" }) + "\n";
      }
      if (!output.write(block)) await once(output, "drain");
    }
    output.end();
    await once(output, "finish");
    await writeFile(join(directory, `session-${id}.json`), JSON.stringify({
      storage_version: 2, session_id: id, session_start_ms: Date.now() - twoYears,
      format_version: "0.3", event_count: count, journal_bytes: (await stat(path)).size,
      observation: { state: "disabled", committed_event_count: 0, commitments: [] },
    }), { mode: 0o600 });
  }
  const resultsPath = join(directory, "results.json");
  const scriptPath = join(directory, "benchmark.el");
  await writeFile(scriptPath, `;;; benchmark.el -*- lexical-binding: t; -*-
(load ${JSON.stringify(resolve("producers/emacs/pmbah-mode.el"))})
(setq pmbah--background-persistence t pmbah-observe-process nil pmbah-state-directory ${JSON.stringify(directory)})
(let (results)
  (dolist (id '${JSON.stringify(sessionIds).replaceAll('[', '(').replaceAll(']', ')').replaceAll(',', ' ')})
    (with-temp-buffer
      (insert (make-string (if (equal id (car '${JSON.stringify(sessionIds).replaceAll('[', '(').replaceAll(']', ')').replaceAll(',', ' ')})) 100 ${events}) ?x))
      (let ((recovery-start (float-time)))
        (pmbah-recover-session (expand-file-name (concat "session-" id ".json") pmbah-state-directory))
        (let* ((recovery-ms (* 1000 (- (float-time) recovery-start)))
               (initial-count pmbah--next-seq)
               (before-bytes pmbah--journal-bytes)
               (write-bytes 0)
               (edit-times nil)
               (writer (symbol-function 'write-region))
               (append-start (float-time)))
          (cl-letf (((symbol-function 'write-region)
                     (lambda (start end &rest arguments)
                       (cl-incf write-bytes (if (stringp start) (string-bytes start)
                                               (string-bytes (buffer-substring-no-properties (or start (point-min)) (or end (point-max))))))
                       (apply writer start end arguments))))
            (dotimes (index ${appendCount})
              (let ((edit-start (float-time)))
                (insert "x")
                (push (* 1000 (- (float-time) edit-start)) edit-times))
              ;; Let the same background pipeline used by interactive Emacs
              ;; acknowledge bounded batches. These waits are not edit latency.
              (when (= (% (1+ index) 64) 0)
                (while (or pmbah--journal-pending pmbah--writer-request)
                  (when pmbah--save-failure (error "%s" pmbah--save-failure))
                  (accept-process-output nil 0.01)))))
          (pmbah--drain-writer)
          (setq edit-times (sort edit-times #'<))
          (let* ((append-ms (* 1000 (- (float-time) append-start)))
                 (payload (append (list :operation "inspect") (pmbah--chain-tip-payload)))
                 (suffix-start (float-time))
                 (suffix (pmbah--journal-helper payload)))
            (unless (= (alist-get 'event_count suffix) pmbah--next-seq) (error "suffix checkpoint count mismatch"))
            (push (list :initial_events initial-count :final_events pmbah--next-seq
                        :buffer_characters (buffer-size)
                        :recovery_ms recovery-ms :append_ms append-ms
                        :foreground_write_bytes write-bytes
                        :edit_p50_ms (nth (/ ${appendCount} 2) edit-times)
                        :edit_p95_ms (nth (floor (* ${appendCount} 0.95)) edit-times)
                        :edit_max_ms (car (last edit-times))
                        :journal_growth (- pmbah--journal-bytes before-bytes)
                        :memory_tail_events (length pmbah--events)
                        :metadata_bytes (file-attribute-size (file-attributes (pmbah--state-file)))
                        :checkpoint_descriptor_bytes (string-bytes (pmbah--json-encode payload))
                        :checkpoint_suffix_events (- pmbah--next-seq pmbah--chain-tip-event-count)
                        :checkpoint_suffix_ms (* 1000 (- (float-time) suffix-start))
                        :last_event_ms (plist-get (car pmbah--events) :t)) results))))))
  (with-temp-file ${JSON.stringify(resultsPath)} (insert (pmbah--json-encode (vconcat (nreverse results))))))
`);
  const child = spawn(process.env.EMACS ?? "emacs", ["--batch", "-Q", "-l", scriptPath], {
    env: { ...process.env, PMBAH_API_BASE_URL: "http://127.0.0.1:9", NODE_OPTIONS: "--max-old-space-size=96" },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const [exitCode] = await once(child, "close");
  assert.equal(exitCode, 0, "native Emacs benchmark failed");
  const results = JSON.parse(await readFile(resultsPath, "utf8"));
  for (const result of results) {
    assert.equal(result.memory_tail_events, 256);
    assert.ok(result.metadata_bytes < 10_000);
    assert.ok(result.checkpoint_descriptor_bytes < 2_000);
    assert.equal(result.checkpoint_suffix_events, appendCount);
    assert.equal(result.buffer_characters, result.initial_events + appendCount);
    assert.ok(result.last_event_ms >= twoYears);
  }
  for (const result of results) {
    assert.equal(result.foreground_write_bytes, 0, "interactive capture wrote to disk on the foreground thread");
  }
  process.stdout.write(`${JSON.stringify({ event_count: events, node_heap_limit_mb: 96, append_count: appendCount, results }, null, 2)}\n`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
