# producer-core

`@possiblymadebyahuman/producer-core` is the shared, content-blind producer kernel consumed by both the browser extension (`apps/browser-extension`, default-aaaa.7) and the first-party drafting page (`apps/web` `/write`, default-aaaa.28). It owns the non-UI logic — session identity, per-field session state, wall-clock-anchored event timelines, content-blind manifest construction, and adapter boundaries — without depending on the DOM, `chrome.*`, or any platform-specific storage / clipboard / fetch primitive.

## What lives here

- **`SessionRegistry`** — the kernel. Multiple parallel sessions, per-session state machine (`active` → `signing` → `uploading` → `uploaded` | `failed_upload`), append-mutation, sign, sweep-expired, snapshot/load.
- **`resolveSession`** — fingerprint-based identity with explicit `IdentityCertainty` of `fresh` | `resumed` | `degraded` | `collision`. No silent merging of distinct fields.
- **Wall-clock timeline** — `appendBufferMutation` stamps each event with `t = wall_ms - base_wall_ms`. Idle gaps are preserved, never compressed.
- **`buildCaptureContext` / `redactCaptureContext` / `stripQueryAndHash`** — pre-upload provenance helpers. URLs are stripped of query/hash by default; title and field-kind are editable/omittable before signing.
- **TTL sweep** — `sweepExpired` removes sessions whose `last_edit_wall_ms` is older than `ttl_ms` (default 3 days) and clears `uploaded` sessions after a short grace. A user-driven `registry.discard(session_id)` removes one specific session immediately and is distinct from the time-based sweep — it returns the removed record or `null` when the id is not present. If a checkpoint POST happens to be in flight at the moment of discard, the request continues on the server side and may succeed, leaving an unfinalized observed-session that the ingest service reclaims via its own TTL sweep. Local state stays consistent; the orphan checkpoint is content-blind (`observed_session_id`, `event_count`, `chain_tip` only).
- **Adapter interfaces** — `StorageAdapter`, `UploadAdapter`, `CheckpointAdapter`, `ClockAdapter`, `UuidAdapter`, `ClipboardAdapter`. The kernel never imports a chrome/window/DOM symbol; consumers wire these.
- **Server-observed checkpoint orchestration** — when a `CheckpointAdapter` is wired, the kernel maintains an incremental BLAKE3 chain tip per session, runs an activity-gated cadence (first mutation immediate; otherwise 50-event delta-from-last-commit OR 60s since last attempt with at least one new event; never on idle), holds a single in-flight checkpoint with one queued coalescing slot, doubles backoff 1s→60s on transient/rate-limited failure, pins to `diverged` on 409/400, resets observation on 404 `observation_unavailable`, and caps retained commitments at 32 (oldest anchor + last 31).

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

