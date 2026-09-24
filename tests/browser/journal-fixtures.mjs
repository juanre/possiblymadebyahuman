import assert from "node:assert/strict";

/** Small-fixture resumable server: lifecycle tests inspect the logical record at
 * finalize, while the producer must actually execute begin/chunk/finalize. */
export async function mockRecordUpload(page, finalized) {
  const uploads = new Map();
  await page.route("**/api/record-uploads**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON();
    if (path === "/api/record-uploads") {
      const old = uploads.get(body.upload_id);
      if (old) {
        assert.deepEqual(
          old.manifest,
          body.manifest,
          "retry changed frozen manifest",
        );
        old.observation = body.observation;
      } else
        uploads.set(body.upload_id, {
          manifest: body.manifest,
          observation: body.observation,
          events: [],
        });
      return route.fulfill({
        json: {
          upload_id: body.upload_id,
          next_seq: uploads.get(body.upload_id).events.length,
          max_chunk_events: 4096,
        },
      });
    }
    const [, , , id, action] = path.split("/");
    const stored = uploads.get(id);
    assert.ok(stored, "upload must begin before chunks or finalization");
    if (action === "chunks") {
      assert.ok(body.events.length > 0 && body.events.length <= 4096);
      if (body.start_seq === stored.events.length)
        stored.events.push(...body.events);
      else
        assert.deepEqual(
          stored.events.slice(
            body.start_seq,
            body.start_seq + body.events.length,
          ),
          body.events,
        );
      return route.fulfill({
        json: { upload_id: id, next_seq: stored.events.length },
      });
    }
    assert.equal(action, "finalize");
    assert.equal(stored.events.length, stored.manifest.event_count);
    const payload = structuredClone(stored);
    const request = route.request();
    const adapted = new Proxy(route, {
      get(target, key) {
        if (key === "request")
          return () =>
            new Proxy(request, {
              get(req, prop) {
                if (prop === "postDataJSON") return () => payload;
                if (prop === "postData") return () => JSON.stringify(payload);
                const value = Reflect.get(req, prop);
                return typeof value === "function" ? value.bind(req) : value;
              },
            });
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return finalized(adapted);
  });
}

/** Explicit full read for tiny fixtures only; production status reads metadata. */
export const readWriteSessions = (page) =>
  page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("pmbah.write.journal.v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const transaction = database.transaction(
        ["sessions", "events"],
        "readonly",
      );
      const read = (request) =>
        new Promise((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      const [sessions, rows] = await Promise.all([
        read(transaction.objectStore("sessions").getAll()),
        read(transaction.objectStore("events").getAll()),
      ]);
      if (rows.length > 10_000)
        throw new Error("Fixture helper cannot materialize large histories");
      return sessions.map((session) => ({
        ...session,
        events: rows
          .filter((row) => row.session_id === session.session_id)
          .map((row) => row.event),
      }));
    } finally {
      database.close();
    }
  });

export async function installJournalFailure(page) {
  await page.addInitScript(() => {
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (stores, mode, options) {
      if (
        window.__failLocalSave &&
        this.name === "pmbah.write.journal.v1" &&
        mode === "readwrite"
      ) {
        throw new DOMException("Storage quota exceeded", "QuotaExceededError");
      }
      return original.call(this, stores, mode, options);
    };
  });
}
