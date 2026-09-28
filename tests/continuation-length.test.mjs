import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createIngestApi } from "../apps/ingest-api/src/index.ts";
import { uploadJournal } from "../packages/browser-storage/src/upload.ts";
import { computeRecordHash } from "../packages/format/src/index.ts";
import { InMemoryRecordStore } from "../packages/storage/src/index.ts";

const producer = { id: "emacs", version: "0.1.4", capabilities: ["timing"] };
const typing = (count, from = 0, t0 = 0) => Array.from({ length: count }, (_, i) => ({ seq: i, t: t0 + i * 100, op: "insert", pos: from + i, del_len: 0, ins_len: 1, source: "typing" }));
function record(events, parent_record = null) {
  const manifest = { format_version: "0.3", record_hash: "", session_id: randomUUID(), producer, event_count: events.length,
    duration_ms: (events.at(-1)?.t ?? 0) + 100, created_client_t: "2026-09-28T00:00:00.000Z", ingested_server_t: null, parent_record, attestations: [] };
  manifest.record_hash = computeRecordHash(events, manifest.session_id, "0.3", undefined, manifest);
  return { manifest, events };
}
function service() {
  const api = createIngestApi({ store: new InMemoryRecordStore(), baseUrl: "https://possiblymadebyahuman.test" });
  const fetch = (url, init) => api.handleRequest(new Request(url, init));
  const chunked = async r => uploadJournal({ endpoint: "http://local/api/record-uploads", fetch,
    payload: { upload_id: randomUUID(), manifest: r.manifest, observation: { state: "unobserved" } },
    readEvents: async (start, n) => r.events.slice(start, start + n) });
  return { api, chunked };
}
const stats = async (api, hash) => (await api.getRecord(hash)).body.stats;

for (const path of ["whole", "chunked"]) {
  const publish = async ({ api, chunked }, r) => {
    if (path === "chunked") return chunked(r);
    const created = await api.postRecord(r);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return created.body;
  };

  test(`a continuation that picks up where its parent ended starts from the parent's length (${path} upload)`, async () => {
    const s = service();
    const parent = record(typing(10));
    await publish(s, parent);
    assert.deepEqual([(await stats(s.api, parent.manifest.record_hash)).starting_length, (await stats(s.api, parent.manifest.record_hash)).observed_final_length], [0, 10]);
    // Two more characters typed at the end of the parent's text, then one deleted in the middle.
    const next = record([...typing(2, 10), { seq: 2, t: 300, op: "delete", pos: 4, del_len: 1, ins_len: 0, source: "typing" }], parent.manifest.record_hash);
    await publish(s, next);
    const continued = await stats(s.api, next.manifest.record_hash);
    assert.equal(continued.starting_length, 10);
    assert.equal(continued.observed_final_length, 11);
  });

  test(`a continuation that starts with a gap, or whose parent length is unknown, keeps its length unknown (${path} upload)`, async () => {
    const s = service();
    const parent = record(typing(10));
    await publish(s, parent);
    const gap = typing(2, 10); gap[0] = { ...gap[0], pos: null };
    const afterGap = record(gap, parent.manifest.record_hash);
    await publish(s, afterGap);
    assert.equal((await stats(s.api, afterGap.manifest.record_hash)).observed_final_length, null);

    const unknownParent = record([{ ...typing(1)[0], pos: null }]);
    await publish(s, unknownParent);
    const child = record(typing(2, 0), unknownParent.manifest.record_hash);
    await publish(s, child);
    const childStats = await stats(s.api, child.manifest.record_hash);
    assert.equal(childStats.starting_length, null);
    assert.equal(childStats.observed_final_length, null);
  });
}
