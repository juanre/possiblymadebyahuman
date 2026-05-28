# producer-core

`@possiblymadebyahuman/producer-core` is the shared, content-opaque producer kernel consumed by both the browser extension (`apps/browser-extension`, default-aaaa.7) and the first-party drafting page (`apps/web` `/write`, default-aaaa.28). It owns the non-UI logic — session identity, per-field session state, wall-clock-anchored event timelines, content-opaque manifest construction, and adapter boundaries — without depending on the DOM, `chrome.*`, or any platform-specific storage / clipboard / fetch primitive.

## What lives here

- **`SessionRegistry`** — the kernel. Multiple parallel sessions, per-session state machine (`active` → `signing` → `uploading` → `uploaded` | `failed_upload`), append-mutation, sign, sweep-expired, snapshot/load.
- **`resolveSession`** — fingerprint-based identity with explicit `IdentityCertainty` of `fresh` | `resumed` | `degraded` | `collision`. No silent merging of distinct fields.
- **Wall-clock timeline** — `appendBufferMutation` stamps each event with `t = wall_ms - base_wall_ms`. Idle gaps are preserved, never compressed.
- **`buildCaptureContext` / `redactCaptureContext` / `stripQueryAndHash`** — pre-upload provenance helpers. URLs are stripped of query/hash by default; title and field-kind are editable/omittable before signing.
- **TTL sweep** — `sweepExpired` removes sessions whose `last_edit_wall_ms` is older than `ttl_ms` (default 3 days) and clears `uploaded` sessions after a short grace.
- **Adapter interfaces** — `StorageAdapter`, `UploadAdapter`, `ClockAdapter`, `UuidAdapter`, `ClipboardAdapter`. The kernel never imports a chrome/window/DOM symbol; consumers wire these.

## What this kernel does NOT do

- Read or write `chrome.*` / `window.*` / `document.*`.
- Observe DOM events. Consumers translate `beforeinput` / `input` / `MutationObserver` deltas into `PendingMutation`.
- Store, hash, replay, upload, or require document text. Consumers may transiently inspect editor text only when necessary to derive numeric process metadata, then discard it.
- Compute document-content metadata. Public v0 records intentionally do not contain `final_text_hash`, `final_text_length`, `ins_hash`, inserted text, final text, or text reconstruction fixtures.
- Decide which `Capability` to declare. The kernel records source labels in events; consumers decide whether their evidence supports declaring `source_attribution`.

## How consumers wire in

```ts
import { SessionRegistry } from "@possiblymadebyahuman/producer-core";

const registry = new SessionRegistry({
  clock:    { now: () => Date.now() },
  uuid:     { uuid: () => crypto.randomUUID() },
  storage:  myStorageAdapter,       // chrome.storage.local for the extension, IndexedDB/localStorage for /write
  producer: { id: "browser-extension", version: "0.1.0", capabilities: ["timing"] },
});

await registry.init();

const session = registry.findOrCreate(origin, descriptor, captureContext);
registry.appendMutation(session.session_id, {
  op: "insert",
  pos: 0,
  del_len: 0,
  ins_len: 5,
  source: "typing",
});

const draft = registry.sign(session.session_id);
registry.markUploading(session.session_id);
try {
  const resp = await myUploadAdapter.postRecord(draft);
  registry.markUploaded(session.session_id, resp);
  await myClipboardAdapter.writeText(resp.url);
} catch (err) {
  registry.markFailedUpload(session.session_id, String(err));
}
await registry.persist();
```

## Per-field identity (the load-bearing detail)

`resolveSession(origin, descriptor, existing, uuid)` returns one of:

| certainty   | when                                                                                 |
|-------------|--------------------------------------------------------------------------------------|
| `fresh`     | no compatible session in the same `(origin, path, field_kind)` slice                  |
| `resumed`   | exact descriptor match against an existing non-uploaded session                       |
| `degraded`  | 2+ anchor fields match (name / id / aria-label / form / index) but the `dom_signature` changed |
| `collision` | exact descriptor match against an already-`active` session in another frame           |

The fingerprint is `{tag_name, field_kind, name, id, aria_label, nearest_form_id, dom_signature, index_among_similar}`. `dom_signature` is computed by the consumer's content script over the field's structural neighbors; the kernel does not care how it is generated, only that it is stable across reloads when the field is "the same field" and drifts when the DOM is rewritten.

When in doubt, prefer creating a new session with `degraded` certainty over silently merging.

## Wall-clock timing

`base_wall_ms` is set from the `ClockAdapter` at session creation. Each `appendMutation` stamps `t = clock.now() - base_wall_ms`. If the consumer drives the registry from a backgrounded tab and the user idles for five minutes, the next event's `t` jumps by exactly the wall-clock gap. There is no compression. This is the SOT contract; the kernel honours it by construction.

## What you can verify without text

`registry.sign()` runs `verifyEventHashChain({manifest, events})` before returning. That check validates the manifest fields, the canonical event log, and `manifest.record_hash === BLAKE3(format_version || session_id || events…)`.

It does not verify document content, because PMBAH v0 does not inspect, hash, replay, or store document content.

## Capabilities

`producer.capabilities` is the consumer's claim about what the producer can deliver. The kernel does not inspect or enforce it. The required convention:

- `timing` — declare it whenever you can stamp events with a real clock (i.e. always, in a browser).
- `source_attribution` — declare it only if the consumer's mapping from input intent to `Source` is reliable across the cases it handles. When unsure, omit; downstream analyzers will treat the relevant signals as not-applicable.
- `selection`, `pause_fidelity`, `keystroke_level` — see SOT § 4. Don't declare these unless the implementation actually delivers them.

If a capability becomes unsupported mid-session (e.g. the source attribution heuristic degrades), start a new session with the lower capability set rather than retroactively un-declaring.

## Errors

- `UnknownSessionError` — `appendMutation` / `sign` / `mark*` against a session id that is not in the registry.
- `SessionFrozenError` — state-machine violation (e.g. `appendMutation` against a `signing` / `uploading` / `uploaded` / `failed_upload` session, or `sign` against a non-`active` session). Consumers should surface a UI message and either retry after `markFailedUpload` → `markUploading` or discard.

## Testing

`tests/producer-core.test.mjs` covers the acceptance scenarios from default-aaaa.29 plus invariants (no plaintext keys in the public draft, identity helpers exposed independently, capture-context redaction). Tests inject a mutable clock, a deterministic UUID factory, and an in-memory storage adapter — no real time, no real browser.

Run `make check` to exercise the full project test suite including these tests.
