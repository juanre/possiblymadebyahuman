import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm, stat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { inspectJournal, buildJournalManifest, publishJournal, journalEvents, readRecoveryState } from "../producers/emacs/scripts/event-journal.mjs";
import { computeEventHashChain, computeRecordHash, verifyRecord } from "../packages/format/src/index.ts";

const emacs = spawnSync("sh", ["-c", "command -v emacs"], { encoding: "utf8" }).stdout.trim();
const id = "00000000-0000-4000-8000-000000000091";
const elapsed = 2 * 365 * 24 * 60 * 60 * 1000;
const eventsFor = (count) => Array.from({ length: count }, (_, seq) => ({ seq, t: Math.floor(seq * elapsed / Math.max(1, count - 1)), op: "insert", pos: seq, del_len: 0, ins_len: 1, source: "typing" }));
const serialize = (events) => events.map((event) => `${JSON.stringify(event)}\n`).join("");

test("recovery metadata sent to Emacs excludes embedded histories and is size bounded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pmbah-recovery-metadata-"));
  const path = join(directory, "state.json");
  try {
    const state = { storage_version: 2, session_id: id, events: eventsFor(1000), unexpected: "private-extra",
      frozen_record: JSON.stringify({ manifest: { session_id: id }, events: eventsFor(1000) }),
      frozen_upload: JSON.stringify({ observation: { state: "unobserved" }, events: eventsFor(1000) }) };
    await writeFile(path, JSON.stringify(state));
    const compact = await readRecoveryState(path);
    assert.equal(compact.events, undefined);
    assert.equal(compact.unexpected, undefined);
    assert.deepEqual(JSON.parse(compact.frozen_record), { manifest: { session_id: id } });
    assert.deepEqual(JSON.parse(compact.frozen_upload), { observation: { state: "unobserved" } });
    await writeFile(path, JSON.stringify({ ...state, observation: { token: "x".repeat(1024 * 1024) } }));
    await assert.rejects(readRecoveryState(path), /recovery metadata exceeds its size limit/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("recovery parse errors never quote private metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pmbah-recovery-redaction-"));
  const path = join(directory, "state.json");
  const secret = "PRIVATE-OBSERVATION-TOKEN-CANARY";
  try {
    for (const contents of [secret, JSON.stringify({ storage_version: 2, frozen_record: secret }),
      JSON.stringify({ storage_version: 2, frozen_upload: secret })]) {
      await writeFile(path, contents);
      await assert.rejects(readRecoveryState(path), (error) => {
        assert.equal(error.message.includes(secret), false);
        return /not valid JSON/.test(error.message);
      });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
const descriptor = (path, count) => ({ journal_path: path, session_id: id, format_version: "0.3", event_count: count,
  duration_ms: elapsed, created_client_t: "2024-09-23T00:00:00.000Z", producer: { id: "emacs", version: "0.1.0", capabilities: ["timing", "pause_fidelity"] } });

async function native(directory, program) {
  const script = join(directory, "scenario.el");
  await writeFile(script, `;;; journal-test.el -*- lexical-binding: t; -*-\n(load ${JSON.stringify(resolve("producers/emacs/pmbah-mode.el"))})\n(setq pmbah-observe-process nil pmbah-state-directory ${JSON.stringify(directory)})\n${program}`);
  const result = spawnSync(emacs, ["--batch", "-Q", "-l", script], {
    encoding: "utf8", env: { ...process.env, PMBAH_API_BASE_URL: "http://127.0.0.1:9", NODE_OPTIONS: "--max-old-space-size=96" }, maxBuffer: 1_000_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test("journal recovery keeps complete appends and only repairs an incomplete final line", async () => {
  const temp = await mkdtemp(join(tmpdir(), "pmbah-journal-repair-"));
  try {
    const path = join(temp, "events.jsonl");
    const events = eventsFor(1000);
    const complete = serialize(events);
    await writeFile(path, `${complete}{"seq":1000,"t":`);
    const recovered = await inspectJournal({ ...descriptor(path, 1000), event_count: undefined, repair_tail: true });
    assert.equal(recovered.event_count, 1000);
    assert.equal(recovered.tail.length, 256);
    assert.equal(recovered.tail[0].seq, 744);
    assert.equal(await readFile(path, "utf8"), complete);
    await assert.rejects(inspectJournal({ ...descriptor(path, 1000), repair_tail: true }), /unbounded scan/);
    assert.equal(await readFile(path, "utf8"), complete);
    for (const range of [{ startByte: -1 }, { startByte: 2, endByte: 1 }, { endByte: 0.5 }]) {
      await assert.rejects(async () => { for await (const _ of journalEvents(path, range)) {} }, /byte range/);
    }
    const damaged = `${complete}{"seq":1000,"t":}\n`;
    await writeFile(path, damaged);
    await assert.rejects(inspectJournal({ ...descriptor(path, 1000), event_count: undefined, repair_tail: true }), /invalid complete event/);
    assert.equal(await readFile(path, "utf8"), damaged, "a complete corrupted line is preserved as evidence");
  } finally { await rm(temp, { recursive: true, force: true }); }
});

async function delayedHelper(directory) {
  const helper = join(directory, "delayed-helper.mjs");
  await writeFile(helper, `import { runJournalOperation } from ${JSON.stringify(resolve("producers/emacs/scripts/event-journal.mjs"))};
let raw = ""; for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw);
await new Promise((resolve) => setTimeout(resolve, input.operation === "publish" ? 350 : 200));
const result = input.operation === "publish"
  ? { record_hash: input.manifest.record_hash, short_signature: "async", url: "https://example.test/async", created: true }
  : await runJournalOperation(input);
process.stdout.write(JSON.stringify(result));`);
  return helper;
}

test("native interactive signing keeps other buffers responsive and completes a linked segment", { skip: !emacs }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pmbah-journal-async-"));
  try {
    const helper = await delayedHelper(temp);
    const output = await native(temp, `(with-temp-buffer
      (pmbah-mode 1) (insert "private writing")
      (let ((pmbah-helper-script ${JSON.stringify(helper)}) (started (float-time)) returned locked same-job responsive)
        (pmbah--sign-buffer-async nil t)
        (setq returned (* 1000 (- (float-time) started)) locked buffer-read-only)
        (condition-case nil (pmbah-retry-save) (user-error nil))
        (unless buffer-read-only (error "retry-save unlocked active signing"))
        (dotimes (_ 3)
          (condition-case nil (insert "blocked") (buffer-read-only nil)))
        (unless (= pmbah--next-seq 1) (error "active signing accepted another event"))
        (let ((token (plist-get pmbah--sign-job :token)))
          (condition-case nil (pmbah--sign-buffer-async nil t) (user-error nil))
          (setq same-job (equal token (plist-get pmbah--sign-job :token))))
        (with-temp-buffer (insert "other buffer") (setq responsive (= (buffer-size) 12)))
        (let ((deadline (+ (float-time) 8)))
          (while (and pmbah--sign-job (< (float-time) deadline)) (accept-process-output nil 0.02)))
        (when pmbah--sign-job (error "async signing did not finish"))
        (unless pmbah--parent-record (error "async signing did not publish"))
        (insert "continued")
        (princ (pmbah--json-encode (list :returned_ms returned :locked locked :same_job same-job :responsive responsive
                                        :parent pmbah--parent-record :count pmbah--next-seq :writable (if buffer-read-only :json-false t))))))`);
    assert.ok(output.returned_ms < 200, JSON.stringify(output));
    assert.equal(output.locked, true);
    assert.equal(output.same_job, true);
    assert.equal(output.responsive, true);
    assert.equal(output.writable, true);
    assert.equal(output.count, 1);
    assert.match(output.parent, /^b3:[0-9a-f]{64}$/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("native disabling capture cancels an unfinished manifest without stale callbacks", { skip: !emacs }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pmbah-journal-pause-sign-"));
  try {
    const helper = await delayedHelper(temp);
    const output = await native(temp, `(with-temp-buffer
      (pmbah-mode 1) (insert "captured")
      (setq-local pmbah-helper-script ${JSON.stringify(helper)})
      (pmbah--sign-buffer-async nil t)
      (let ((process (plist-get pmbah--sign-job :process)))
        (pmbah-mode -1)
        (when (process-live-p process) (error "paused capture kept its manifest process"))
        (insert "private")
        (accept-process-output nil 0.3)
        (pmbah-mode 1)
        (insert "resumed")
        (princ (pmbah--json-encode (list :count pmbah--next-seq :job (if pmbah--sign-job t :json-false)
                                        :frozen (if pmbah--frozen-record t :json-false) :last (car pmbah--events))))))`);
    assert.equal(output.count, 2);
    assert.equal(output.job, false);
    assert.equal(output.frozen, false);
    assert.equal(output.last.pos, null);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("native quitting while launching a signing helper releases the unsigned freeze", { skip: !emacs }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pmbah-journal-quit-"));
  try {
    const output = await native(temp, `(with-temp-buffer
      (pmbah-mode 1) (insert "captured")
      (cl-letf (((symbol-function 'process-send-string) (lambda (&rest _) (signal 'quit nil))))
        (condition-case nil (pmbah--sign-buffer-async nil t) (quit nil)))
      (when (seq-some (lambda (process) (and (string-prefix-p "pmbah-node" (process-name process)) (process-live-p process))) (process-list))
        (error "quit left a signing process alive"))
      (insert "continued")
      (princ (pmbah--json-encode (list :job (if pmbah--sign-job t :json-false) :signing (if pmbah--signing t :json-false)
                                      :writable (if buffer-read-only :json-false t) :count pmbah--next-seq))))`);
    assert.deepEqual(output, { job: false, signing: false, writable: true, count: 2 });
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("native quitting at async publication retains the frozen prefix without a stuck job", { skip: !emacs }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pmbah-journal-publish-quit-"));
  try {
    const output = await native(temp, `(with-temp-buffer
      (pmbah-mode 1) (insert "captured")
      (let ((send (symbol-function 'process-send-string)) (calls 0))
        (cl-letf (((symbol-function 'process-send-string)
                   (lambda (&rest args)
                     (if (= (cl-incf calls) 2) (signal 'quit nil) (apply send args)))))
          (pmbah--sign-buffer-async nil t)
          (let ((deadline (+ (float-time) 8)))
            (while (and pmbah--sign-job (< (float-time) deadline)) (accept-process-output nil 0.02))))
        (unless (= calls 2) (error "did not reach publication cancellation"))
        (when (seq-some (lambda (process) (and (string-prefix-p "pmbah-node" (process-name process)) (process-live-p process))) (process-list))
          (error "quit left a publication helper alive"))
        (princ (pmbah--json-encode (list :job (if pmbah--sign-job t :json-false) :frozen (if pmbah--frozen-record t :json-false)
                                        :locked buffer-read-only :count pmbah--next-seq)))))`);
    assert.deepEqual(output, { job: false, frozen: true, locked: true, count: 1 });
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("native closing a signing buffer cancels its process and preserves the frozen retry", { skip: !emacs }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pmbah-journal-cancel-"));
  try {
    const helper = await delayedHelper(temp);
    const output = await native(temp, `(let ((source (generate-new-buffer "journal-signing")) state frozen process)
      (with-current-buffer source
        (pmbah-mode 1) (insert "private writing")
        (setq-local pmbah-helper-script ${JSON.stringify(helper)})
        (pmbah--sign-buffer-async nil t)
        (let ((deadline (+ (float-time) 8)))
          (while (and (not (eq (plist-get pmbah--sign-job :stage) 'publish)) (< (float-time) deadline))
            (accept-process-output nil 0.01)))
        (unless pmbah--frozen-record (error "no frozen retry before cancellation"))
        (setq state (pmbah--state-file) frozen pmbah--frozen-record process (plist-get pmbah--sign-job :process)))
      (kill-buffer source)
      (when (process-live-p process) (error "signing process survived buffer closure"))
      (with-temp-buffer
        (pmbah-recover-session state)
        (princ (pmbah--json-encode (list :same (equal frozen pmbah--frozen-record) :locked buffer-read-only
                                        :count pmbah--next-seq :active_job (if pmbah--sign-job t :json-false))))))`);
    assert.deepEqual(output, { same: true, locked: true, count: 1, active_job: false });
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("native recovery adopts an uncheckpointed journal tail and retains bounded hot memory", { skip: !emacs }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pmbah-journal-native-"));
  try {
    const events = eventsFor(10_000), content = serialize(events);
    const path = join(temp, `events-${id}.jsonl`), state = join(temp, `session-${id}.json`);
    await writeFile(path, `${content}{"seq":10000`);
    await writeFile(state, JSON.stringify({ storage_version: 2, session_id: id, format_version: "0.3", session_start_ms: Date.now() - elapsed,
      event_count: 9999, journal_bytes: Buffer.byteLength(serialize(events.slice(0, -1))), observation: { state: "disabled" } }));
    const output = await native(temp, `(with-temp-buffer
      (pmbah-recover-session ${JSON.stringify(state)})
      (let ((recovered pmbah--next-seq))
        (insert "x")
        (princ (pmbah--json-encode (list :recovered recovered :count pmbah--next-seq :tail (length pmbah--events)
                                        :snapshot (pmbah--state-snapshot) :checkpoint (pmbah--chain-tip-payload))))))`);
    assert.equal(output.recovered, 10_000);
    assert.equal(output.count, 10_001);
    assert.equal(output.tail, 256);
    assert.equal(output.snapshot.events, undefined);
    assert.ok(JSON.stringify(output.snapshot).length < 2000);
    assert.equal(output.checkpoint.events, undefined);
    assert.equal(output.checkpoint.previous_event_count, 10_000);
    assert.equal(output.checkpoint.previous_byte_offset, Buffer.byteLength(content));
    const suffix = await inspectJournal(output.checkpoint);
    assert.equal(suffix.event_count, 10_001);
    assert.equal(suffix.tail.length, 1, "checkpoint reads only the newly appended event");
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("native legacy migration keeps the old frozen hash without retaining embedded history", { skip: !emacs }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pmbah-journal-migration-"));
  try {
    const events = eventsFor(3000);
    const manifest = { format_version: "0.2", record_hash: computeRecordHash(events, id, "0.2"), session_id: id,
      producer: { id: "emacs", version: "0.1.0", capabilities: ["timing"] }, capture_context: null,
      event_count: events.length, duration_ms: elapsed, created_client_t: "2024-09-23T00:00:00.000Z", ingested_server_t: null, parent_record: null, attestations: [] };
    const record = { manifest, events };
    const state = join(temp, `session-${id}.json`);
    await writeFile(state, JSON.stringify({ session_id: id, session_start_ms: Date.now() - elapsed, format_version: "0.2", events,
      frozen_record: JSON.stringify(record), frozen_upload: JSON.stringify({ ...record, observation: { state: "unobserved" } }), observation: { state: "disabled" } }));
    const output = await native(temp, `(with-temp-buffer
      (pmbah-recover-session ${JSON.stringify(state)})
      (princ (pmbah--json-encode (list :count pmbah--next-seq :tail (length pmbah--events) :frozen (pmbah--parse-public-json pmbah--frozen-record)
                                      :upload (pmbah--parse-public-json pmbah--frozen-upload) :locked (if buffer-read-only t :json-false)
                                      :snapshot (pmbah--state-snapshot)))))`);
    assert.equal(output.count, events.length);
    assert.equal(output.tail, 256);
    assert.equal(output.locked, true);
    assert.deepEqual(output.frozen, { manifest });
    assert.deepEqual(output.upload, { observation: { state: "unobserved" } });
    assert.equal(output.snapshot.storage_version, 2);
    assert.equal(output.snapshot.events, undefined);
    assert.ok((await stat(state)).size < 4000);
    assert.equal(await readFile(join(temp, `events-${id}.jsonl`), "utf8"), serialize(events));
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("native append failure retries one event without duplicating a partial write", { skip: !emacs }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pmbah-journal-append-failure-"));
  try {
    const output = await native(temp, `(with-temp-buffer
      (pmbah-mode 1)
      (let ((writer (symbol-function 'write-region)) failed)
        (cl-letf (((symbol-function 'write-region)
                   (lambda (start end filename &rest rest)
                     (if (and (not failed) (stringp start) (> (length start) 10) (string-suffix-p ".jsonl" filename))
                         (progn (setq failed t) (apply writer (substring start 0 10) nil filename rest) (error "partial append"))
                       (apply writer start end filename rest)))))
          (insert "x"))
        (unless buffer-read-only (error "append failure did not pause capture"))
        (pmbah-retry-save)
        (princ (pmbah--json-encode (list :count pmbah--next-seq :stored pmbah--journal-count
                                        :pending pmbah--journal-pending :events (vconcat (pmbah--session-events))
                                        :writable (if buffer-read-only :json-false t))))))`);
    assert.equal(output.count, 1);
    assert.equal(output.stored, 1);
    assert.equal(output.pending, null);
    assert.equal(output.writable, true);
    assert.deepEqual(output.events.map((event) => event.seq), [0]);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("journal publication streams bounded chunks and resumes a lost chunk response", async () => {
  const temp = await mkdtemp(join(tmpdir(), "pmbah-journal-publish-"));
  const events = eventsFor(9000);
  let server, accepted = [], dropped = false, finalized = false, chunkSizes = [], maxBodyBytes = 0;
  try {
    const path = join(temp, "events.jsonl");
    await writeFile(path, serialize(events));
    const built = await buildJournalManifest(descriptor(path, events.length));
    const response = { record_hash: built.manifest.record_hash, short_signature: "journal", url: "https://example.test/journal", created: true };
    server = createServer(async (request, reply) => {
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const raw = Buffer.concat(chunks);
        maxBodyBytes = Math.max(maxBodyBytes, raw.length);
        const body = JSON.parse(raw);
        assert.equal(body.journal_path, undefined, "private filesystem paths never enter the protocol");
        reply.setHeader("content-type", "application/json");
        if (request.url === "/api/record-uploads") {
          assert.deepEqual(body.manifest, built.manifest);
          assert.equal(body.events, undefined);
          reply.end(JSON.stringify({ upload_id: body.upload_id, next_seq: accepted.length, max_chunk_events: 4096, ...(finalized ? { completed: response } : {}) }));
        } else if (request.url.endsWith("/chunks")) {
          assert.equal(body.start_seq, accepted.length);
          accepted.push(...body.events);
          chunkSizes.push(body.events.length);
          if (!dropped && accepted.length === 8192) { dropped = true; request.socket.destroy(); return; }
          reply.end(JSON.stringify({ upload_id: id, next_seq: accepted.length }));
        } else if (request.url.endsWith("/finalize")) {
          assert.equal(verifyRecord({ manifest: built.manifest, events: accepted }).valid, true);
          finalized = true;
          reply.end(JSON.stringify(response));
        } else { reply.statusCode = 404; reply.end("{}"); }
      } catch (error) { reply.statusCode = 500; reply.end(JSON.stringify({ error: error.message })); }
    });
    await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const input = { ...built, journal_path: path, end_byte: built.byte_length, upload_id: id,
      api_base_url: `http://127.0.0.1:${server.address().port}` };
    await assert.rejects(publishJournal(input));
    assert.equal(accepted.length, 8192);
    assert.deepEqual(await publishJournal(input), response);
    assert.deepEqual(chunkSizes, [4096, 4096, 808]);
    assert.ok(maxBodyBytes < 600_000);
    assert.deepEqual(accepted, events);
    assert.deepEqual(await publishJournal(input), response, "a completed retry returns the accepted link");
  } finally {
    if (server) await new Promise((resolveClose) => server.close(resolveClose));
    await rm(temp, { recursive: true, force: true });
  }
});

test("journal publication rejects mismatched capabilities and malformed accepted responses", async () => {
  const temp = await mkdtemp(join(tmpdir(), "pmbah-journal-responses-"));
  let server, mode;
  try {
    const path = join(temp, "events.jsonl");
    await writeFile(path, serialize(eventsFor(1)));
    const built = await buildJournalManifest(descriptor(path, 1));
    const valid = { record_hash: built.manifest.record_hash, short_signature: "response", url: "https://example.test/response", created: true };
    server = createServer(async (request, reply) => {
      for await (const _ of request) {};
      let result;
      if (request.url === "/api/record-uploads") {
        result = { upload_id: mode === "begin-id" ? "wrong" : id, next_seq: 0, max_chunk_events: 4096 };
        if (mode === "completed-url") result.completed = { ...valid, url: "https://user:password@example.test/record" };
        if (mode === "completed-created") { result.completed = { ...valid }; delete result.completed.created; }
      } else if (request.url.endsWith("/chunks")) {
        result = { upload_id: mode === "chunk-id" ? "wrong" : id, next_seq: 1 };
      } else {
        result = { ...valid }; delete result.short_signature;
      }
      reply.setHeader("content-type", "application/json");
      reply.end(JSON.stringify(result));
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    const input = { ...built, journal_path: path, end_byte: built.byte_length, upload_id: id,
      api_base_url: `http://127.0.0.1:${server.address().port}` };
    for (mode of ["begin-id", "chunk-id", "completed-url", "completed-created", "final-signature"]) {
      await assert.rejects(publishJournal(input), undefined, mode);
    }
  } finally {
    if (server) await new Promise((done) => server.close(done));
    await rm(temp, { recursive: true, force: true });
  }
});

for (const entry of ["enable", "recover"]) {
  for (const failure of ["helper-error", "helper-quit", "save-error", "save-quit"]) {
    test(`native ${entry} recovery retries safely after ${failure}`, { skip: !emacs }, async () => {
      const temp = await mkdtemp(join(tmpdir(), "pmbah-recovery-transaction-"));
      try {
        const document = join(temp, "document.txt");
        await writeFile(document, "");
        const events = eventsFor(2), content = serialize(events);
        const journal = join(temp, `events-${id}.jsonl`);
        const state = join(temp, entry === "enable"
          ? `${createHash("sha256").update(await realpath(document)).digest("hex")}.json` : `session-${id}.json`);
        const metadata = JSON.stringify({ storage_version: 2, session_id: id, format_version: "0.3",
          session_start_ms: Date.now() - elapsed, event_count: 2, journal_bytes: Buffer.byteLength(content) });
        await writeFile(journal, content);
        await writeFile(state, metadata);
        const invoke = entry === "enable" ? "(pmbah-mode 1)" : `(pmbah-recover-session ${JSON.stringify(state)})`;
        const output = await native(temp, `(with-temp-buffer
          ${entry === "enable" ? `(setq buffer-file-name ${JSON.stringify(document)})` : ""}
          (cl-letf (((symbol-function '${failure.startsWith("helper") ? "pmbah--journal-helper" : "pmbah--write-json-file"})
                     (lambda (&rest _) (signal '${failure.endsWith("quit") ? "quit" : "error"} '("injected failure")))))
            (condition-case nil ${invoke} ((error quit) nil)))
          (when (or pmbah-mode pmbah--session-id pmbah--owned-paths
                    (memq #'pmbah--after-change after-change-functions))
            (error "failed recovery installed live state or kept ownership"))
          (unless (equal (pmbah--read-file ${JSON.stringify(state)}) ${JSON.stringify(metadata)})
            (error "failed recovery replaced acknowledged metadata"))
          (unless (equal (pmbah--read-file ${JSON.stringify(journal)}) ${JSON.stringify(content)})
            (error "failed recovery modified valid journal"))
          ${invoke}
          (insert "next")
          (princ (pmbah--json-encode (list :count pmbah--next-seq :session pmbah--session-id
            :failure pmbah--save-failure :events (vconcat (pmbah--session-events))))))`);
        assert.equal(output.count, 3);
        assert.equal(output.session, id);
        assert.equal(output.failure, null);
        assert.deepEqual(output.events.map((event) => event.seq), [0, 1, 2]);
        assert.deepEqual(output.events.slice(0, 2), events);
        assert.equal(JSON.parse(await readFile(state, "utf8")).event_count, 3);
      } finally { await rm(temp, { recursive: true, force: true }); }
    });
  }
}

test("journal recovery checks each persisted prefix before modifying any tail", async () => {
  const temp = await mkdtemp(join(tmpdir(), "pmbah-recovery-anchors-"));
  try {
    const path = join(temp, "events.jsonl"), events = eventsFor(3), content = serialize(events);
    const hashes = computeEventHashChain(events, id, "0.3");
    const firstBytes = Buffer.byteLength(serialize(events.slice(0, 1)));
    const acknowledgedBytes = Buffer.byteLength(serialize(events.slice(0, 2)));
    const base = { journal_path: path, session_id: id, format_version: "0.3", repair_tail: true,
      acknowledged_event_count: 2, acknowledged_byte_length: acknowledgedBytes,
      chain_anchor: { event_count: 1, chain_tip: hashes[0], byte_length: firstBytes, last_t: events[0].t } };
    const incomplete = `${content}{"seq":3`;
    const cases = [
      { name: "changed hashed event", raw: incomplete.replace('"ins_len":1', '"ins_len":2'), input: base },
      { name: "missing acknowledged newline", raw: serialize(events.slice(0, 2)).slice(0, -1), input: base },
      { name: "byte boundary inside event", raw: incomplete, input: { ...base, acknowledged_byte_length: acknowledgedBytes - 1 } },
      { name: "byte boundary beyond event", raw: incomplete, input: { ...base, acknowledged_byte_length: acknowledgedBytes + 1 } },
      { name: "wrong cached count", raw: incomplete, input: { ...base, chain_anchor: { event_count: 2, chain_tip: hashes[0] } } },
      { name: "malformed cached hash", raw: incomplete, input: { ...base, chain_anchor: { event_count: 1, chain_tip: "b3:ab" } } },
      { name: "wrong cache time", raw: incomplete, input: { ...base, chain_anchor: { ...base.chain_anchor, last_t: 1 } } },
      { name: "wrong observation prefix", raw: incomplete, input: { ...base, observation_anchors: [{ event_count: 2, chain_tip: hashes[0] }] } },
      { name: "observation beyond journal", raw: incomplete, input: { ...base, observation_anchors: [{ event_count: 4, chain_tip: hashes[2] }] } },
    ];
    await writeFile(path, content);
    const frozen = await buildJournalManifest(descriptor(path, 3));
    cases.push(
      { name: "changed frozen event", raw: incomplete.replace('"ins_len":1', '"ins_len":2'),
        input: { ...base, chain_anchor: null, frozen_manifest: frozen.manifest, frozen_byte_length: frozen.byte_length } },
      { name: "wrong frozen bytes", raw: incomplete,
        input: { ...base, frozen_manifest: frozen.manifest, frozen_byte_length: frozen.byte_length - 1 } },
      { name: "invalid frozen manifest", raw: incomplete, input: { ...base, frozen_manifest: { ...frozen.manifest, event_count: -1 } } },
    );
    for (const scenario of cases) {
      await writeFile(path, scenario.raw);
      await assert.rejects(inspectJournal(scenario.input), undefined, scenario.name);
      assert.equal(await readFile(path, "utf8"), scenario.raw, `${scenario.name}: evidence must remain byte-for-byte intact`);
    }
    await writeFile(path, incomplete);
    const recovered = await inspectJournal({ ...base, observation_anchors: [{ event_count: 2, chain_tip: hashes[1] }] });
    assert.equal(recovered.event_count, 3, "complete append beyond stale metadata is adopted");
    assert.equal(recovered.chain_tip, hashes[2]);
    assert.equal(await readFile(path, "utf8"), content, "only unacknowledged incomplete bytes are removed");
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("native recovery rejects changed cached history and leaves repeated retries inactive", { skip: !emacs }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pmbah-recovery-corruption-"));
  try {
    const events = eventsFor(2), content = serialize(events), hashes = computeEventHashChain(events, id, "0.3");
    const damaged = `${content.replace('"ins_len":1', '"ins_len":2')}{"seq":2`;
    const journal = join(temp, `events-${id}.jsonl`), state = join(temp, `session-${id}.json`);
    const metadata = JSON.stringify({ storage_version: 2, session_id: id, format_version: "0.3", session_start_ms: Date.now() - elapsed,
      event_count: 2, journal_bytes: Buffer.byteLength(content), chain_tip: hashes[0], chain_tip_event_count: 1,
      chain_tip_byte_offset: Buffer.byteLength(serialize(events.slice(0, 1))), chain_tip_last_time: events[0].t });
    await writeFile(journal, damaged);
    await writeFile(state, metadata);
    const output = await native(temp, `(with-temp-buffer
      (dotimes (_ 2)
        (condition-case nil (pmbah-recover-session ${JSON.stringify(state)}) (error nil))
        (when (or pmbah--session-id pmbah-mode pmbah--owned-paths) (error "corrupt recovery activated capture")))
      (princ "true"))`);
    assert.equal(output, true);
    assert.equal(await readFile(journal, "utf8"), damaged);
    assert.equal(await readFile(state, "utf8"), metadata);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

for (const appendProgress of ["before", "partial", "complete"]) {
  test(`native interrupted ${appendProgress} append and retry metadata save preserve each event once`, { skip: !emacs }, async () => {
    const temp = await mkdtemp(join(tmpdir(), "pmbah-journal-append-quit-"));
    try {
      const output = await native(temp, `(with-temp-buffer
        (pmbah-mode 1)
        (let ((writer (symbol-function 'write-region)) interrupted)
          (cl-letf (((symbol-function 'write-region)
                     (lambda (start end filename &rest rest)
                       (if (and (not interrupted) (stringp start) (> (length start) 10)
                                (string-suffix-p ".jsonl" filename))
                           (progn
                             (setq interrupted t)
                             ${appendProgress === "before" ? "nil" : appendProgress === "partial"
                               ? "(apply writer (substring start 0 10) nil filename rest)"
                               : "(apply writer start end filename rest)"}
                             (signal 'quit nil))
                         (apply writer start end filename rest)))))
            (condition-case nil (insert "first") (quit nil)))
          (unless (and interrupted pmbah--save-failure buffer-read-only pmbah--journal-repair
                       (= pmbah--next-seq 1) (= pmbah--journal-count 0)
                       (= (length pmbah--journal-pending) 1))
            (error "interrupted append did not retain and pause the pending event"))
          ;; Retrying first repairs any uncertain bytes, then appends the event.
          ;; Interrupt metadata persistence after that append has succeeded.
          (cl-letf (((symbol-function 'pmbah--write-json-file)
                     (lambda (&rest _) (signal 'quit nil))))
            (condition-case nil (pmbah-retry-save) (quit nil)))
          (unless (and pmbah--save-failure buffer-read-only
                       (= pmbah--journal-count 1) (null pmbah--journal-pending)
                       (= (length (pmbah--session-events)) 1))
            (error "interrupted metadata retry lost its saved journal cursor"))
          (pmbah-retry-save)
          (when (or pmbah--save-failure buffer-read-only)
            (error "successful retry did not restore capture"))
          (insert "second")
          (princ (pmbah--json-encode
                  (list :events (vconcat (pmbah--session-events))
                        :count pmbah--next-seq :stored pmbah--journal-count
                        :snapshot (pmbah--state-snapshot)
                        :hook (if (memq #'pmbah--after-change after-change-functions) t :json-false)
                        :failure pmbah--save-failure)))))`);
      assert.equal(output.count, 2);
      assert.equal(output.stored, 2);
      assert.equal(output.snapshot.event_count, 2);
      assert.equal(output.hook, true, "capture hook survives cancellation and retries");
      assert.equal(output.failure, null);
      assert.deepEqual(output.events.map(({ seq, ins_len }) => ({ seq, ins_len })), [
        { seq: 0, ins_len: 5 }, { seq: 1, ins_len: 6 },
      ]);
    } finally { await rm(temp, { recursive: true, force: true }); }
  });
}

test("native checkpoint launch cancellation keeps capture active and completes the failed attempt", { skip: !emacs }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pmbah-journal-checkpoint-quit-"));
  try {
    const output = await native(temp, `(with-temp-buffer
      (setq pmbah-observe-process t)
      (pmbah-mode 1)
      (cl-letf (((symbol-function 'process-send-string)
                 (lambda (&rest _) (signal 'quit nil))))
        (insert "first"))
      (unless (and pmbah-mode (memq #'pmbah--after-change after-change-functions)
                   (= pmbah--next-seq 1) pmbah--observation-last-failure
                   (not pmbah--observation-in-flight) (not pmbah--observation-request)
                   (not pmbah--observation-watchdog))
        (error "checkpoint cancellation removed capture or stranded its attempt"))
      (when (seq-some (lambda (process)
                       (and (string-prefix-p "pmbah-node" (process-name process))
                            (process-live-p process))) (process-list))
        (error "cancelled checkpoint retained a helper process"))
      (setq pmbah-observe-process nil)
      (insert "second")
      (princ (pmbah--json-encode
              (list :count pmbah--next-seq :events (vconcat (pmbah--session-events))
                    :hook (if (memq #'pmbah--after-change after-change-functions) t :json-false)
                    :save_failure pmbah--save-failure))))`);
    assert.equal(output.count, 2);
    assert.equal(output.hook, true);
    assert.equal(output.save_failure, null);
    assert.deepEqual(output.events.map(({ seq, ins_len }) => ({ seq, ins_len })), [
      { seq: 0, ins_len: 5 }, { seq: 1, ins_len: 6 },
    ]);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

for (const callbackOutcome of ["http", "quit"]) {
  test(`native inline checkpoint callback preserves ${callbackOutcome === "http" ? "the newer HTTP handle" : "capture after cancellation"}`, { skip: !emacs }, async () => {
    const temp = await mkdtemp(join(tmpdir(), "pmbah-journal-inline-checkpoint-"));
    try {
      const output = await native(temp, `(with-temp-buffer
        (pmbah-mode 1) (insert "first")
        (let ((scan (pmbah--journal-helper (append (list :operation "inspect") (pmbah--chain-tip-payload))))
              (helper (make-pipe-process :name "inline-finished-helper" :noquery t))
              (http (generate-new-buffer " *inline-http-response*")))
          (unwind-protect
              (progn
                (make-pipe-process :name "inline-http" :buffer http :noquery t)
                (cl-letf (((symbol-function 'pmbah--run-node-script-async)
                           (lambda (_script _payload callback)
                             (funcall callback scan nil)
                             helper))
                          ((symbol-function 'pmbah--observation-post)
                           (lambda (&rest _)
                             ${callbackOutcome === "http" ? "(setq pmbah--observation-request http)" : "(signal 'quit nil)"})))
                  (pmbah--observation-kick))
                ${callbackOutcome === "http" ? `
                (unless (eq pmbah--observation-request http)
                  (error "completed helper replaced its callback's active HTTP handle"))
                (pmbah--observation-timeout (current-buffer) pmbah--session-id pmbah--observation-attempt)
                (when (buffer-live-p http) (error "timeout did not close the current HTTP request"))` : ""}
                (unless (and (not pmbah--observation-in-flight) (not pmbah--observation-request)
                             (not pmbah--observation-watchdog) pmbah--observation-last-failure)
                  (error "inline callback left a failed observation attempt running"))
                (insert "second")
                (princ (pmbah--json-encode
                        (list :count pmbah--next-seq
                              :hook (if (memq #'pmbah--after-change after-change-functions) t :json-false)))))
            (when (process-live-p helper) (delete-process helper))
            (when (buffer-live-p http) (kill-buffer http)))))`);
      assert.deepEqual(output, { count: 2, hook: true });
    } finally { await rm(temp, { recursive: true, force: true }); }
  });
}

test("native closing a recording buffer cancels checkpoint workers, HTTP requests and watchdogs", { skip: !emacs }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pmbah-journal-close-checkpoint-"));
  try {
    const output = await native(temp, `(progn
      (dolist (kind '(helper http))
        (let ((writer (generate-new-buffer "checkpoint-writer"))
              (response (generate-new-buffer " *checkpoint-response*")) process watchdog path)
          (unwind-protect
              (progn
                (setq process (make-pipe-process :name "pending-checkpoint" :buffer response :noquery t))
                (with-current-buffer writer
                  (pmbah-mode 1) (insert "captured")
                  (setq path (pmbah--state-file)
                        pmbah--observation-request (if (eq kind 'helper) process response)
                        pmbah--observation-in-flight t)
                  (pmbah--observation-arm-watchdog)
                  (setq watchdog pmbah--observation-watchdog))
                (kill-buffer writer)
                (when (or (buffer-live-p writer) (process-live-p process) (memq watchdog timer-list))
                  (error "closing writer retained checkpoint resources"))
                (when (and (eq kind 'http) (buffer-live-p response))
                  (error "closing writer retained its HTTP response buffer"))
                (unless (= (plist-get (pmbah--read-state path) :event_count) 1)
                  (error "closing writer lost durable capture")))
            (when (process-live-p process) (delete-process process))
            (when (buffer-live-p response) (kill-buffer response))
            (when (buffer-live-p writer) (kill-buffer writer))
            (when (timerp watchdog) (cancel-timer watchdog)))))
      (princ "true"))`);
    assert.equal(output, true);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