await registry.flushObservation(session.session_id); // optional: covers any uncheckpointed tail
const draft = registry.sign(session.session_id);
const observation = registry.getObservationEnvelope(session.session_id); // null when no checkpoint adapter wired or never committed
registry.markUploading(session.session_id);
try {
  const resp = await myUploadAdapter.postRecord({
    manifest: draft.manifest,
    events: draft.events,
    observation: observation ?? undefined,
  });
  registry.markUploaded(session.session_id, resp);
  await myClipboardAdapter.writeText(resp.url);
} catch (err) {
  registry.markFailedUpload(session.session_id, String(err));
}
await registry.persist();
```

## Server-observed checkpoints

When the consumer wires a `CheckpointAdapter`, `SessionRegistry` advances a BLAKE3 chain incrementally on every `appendMutation` (`chain[i] = BLAKE3(chain[i-1] || canonical(event[i]))`, anchored at `chain[0] = BLAKE3(format_version || session_id || canonical(event[0]))`) and posts `(observed_session_id, event_count, chain_tip, token)` to the ingest API. The first successful checkpoint returns a bearer `token` plus `observed_session_id`; later checkpoints reuse both. Per-session observation state is exposed at `record.observation`:

| state       | meaning                                                                                       |
|-------------|-----------------------------------------------------------------------------------------------|
| `disabled`  | no `CheckpointAdapter` wired                                                                  |
| `unknown`   | adapter wired but no commitment yet                                                           |
| `known`     | at least one commitment AND no uncheckpointed events                                          |
| `partial`   | at least one commitment AND uncheckpointed events exist (or last attempt was transient)       |
| `diverged`  | server returned 409 (chain mismatch) or 400 (client bug); no further checkpoints will fire    |

The public wire vocabulary on records (`observed` / `partial` / `unobserved` / `not_requested`) is different and is decided by the ingest API based on what arrives with `POST /api/records`.

Cadence is activity-gated. The kernel never sends idle heartbeats. Triggers, in order of precedence:

1. first mutation after session creation → immediate
2. delta (current events − last_committed_event_count) ≥ 50 → immediate
3. delta > 0 AND ≥ 60s since the last attempt → immediate
4. otherwise — wait

Concurrency: at most one checkpoint is in flight; while one runs, further triggers set a single queued flag. The kernel re-reads `record.events.length` after each checkpoint completes and folds the queued trigger into one trailing call. The `max(last_committed_event_count, response.event_count)` guard absorbs out-of-order responses.

Failure handling:

- `transient` (network / 5xx) or `rate_limited` (429): backoff is 1s on the first failure, doubles 2s → 4s → … → 60s on each subsequent failure. No retry fires while idle and no queued trailing call inside the in-flight loop is allowed to bypass `next_backoff_ms`; the next event-driven `appendMutation` re-evaluates after the window has elapsed.
- `conflict` (409) or `client_bug` (400): observation pins to `diverged`. No further checkpoints fire; the record will be marked `partial` (or worse) by the ingest API.
- `unavailable` (404 `observation_unavailable`, TTL-expired or token lost): observation resets to `unknown`, `observed_session_id` and `last_observed_token` are cleared, commitments dropped. The next mutation mints a fresh `observed_session_id`.

Sign-time flush is explicit: callers run `await registry.flushObservation(session_id)` before `sign()` to give the server a final commitment covering the tail. `flushObservation` does not retry transient failures — the consumer is expected to read `record.observation.state` and decide whether to bind a (possibly stale) envelope on the upload anyway.

Commitments retained per session are capped at `commitment_retention` (default 32) using "oldest anchor + last 31 tail," so the very first commitment stays available as an anchor while the in-memory footprint stays bounded.

### Wiring a `CheckpointAdapter` — `token: null` is internal

`CheckpointRequest.token` is typed `ObservedSessionToken | null`. The `null` value is an internal kernel signal that no commitment has succeeded yet for the current observed session, and the request body sent to `.39`'s `POST /api/observed-sessions/:observed_session_id/checkpoints` must omit the `token` field entirely in that case — the ingest API rejects `{ "token": null }`. A correct browser/`/write` adapter looks like:

```ts
class FetchCheckpointAdapter implements CheckpointAdapter {
  constructor(private readonly base: string) {}
  async postCheckpoint(request: CheckpointRequest): Promise<CheckpointResult> {
    const body: Record<string, unknown> = {
      event_count: request.event_count,
      chain_tip: request.chain_tip,
    };
    if (request.token !== null) body.token = request.token; // do NOT serialise null
    const url = `${this.base}/api/observed-sessions/${request.observed_session_id}/checkpoints`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return mapResponse(response);
  }
}
```

The bearer `token` is the only secret the kernel hands the adapter. It must never appear in logs, in `chrome.runtime.sendMessage` payloads to content scripts, in any public record, or in any analytics surface — it stays inside `SessionRecord.observation.last_observed_token` and reaches the network only through the adapter.

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

`tests/producer-core.test.mjs` covers the acceptance scenarios from default-aaaa.29 plus invariants (no plaintext keys in the public draft, identity helpers exposed independently, capture-context redaction). `tests/producer-core-checkpoints.test.mjs` covers the server-observed checkpoint orchestration: immediate first-mutation commit, delta-50 and 60s-time cadence, single-in-flight + queued coalescing, transient/rate-limited backoff doubling without idle retries, `diverged` pinning on 409/400, `observation_unavailable` reset + fresh observed-session minting, chain-tip incremental advance equivalence, and commitment eviction at watermark. `tests/producer-core-audit.test.mjs` is a static source audit that fails the build if any banned plaintext-handling symbol or import escape appears in `packages/producer-core/src`. Tests inject a mutable clock, a deterministic UUID factory, an in-memory storage adapter, and a recording checkpoint adapter — no real time, no real browser, no real network.

Run `make check` to exercise the full project test suite including these tests.
