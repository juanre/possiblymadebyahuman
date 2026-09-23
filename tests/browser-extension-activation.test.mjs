import test from "node:test";
import assert from "node:assert/strict";

// Exercise the real worker boundary: content senders must not receive stored
// checkpoint tokens, drive signing, or register without a browser gesture.
test("explicit browser activation scopes permission to one document and freeze drains before signing", async () => {
  globalThis.__PMBAH_EXT_VERSION__ = "0.1.3-test";
  globalThis.__PMBAH_EXT_BASE_URL__ = "https://example.test";
  globalThis.__PMBAH_EXT_RECORDS_ENDPOINT__ = "https://example.test/api/records";
  const saved = globalThis.chrome;
  const savedFetch = globalThis.fetch;
  const storage = {};
  const handlers = {};
  const messages = [];
  const own = { id: "test-extension", url: "chrome-extension://test-extension/popup.html" };
  const content = { id: "test-extension", url: "https://example.test/draft", tab: { id: 12 }, frameId: 3, documentId: "document-a" };
  let registrations = 0;
  let knownSession;
  let freezeCalls = 0;
  let skipDrain = false;
  let freezing = false;
  let delayProbe = false;
  let releaseProbe;
  let probeStarted;
  let precedingPoll;
  const probeWaiting = new Promise(resolve => { probeStarted = resolve; });
  const descriptor = { tag_name: "TEXTAREA", field_kind: "textarea", name: null, id: "body", aria_label: "Message", nearest_form_id: null, dom_signature: "123abc", index_among_similar: 0 };
  const register = { kind: "register_field", tab_id: 999, frame_id: 999, origin_url: "https://forged.test", page_path: "/wrong", page_title: "Draft", descriptor, field_is_empty: true };
  const invoke = (message, sender = own) => new Promise((resolve) => handlers.message(message, sender, resolve));
  globalThis.fetch = async () => new Response(JSON.stringify({}), { status: 503 });
  globalThis.chrome = {
    runtime: { id: "test-extension", onMessage: { addListener: (fn) => { handlers.message = fn; } }, onInstalled: { addListener: (fn) => { handlers.installed = fn; } } },
    storage: { local: { get: async (keys) => Object.fromEntries(keys.filter((key) => key in storage).map((key) => [key, storage[key]])), set: async (values) => { Object.assign(storage, structuredClone(values)); }, remove: async () => {} } },
    tabs: { onRemoved: { addListener: (fn) => { handlers.removed = fn; } }, query: async () => [{ id: 12 }], sendMessage: async (tab, message, options) => {
      messages.push({ tab, message, options });
      if (message.kind === "capture_status") {
        if (delayProbe) {
          delayProbe = false;
          await new Promise(resolve => { releaseProbe = resolve; probeStarted(); });
        }
        return { active: !freezing };
      }
      if (message.kind === "probe_editor") return { focused: options.frameId === 3 };
      if (message.kind === "start_editor") {
        if (knownSession) return { kind: "start_editor_result", session_id: knownSession };
        registrations++;
        const reply = await invoke({ ...register, activation_id: message.activation_id, ...(message.share_session_id ? { share_session_id: message.share_session_id } : {}), ...(message.resume_session_id ? { resume_session_id: message.resume_session_id } : {}) }, content);
        assert.equal(reply.kind, "register_field_result");
        return { kind: "start_editor_result", session_id: reply.result.session_id };
      }
      if (message.kind === "freeze_session") {
        freezeCalls++;
        freezing = true;
        // This probe began before freeze, so a pre-await filter cannot protect
        // the drain. Deliver its now-stale false response during finishing.
        if (releaseProbe) {
          releaseProbe();
          releaseProbe = undefined;
          const polled = await precedingPoll;
          assert.equal(polled.capture_status[message.session_id], "active", "a preexisting probe cannot revoke drain authorization");
        }
        const during = await invoke({ kind: "list_sessions" });
        assert.equal(during.capture_status[message.session_id], "active", "list cannot revoke append authority during freeze drain");
        // This pending content edit must still be authorized during draining.
        if (!skipDrain) {
          const appended = await invoke({ kind: "append_mutation", session_id: message.session_id, mutation: { op: "insert", pos: 0, del_len: 0, ins_len: 1, source: "typing" } }, content);
          assert.equal(appended.kind, "append_mutation_result");
        }
        return { kind: "binding_result", text_binding: null };
      }
      throw new Error("unexpected content command");
    } },
    webNavigation: { getAllFrames: async () => [{ frameId: 0, documentId: "document-main" }, { frameId: 3, documentId: "document-a" }], onCommitted: { addListener: (fn) => { handlers.navigation = fn; } } },
    contextMenus: { create: () => {}, removeAll: async () => {}, onClicked: { addListener: (fn) => { handlers.menu = fn; } } },
    sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    commands: { onCommand: { addListener: (fn) => { handlers.command = fn; } } },
    alarms: { create: () => {}, onAlarm: { addListener: (fn) => { handlers.alarm = fn; } } },
  };
  try {
    await import(`../apps/browser-extension/src/background/service-worker.ts?test=${Date.now()}`);
    const before = await invoke({ kind: "list_sessions" });
    assert.deepEqual(before.sessions, []);
    for (const kind of ["list_sessions", "sign_session", "retry_failed_upload", "discard_session", "prepare_finish", "stop_session", "start_focused_editor"]) {
      const response = await invoke({ kind, session_id: "guessed" }, content);
      assert.equal(response.kind, "error", `content cannot invoke ${kind}`);
    }
    assert.equal((await invoke(register, content)).reason, "explicit_start_required");
    assert.equal((await invoke(register)).reason, "content_sender_required");
    assert.equal((await invoke({ kind: "list_sessions" }, { ...own, url: "https://example.test" })).reason, "unauthorised_sender");
    const started = await invoke({ kind: "start_focused_editor" });
    assert.equal(started.kind, "start_editor_result");
    assert.equal(registrations, 1);
    const session = started.session_id;
    const listed = await invoke({ kind: "list_sessions" });
    assert.equal(listed.capture_status[session], "active");
    assert.equal(listed.sessions[0].origin.origin, "https://example.test");
    assert.equal(listed.sessions[0].origin.tab_id, 12);
    const secondStart = await invoke({ kind: "start_focused_editor" });
    assert.notEqual(secondStart.session_id, session);
    knownSession = session;
    const selectedAgain = await invoke({ kind: "start_focused_editor" });
    assert.equal(selectedAgain.session_id, session);
    assert.equal((await invoke({ kind: "list_sessions" })).selected_session_id, session, "choosing an already active editor selects it without enrolling it again");
    knownSession = undefined;
    // Sharing history survives one tab closing: the survivor must not silently
    // become the wording source for a process spanning two editors.
    content.tab = { id: 13 };
    chrome.tabs.query = async () => [{ id: 13 }];
    const sharedStart = await invoke({ kind: "start_focused_editor", share_session_id: session });
    assert.equal(sharedStart.session_id, session);
    handlers.removed(12);


    const mutation = { kind: "append_mutation", session_id: session, mutation: { op: "insert", pos: 0, del_len: 0, ins_len: 1, source: "typing" } };
    assert.equal((await invoke(mutation, { ...content, documentId: "unrelated-document" })).kind, "error");
    assert.equal((await invoke({ kind: "sign_session", session_id: session })).kind, "error");
    delayProbe = true;
    precedingPoll = invoke({ kind: "list_sessions" });
    await probeWaiting;
    const prepared = await invoke({ kind: "prepare_finish", session_id: session, bind: true });
    assert.equal(prepared.kind, "prepare_finish_result");
    assert.match(prepared.reason, /spans multiple editors/, "closing one tab does not make a shared record bindable");
    assert.equal(messages.filter(entry => entry.message.kind === "freeze_session").at(-1).message.bind, false, "shared finish does not compute unused commitments");
    assert.equal((await invoke(mutation, content)).kind, "error", "stopped editor cannot append");
    const stopped = await invoke({ kind: "list_sessions" });
    assert.equal(stopped.capture_status[session], "stopped");
    assert.equal(stopped.sessions[0].events.length, 1, "finish includes the drained final edit");
    const processOnly = await invoke({ kind: "prepare_finish", session_id: session, bind: false });
    assert.equal(processOnly.reason, undefined);
    assert.equal(processOnly.text_binding, null);
    assert.equal(freezeCalls, 1, "finish retries reuse frozen binding and never resample missed edits");
    assert.equal((await invoke({ kind: "sign_session", session_id: session, text_binding: { scheme: "fake" } })).kind, "error");
    assert.ok(messages.some((entry) => entry.message.kind === "freeze_session" && entry.options.frameId === 3 && entry.options.documentId === "document-a"));
    const fresh = await invoke({ kind: "start_focused_editor" });
    assert.notEqual(fresh.session_id, session, "identical descriptors do not silently resume ended captures");
    await invoke({ kind: "stop_session", session_id: fresh.session_id });
    assert.equal(messages.filter(entry => entry.message.kind === "freeze_session").at(-1).message.bind, false, "stop does not request a wording commitment");
    assert.equal(storage["pmbah:explicit-capture:v1"].snapshots[fresh.session_id].binding, null);
    assert.equal((await invoke({ kind: "start_focused_editor", resume_session_id: fresh.session_id }, content)).kind, "error", "a page cannot resume a draft");
    const resumed = await invoke({ kind: "start_focused_editor", resume_session_id: fresh.session_id });
    assert.equal(resumed.session_id, fresh.session_id);
    assert.equal(storage["pmbah:explicit-capture:v1"].snapshots[fresh.session_id], undefined, "resume invalidates the frozen snapshot");
    skipDrain = true;
    const noNewEdit = await invoke({ kind: "prepare_finish", session_id: fresh.session_id, bind: true });
    assert.match(noNewEdit.reason, /no captured edits since it was resumed/);
    assert.equal(noNewEdit.text_binding, null);
    const oldActivity = await invoke({ kind: "prepare_finish", session_id: fresh.session_id, bind: false });
    assert.equal(oldActivity.reason, undefined);
    assert.equal((await invoke({ kind: "start_focused_editor", resume_session_id: fresh.session_id })).session_id, fresh.session_id);
    skipDrain = false;
    assert.equal((await invoke({ kind: "start_focused_editor", resume_session_id: fresh.session_id })).session_id, undefined, "an already active draft cannot be reattached");
    assert.equal((await invoke({ ...mutation, session_id: fresh.session_id }, { ...content, frameId: 99 })).kind, "error", "resume stays frame scoped");
    assert.equal((await invoke({ ...mutation, session_id: fresh.session_id }, { ...content, documentId: "prior-document" })).kind, "error", "resume stays document scoped");
    assert.equal((await invoke({ ...mutation, session_id: fresh.session_id }, content)).kind, "append_mutation_result");
    await invoke({ kind: "stop_session", session_id: fresh.session_id });
    handlers.removed(12);
    const afterClose = await invoke({ kind: "list_sessions" });
    assert.equal(afterClose.capture_status[fresh.session_id], "stopped", "closing a tab stops its route");
    await invoke({ kind: "discard_session", session_id: session });
    const routing = storage["pmbah:explicit-capture:v1"];
    assert.equal(routing.snapshots[session], undefined, "discard removes frozen wording commitments");
    assert.equal(routing.routes.some(route => route.session === session), false, "discard removes route retention");
    const waitForNotice = async (pattern) => {
      for (let attempt = 0; attempt < 30; attempt++) {
        const response = await invoke({ kind: "list_sessions" });
        if (pattern.test(response.last_start_error ?? "")) return response.last_start_error;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      assert.fail("browser action did not preserve its failure notice");
    };
    chrome.webNavigation.getAllFrames = async () => [];
    handlers.menu({ menuItemId: "pmbah-start", frameId: 3 }, { id: 12 });
    await waitForNotice(/selected editor is no longer available/);
    handlers.command("start-writing-record", { id: 12 });
    await waitForNotice(/Click inside the editor/);
    chrome.tabs.query = async () => { throw new Error("tab query rejected"); };
    handlers.command("start-writing-record", { id: 12 });
    await waitForNotice(/Could not access the chosen editor/);

  } finally {
    globalThis.chrome = saved;
    globalThis.fetch = savedFetch;
  }
});
