# possiblymadebyahuman — Source of Truth

Status: approved architecture for v0 implementation.  
Audience: coordinator, developer, reviewer, and future contributors.  
Spec reference: `docs/spec.md` remains the product/format thesis; this document is the implementation source of truth for architecture, UI, backend, database, routing, and work breakdown.

Extension UX amendment, 23 September 2026: the owner requires explicit activation on the chosen editor and no persistent controls over webpage content. Sections 3.8 and 13.1 define the extension 0.2.1 behavior; extension 0.1.1/0.1.2 implement the superseded passive-capture behavior. Implementation is tracked in [UX-reset epic #3](https://github.com/juanre/possiblymadebyahuman/issues/3) and [the review](extension-ux-review-2026-09-23.md).


Further owner direction, 23 September 2026: cards must be user-nameable with contextual defaults, use generic field wording, and follow the focused editor. Saved links and unfinished sessions must not expire automatically. A writer must be able to return after months, resume the same session and sign a timeline that includes the pause. Extension 0.2.1 implements indefinite local retention, explicit unfinished-session resumption, and longer time ranges. Editable card names, focus following, collapsed/searchable history, and the broader panel redesign remain pending. These changes are not present in extension 0.2.0. See [the revised panel/session design](extension-panel-design-2026-09-23.md), including time-range, durable identity and server-observation work. Existing published records remain immutable.

---

## 1. Product promise

`possiblymadebyahuman` records the shape of a writing process and gives someone an inspectable, hash-addressed process record.

The product is **not** a detector and must not become one.

Allowed claim:

> This record shows the shape of an editing process. It makes pasted and atomically inserted content visible. It does not prove that a human originated the ideas, and it cannot detect a human retyping an AI draft from another screen.

Hard rules:

1. **No verdicts.** No human/AI label, no confidence percentage, no badge implying certification of humanity.
2. **Process, not content.** The public service stores edit structure, metadata, and statistics; it does not store, hash, replay, upload, or reconstruct plaintext text.
3. **Hash-addressed records.** The record URL is a short signature that resolves to a record whose full hash is always visible and browser-verifiable.
4. **Tone matters.** The UI should be candid, lightweight, and self-aware: “we cannot prove it, but here is us caring enough to show the work.”

---

## 2. Approved stack and repo shape

Use a **TypeScript monorepo** for shared core code across backend, frontend, browser extension, analyzers, and conformance tooling.

The Emacs producer will be Elisp, but it must conform to the same JSON event-log contract and conformance vectors.

Approved layout:

```text
docs/
  sot.md
  architecture.md
  spec/
    canonicalization.md

packages/
  format/
  conformance/
  analyzers/
  storage/
  producer-core/

apps/
  ingest-api/
  web/
  site/
  browser-extension/

producers/
  emacs/
```

Notes:

- `apps/web` is the Vite React record-viewing app.
- `apps/site` is the Hugo static site for the landing/docs surface.
- The public root `/` and `/docs/*` belong to Hugo.
- Record pages such as `/<short_signature>` belong to the Vite React app.
- `/api/*` belongs to the backend.

---

## 3. Layer responsibilities

### 3.1 `packages/format`

The hard core contract.

Owns:

- event mutation types
- record manifest types
- producer info types
- capture context types
- source enum
- capability enum
- canonical JSON serialization
- BLAKE3-prefixed `b3:` hashing
- event hash-chain computation
- record-hash verification
- content-blind process-length validation using Unicode codepoint offsets, with explicit JSON `null` for unknown process measurements
- the format `0.2` text binding: `canon-letters/0.1` canonicalization, the salted commitment, and sealing the binding into `record_hash` (normative detail in `docs/text-binding.md` and `docs/spec/canonicalization.md`)
- bounded metadata: `capture_context` accepts only its documented keys with capped string lengths, `attestations` only small typed objects with field names capped at 64 characters, producer id/version capped at 128 characters with no extra producer keys, counts/offsets within the 32-bit storage range, and elapsed millisecond fields within the JavaScript safe-integer range

Does not own:

- UI
- storage
- server routing
- analyzer conclusions
- browser or Emacs capture mechanics

### 3.2 `packages/conformance`

The compatibility gate for all producers.

Owns:

- canonicalization vectors
- hash-chain vectors
- content-blind process-length/codepoint vectors
- golden sample records
- conformance runner
- documentation for what “conformant producer” means

A producer is conformant iff it passes canonicalization, hash-chain, process-length, and capability-accuracy checks.

### 3.3 `packages/analyzers`

Pure analyzer plugin layer.

Owns:

- `Analyzer` interface
- `Signal` type
- analyzer registry/runner
- v0 `timing-distribution` analyzer
- v0 `edit-topology` analyzer
- shared stats helpers when appropriate

Rules:

- An analyzer is a pure function: `(EventLog, Manifest) -> Signal`.
- No network.
- No global state.
- No per-author memory in v0.
- Missing required capabilities returns `applicable: false`, not a penalty.
- Output is descriptive facts and explanations only.
- No aggregate humanness score.

### 3.3.x `packages/producer-core`

Shared browser-side producer kernel consumed by both `apps/browser-extension` (default-aaaa.7) and the first-party `/write` page (default-aaaa.28).

Owns:

- per-field session identity, certainty (`fresh` / `resumed` / `degraded` / `collision`) and registry
- wall-clock-anchored event timeline (idle gaps preserved)
- content-blind manifest construction via `packages/format`
- session state machine (`active` → `signing` → `uploading` → `uploaded` | `failed_upload`)
- capture-context redaction helpers (URL query/hash strip, title/field-kind omit)
- configurable TTL sweep; the extension disables draft expiry and retains uploaded-record references indefinitely, without events or checkpoint tokens after cleanup; the `/write` consumer retains its existing policy
- server-observed checkpoint orchestration: incremental BLAKE3 chain advance per event, activity-gated cadence (first mutation immediate; otherwise 50-event delta-from-last-commit OR 60s since last attempt with at least one new event; no idle heartbeats), single-in-flight with one queued coalescing slot, a 30-second attempt deadline (including response-body reads), immediate serialized persistence of checkpoint outcomes, exponential 1s→60s backoff for transient/rate-limited responses, hard `diverged` pin for 409/400, observation reset on 404 `observation_unavailable`, commitment retention capped at 32 (oldest anchor + last 31), explicit `flushObservation()` before sign+upload that completes observation of a session with at least one commitment (final checkpoint over the uncommitted tail, plus one more round for events that arrive while it is in flight; at most two rounds) and leaves a never-committed session alone, and a `getObservationEnvelope()` accessor that yields the `(observed_session_id, token)` binding for `POST /api/records` when a commitment exists and the session has not diverged, `{ state: "unobserved" }` when it has no commitment or is `diverged`, and `null` when no checkpoint adapter is wired
- local observation state vocabulary (`disabled` / `unknown` / `known` / `partial` / `diverged`) distinct from the public wire vocabulary on records (`observed` / `partial` / `unobserved` / `not_requested`)
- adapter interfaces (`StorageAdapter`, `UploadAdapter`, `CheckpointAdapter`, `ClockAdapter`, `UuidAdapter`, `ClipboardAdapter`)

Does not own:

- DOM observation, `chrome.*`, `window.*`, `document.*`
- Plaintext storage, hashing, replay, upload, or helper payloads
- Text-based verification; `packages/format.verifyRecord` verifies public structure and hash chain only
- Storage technology: checkpoint outcomes are persisted through `StorageAdapter.write(snapshot)`; browser consumers provide the storage implementation. Tokens stay in local observation state and are sent only to the ingest service for observation requests
- Listing/store copy or browser packaging

### 3.4 `packages/storage`

Backend storage abstraction.

Owns:

- record-store interface
- Postgres implementation
- immutable record save semantics
- lookup by full `record_hash`
- lookup by `short_signature`
- stats persistence interface
- analysis-result persistence interface

Does not own:

- analyzer execution policy
- HTTP routing
- frontend presentation

### 3.5 `apps/ingest-api`

Layer 2 service.

Owns:

- `POST /api/records`
- `GET /api/records/:short_signature_or_hash`
- `GET /api/health`
- schema validation
- hash-chain verification
- content addressing
- `ingested_server_t` stamping
- short-signature generation
- immutable record storage
- precomputed record statistics
- v0 analyzer execution, synchronously if simple enough

Does not own:

- plaintext storage
- producer capture logic
- UI claims
- humanness scoring

### 3.6 `apps/web`

Vite React app for record pages.

Owns:

- `/<short_signature>` record page
- content-blind process timeline
- quick stats panel
- analyzer signal cards
- verification panel
- browser-side chain verification using `packages/format`
- first-party `/write` capture and signing via `packages/producer-core`
- standing disclaimer

Does not own:

- marketing/docs pages
- ingestion
- capture in external editors

### 3.7 `apps/site`

Hugo static site.

Owns:

- `/` landing page
- `/docs/*`
- product explanation
- installation/use docs
- threat-model docs

The landing page should reinforce the product promise and avoid detector/certificate language.

A public blog (`/blog/*`) was scoped originally and dropped in `default-aaaa.25` per human direction. The backend still reserves `blog` in its short-signature prefix list so the route prefix stays safe to reintroduce later without breaking existing records.

### 3.8 `apps/browser-extension`

Primary browser author UX.

Owns:

- explicitly activated text-field/contenteditable observation; no capture or checkpoints from unchosen fields
- per-field session identity
- browser-owned session controls; no persistent injected field labels or overlays
- sign modal
- durable unsigned captures and saved links, retained until explicit local removal
- sign/freeze/upload/copy-link flow
- local clear after upload
- capture-context prompt review before upload

### 3.9 `producers/emacs`

Native producer for Emacs.

Owns:

- minor mode
- `after-change-functions` capture
- buffer/session status
- sign-buffer command
- conformant event logs (format `0.2`)
- capture-context prompts/redaction before upload
- server-observed checkpoint orchestration with the `packages/producer-core` cadence and state machine (first event immediate; 50-event delta or 60 s with new events; no idle heartbeats; single in-flight plus one queued slot; 30 s attempt watchdog; 1 s→60 s backoff; `diverged` on 409/400; reset on 404 `observation_unavailable`; up to two flush rounds of an already-observed session before sign), with chain tips advanced from the last known tip by the local `scripts/chain-tip.mjs` helper from public events only
- observation binding on upload: `(observed_session_id, token)` when a checkpoint succeeded and the session is not diverged, explicit `unobserved` when observation was requested but never succeeded or diverged (the upload message says so), absent when `pmbah-observe-process` is nil
- one session per buffer, kept across major-mode changes and `revert-buffer` (permanent-local state)
- per-file session persistence under `pmbah-state-directory` (SHA-256 of the file's true name, owner-only, no text) with resumption anchored at the stored session start, deletion after upload or discard, preservation of diverged observation state/reason across resumption, and `.stale` retirement when the exact JSON integer time bound, a format-version change, or an unreadable file prevents resumption

### 3.10 Producer scope invariant

All v0 producers record the writing process captured after a user starts a session. They do not silently wrap pre-existing document content into a new record scope.

- **Emacs** may enable `pmbah-mode` in a non-empty buffer. It records only mutations after capture starts, using Emacs' absolute positions and lengths for those later mutations. Its helper receives only process metadata (`events`, producer info, capture context, duration), not inserted text, text hashes-for-anything-else, initial snapshots/baselines, or text replay fixtures. **Local transient-binding exception:** at sign time the helper may receive the active region when `use-region-p` is true, otherwise the whole buffer, *solely* to compute the approved content-blind text binding (the `canon-letters/0.1` commitment) locally via the shared `packages/format` implementation. The helper must discard that text without persisting, logging, replaying, uploading, or passing it onward; only the sealed binding object (`scheme`, `canonical_length`, `commitment`) and the record survive. The text never leaves the user's machine — this is a local-compute exception, not a storage-policy exception, and plaintext storage/upload remains forbidden.
- **Browser extension** requires explicit start in an empty editor. It never enrolls another field by heuristic matching. An additional editor may explicitly join the same active document session; this is a user choice, not an automatic inference. Reload, full-document navigation, stop, and finish retire capture authorization. Historical local drafts remain stopped. It may transiently inspect field text inside a `beforeinput` handler to derive numeric offsets/lengths. At sign time, if binding is enabled, the content script may transiently read selected text in the active field/editor, or all current content of that field/editor when no in-field selection is available, solely to compute the content-blind binding commitment; only the binding object may cross to the service worker/upload. It must not retain text snapshots in content-script state, extension storage, service-worker messages, uploads, or logs.
- **`/write` first-party page** starts from an empty textarea and clears/discards the visible canvas independently of the persisted content-blind session record. At sign time, if binding is enabled, it binds selected text in the writing canvas, or all current canvas content when nothing is selected.
- **`packages/producer-core`** accepts only public mutation shapes and session metadata. It must not require plaintext, final text, inserted text, text hashes, or text replay to sign/verify a record.

Tests and audits for each producer must cover this invariant before release.

---

## 4. Event log and manifest contract

The primitive is a buffer mutation, not a keystroke.

Mutation fields:

```jsonc
{
  "seq": 412,
  "t": 184523,
  "op": "replace",
  "pos": 1043,
  "del_len": 12,
  "ins_len": 47,
  "source": "paste"
}
```

Requirements:

- `seq` is monotonic, gap-free, and starts at 0.
- `t` is integer milliseconds since session start.
- `pos`, `del_len`, and `ins_len` are Unicode codepoint offsets/lengths, not UTF-16 units and not bytes; when unknown, they are explicit JSON `null`, not omitted.
- `op` is one of `insert`, `delete`, `replace`.
- `source` is one of `typing`, `paste`, `cut`, `drop`, `ime`, `autocomplete`, `programmatic`, `unknown`.
- Producers must not label uncertain input as `typing`; use `unknown` when attribution is degraded.

Manifest includes:

```jsonc
{
  "format_version": "0.2",
  "record_hash": "b3:...",
  "session_id": "uuid",
  "producer": {
    "id": "browser-extension",
    "version": "0.1.0",
    "capabilities": ["timing", "source_attribution", "selection", "pause_fidelity", "keystroke_level"]
  },
  "capture_context": {},
  "text_binding": { "scheme": "canon-letters/0.1", "canonical_length": 1840, "commitment": "b3:..." }, // optional, format 0.2 only
  "event_count": 1429,
  "duration_ms": 1384502,
  "created_client_t": "client-claimed timestamp, untrusted",
  "ingested_server_t": "server-stamped timestamp, trusted if present",
  "parent_record": null,
  "attestations": []
}
```

`text_binding` is the one text-derived value a public record may carry: a salted BLAKE3 commitment to the canonical letters and digits of the text the signer chose to bind, computed locally, sealed into `record_hash` under format `0.2`. It lets a reader check that a document has the same wording as the signed text; it never reconstructs the text and it is not a check of exact text. `docs/text-binding.md` is normative. Format `0.1` records carry no binding and keep verifying unchanged.


`parent_record` is the public manifest field for multi-session documents. It may be null for v0 records. It lets a record say “this session continues from that earlier signed record” without pretending one capture covers all writing. `parent_record_hash` is reserved for future storage/database column naming and is not part of public manifest input.

---

## 5. Capture context metadata

Records should store where they were taken whenever possible, while preserving user control and privacy.

Add `capture_context` to the manifest and database.

Browser example:

```jsonc
{
  "surface": "browser",
  "label": "Example Forum Thread",
  "browser": {
    "url": "https://example.com/thread/123",
    "title": "Example Forum Thread",
    "field_kind": "textarea"
  }
}
```

Emacs example:

```jsonc
{
  "surface": "emacs",
  "label": "essay.md",
  "emacs": {
    "buffer_name": "essay.md",
    "major_mode": "markdown-mode"
  }
}
```

Only the documented keys are accepted (`surface`, `label`, `browser.url`, `browser.title`, `browser.field_kind`, `emacs.buffer_name`, `emacs.major_mode`), every value is a string, and lengths are capped, so capture context cannot become a side channel for document text.

Privacy rules:

- The signer must be able to review, edit, or omit capture context before upload. A producer whose context is fixed and non-identifying (`/write` uploads its own URL and a fixed label) documents exactly what it sends instead.
- Browser URLs should strip query strings and fragments by default.
- Browser page title may be identifying; show it before upload.
- Emacs buffer names may be identifying; show them before upload.
- Absolute local file paths should not be uploaded by default.
- The frontend should present capture context as provenance context, not as proof of authorship.

---

## 6. Record statistics

The backend should precompute fast record statistics at ingestion so the record page can render meaningful facts immediately.

Terminology:

- The system records mutations, not raw physical keystrokes.
- Use “typing events” and “typed codepoints.”
- Only use “keystroke-level” language when the producer declares `keystroke_level`.

Recommended stats:

```text
event_count
duration_ms
observed_final_length

insert_op_count
delete_op_count
replace_op_count

typed_event_count
paste_event_count
cut_event_count
drop_event_count
ime_event_count
autocomplete_event_count
programmatic_event_count
unknown_source_count

inserted_codepoints_total
deleted_codepoints_total
largest_atomic_insert_codepoints

inter_event_delay_min_ms
inter_event_delay_p50_ms
inter_event_delay_p90_ms
inter_event_delay_p95_ms
inter_event_delay_p99_ms
inter_event_delay_max_ms

delay_histogram
active_time_ms
idle_time_ms
long_pause_count
```

Delay distribution guidance:

- Compute inter-event delays from consecutive event `t` values.
- Define an idle threshold in code/config, e.g. 30 seconds, for active-vs-idle summaries. Active time is the sum of inter-event gaps below that threshold; idle time sums gaps at or above it. Neither includes unmeasured time before the first event or after the last event.
- Timing analyzer `0.1.1` excludes unmeasured endpoint waits. For legacy cached records, the API corrects active time on read using the measured event span minus the stored idle time, preserving the original idle threshold; legacy timing signals are presented as `0.1.1`. Immutable events, hashes, commitments and stored caches are not rewritten.
- Keep raw events available for exact process-timeline rendering; stats are a render/cache optimization, not the source of truth.

---

## 7. Database

Use **Postgres** for v0 hosted backend.

Production Postgres will be **Neon.tech**. Local container testing must use a real Postgres container, not only in-memory storage, before any deploy/release decision.

Reasons:

- JSONB support for manifests/events/signals.
- Simple immutable record indexing.
- Good enough for v0 and production growth.
- Avoids premature object-storage split.
- Neon gives managed Postgres while preserving a standard Postgres development/test surface.

If event logs become too large later, raw events can move to object storage while Postgres remains the index.

### 7.1 `records`

```text
record_hash              text primary key
short_signature          text unique not null

format_version           text not null
session_id               uuid not null

producer_id              text not null
producer_version         text not null
producer_capabilities    jsonb not null

capture_context          jsonb null

event_count              integer not null
duration_ms              integer not null
created_client_t         timestamptz null
ingested_server_t        timestamptz not null

parent_record_hash       text null references records(record_hash)

attestations             jsonb not null default '[]'
events                   jsonb not null

created_at               timestamptz not null default now()
```

No plaintext text field.

### 7.2 `record_stats`

```text
record_hash                         text primary key references records(record_hash) on delete cascade

insert_op_count                     integer not null
delete_op_count                     integer not null
replace_op_count                    integer not null

typed_event_count                   integer not null
paste_event_count                   integer not null
cut_event_count                     integer not null
drop_event_count                    integer not null
ime_event_count                     integer not null
autocomplete_event_count            integer not null
programmatic_event_count            integer not null
unknown_source_count                integer not null

inserted_codepoints_total           integer not null
deleted_codepoints_total            integer not null
largest_atomic_insert_codepoints    integer not null

inter_event_delay_min_ms            integer null
inter_event_delay_p50_ms            integer null
inter_event_delay_p90_ms            integer null
inter_event_delay_p95_ms            integer null
inter_event_delay_p99_ms            integer null
inter_event_delay_max_ms            integer null

active_time_ms                      integer not null
idle_time_ms                        integer not null
long_pause_count                    integer not null

delay_histogram                     jsonb not null
created_at                          timestamptz not null default now()
```

### 7.3 `analysis_results`

```text
id                       uuid primary key
record_hash              text not null references records(record_hash) on delete cascade

analyzer_id              text not null
analyzer_version         text not null
applicable               boolean not null

measures                 jsonb not null
human_range              jsonb null
explanation              text not null

created_at               timestamptz not null default now()

unique(record_hash, analyzer_id, analyzer_version)
```

---

## 8. Short URLs

Support short URLs from v0.

Public record route:

```text
https://possiblymadebyahuman.com/<short_signature>
```

The backend still stores and verifies the full `record_hash`.

Strategy:

- Derive a short signature from the record hash bytes using a URL-safe alphabet such as base58 or base32.
- Start around 10–12 characters.
- Collision-check in Postgres.
- If collision occurs, increase length until unique.
- The record page must always display the full `record_hash`.
- Browser verification recomputes the full hash from stored events and compares it to the full hash, not only the short signature.

Routing priority:

1. `/api/*` -> backend
2. Runtime/health routes such as `/health` or `/ready`, if present -> backend
3. `/` and `/docs/*` -> Hugo static site
4. Static assets for the Hugo site and Vite app -> static file serving
5. `/<short_signature>` -> Vite React record app

Reserved route prefixes/paths must not be emitted as short signatures: `api`, `docs`, `blog`, `write`, `assets`, `record-assets`, `health`, `ready`, `live`, `images`, and any future static/runtime prefix. `blog` stays reserved even though the public `/blog/*` route was dropped in `default-aaaa.25`, so the prefix stays safe to reintroduce. Implementations may use a deterministic leading-`X` rescue candidate for hashes whose base58 prefix collides with a reserved route; future routes must not reserve `x`/`X` unless the rescue strategy changes too.

---

## 9. Deletion and authentication

No user management in v0.

Approved v0 policy:

- No public user deletion endpoint.
- Uploaded records are permanent by default.
- This is acceptable only because public records must not store plaintext or direct user identity fields.
- Manual/admin abuse removal can exist operationally outside the public API.

Reasoning:

- Shared record links should keep working.
- Account management is out of scope.
- Delete-token flows are possible later but are not required for v0.

Future option:

- `POST /api/records` returns a bearer delete token.
- Backend stores only `delete_token_hash`.
- `DELETE /api/records/:record_hash` deletes when token matches.
- Anyone with the token can delete; no account required.

Do not implement this unless explicitly approved later.

---

## 10. Backend API

### 10.1 `POST /api/records`

Used by producers.

Input:

```jsonc
{
  "manifest": {},
  "events": [],
  "observation": { "observed_session_id": "...", "token": "..." } // optional; or { "state": "unobserved" } when observation was requested but no commitment succeeded, or the session's checkpoints diverged from the server's
}
```

A producer binds `(observed_session_id, token)` only for a session with at least one commitment whose checkpoints the server has not rejected; before signing it flushes a final checkpoint over that session's uncommitted tail (and one more if events arrive while it is in flight). A session with no commitment, or one pinned `diverged`, is uploaded as `{ "state": "unobserved" }` so signing still succeeds; the producer tells the writer when that happens because of divergence.

Backend behavior:

1. Validate schema, including the bounded `capture_context` and `attestations` shapes, 32-bit count/offset ranges, and non-negative safe-integer elapsed milliseconds (`t` and `duration_ms`, at most 9,007,199,254,740,991). Durations and derived delay/active/idle statistics use PostgreSQL `bigint`; actual dates remain `timestamptz`. Existing format versions, canonical bytes and hashes are unchanged.
2. Verify events are content-blind: no plaintext or text-derived field is accepted, with the single exception of the format `0.2` `text_binding` commitment (§4).
3. Recompute canonical event bytes.
4. Recompute BLAKE3 hash chain.
5. Verify manifest `record_hash` equals the final chain hash, or the chain tip sealed with the `text_binding` when one is present.
6. Verify `event_count`, `duration_ms`, and other manifest fields are structurally consistent where possible.
7. Stamp `ingested_server_t`.
8. Generate collision-checked `short_signature`.
9. Store immutable record row.
10. Compute and store `record_stats`.
11. Run v0 analyzers and store `analysis_results` if cheap enough synchronously; otherwise queue later.
12. If an observation binding is present, recompute every stored checkpoint prefix from the submitted public events and reject finalization on mismatch. If the observation is `{ "state": "unobserved" }`, store the record with public observation state `unobserved` and no commitments.
13. Return record URL.

Output:

```jsonc
{
  "record_hash": "b3:...",
  "short_signature": "k7Qp9dLx2m",
  "url": "https://possiblymadebyahuman.com/k7Qp9dLx2m"
}
```

### 10.2 `GET /api/records/:short_signature_or_hash`

Used by the Vite React record app.

Returns:

```jsonc
{
  "manifest": {},
  "events": [],
  "stats": {},
  "signals": [],
  "observation": {
    "state": "observed", // observed | partial | unobserved | not_requested
    "commitments": [{ "checkpoint_id": "...", "event_count": 1, "chain_tip": "b3:...", "observed_at": "..." }],
    "first_observed_at": "...",
    "last_observed_at": "...",
    "server_observed_span_ms": 0
  }
}
```

Still content-blind. Observation state is server metadata, not a manifest field.

### 10.3 `POST /api/observed-sessions/:session_id/checkpoints`

Used by producers that request server-observed commitments. `:session_id` must be strict UUIDv4. The first checkpoint creates the observed session and returns the bearer `token`; later checkpoints send the same token.

Input:

```jsonc
{
  "event_count": 1,
  "chain_tip": "b3:...",
  "token": "..." // omitted only for first successful checkpoint
}
```

Output:

```jsonc
{
  "observed_session_id": "...",
  "token": "...",
  "checkpoint_id": "...",
  "event_count": 1,
  "chain_tip": "b3:...",
  "server_t": "..."
}
```

The server stores only `token_hash`, never the bearer token. Checkpoint bodies contain no text or text-derived hashes. Same `(event_count, chain_tip)` is idempotent; same count with a different tip or a stale lower count is a conflict. Token/session lookup failures return the uniform `observation_unavailable` shape. Unfinalized observed sessions and checkpoints have no automatic expiry, so earlier commitments remain available after months away. Local discard does not delete server checkpoint metadata.

### 10.4 `GET /api/health`

Basic deployment health for the API.

The production container may additionally expose root-level `/health` and `/ready` endpoints for load balancers. They should check at least process liveness and database connectivity; readiness should fail when migrations are missing or the database is unavailable.

---

## 11. Frontend: Vite React record app

Main route:

```text
/<short_signature>
```

Component structure:

```text
RecordPage
  DisclaimerBanner
  CaptureContextSummary
  QuickStatsPanel
  ProcessTimeline
  SignalList
    SignalCard
  VerificationPanel
    ChainVerificationButton
    ManifestDetails
```

### 11.1 Record page content

The page should show:

1. Standing disclaimer.
2. Capture context, if present.
3. Quick stats:
   - event count
   - duration
   - observed process length, or unknown when process measurements contain nulls
   - typing events / typed codepoints
   - insertions / deletions / replacements
   - paste/unknown counts
   - largest atomic insert
   - active vs idle time
   - delay distribution summary
4. Process timeline.
5. Analyzer signals as facts.
6. Verification panel.

### 11.2 Process timeline in content-blind mode

The public service should not render or reconstruct text. Instead, the timeline visualizes structure:

- document length over time
- insertion/deletion position on a horizontal document bar
- event size
- source color
- large atomic insert markers
- long pauses on the timeline

Future private/content-bearing deployments may render text, but that is out of scope for public v0.

Build/deploy note:

- The Vite app is bundled into the same production Docker image as the API and Hugo site.
- The record app is served for `/<short_signature>` routes.
- Configure Vite's asset base so its JS/CSS assets do not collide with Hugo assets; preferred reserved prefix: `/record-assets/`.

---

## 12. Frontend: Hugo site

Hugo owns:

```text
/
/docs/*
```

Landing page goals:

- Explain the gesture: “we can’t prove it, but here’s us caring enough to show the work.”
- Show a simple example of a writing record.
- Explain content-blind storage.
- Link to browser extension and Emacs producer when available.
- Link to docs and threat model.

Docs should include:

- what the system claims and does not claim
- how records work
- how to verify a record
- privacy model
- producer conformance
- threat model

Build/deploy note:

- Unlike the sister `aweb-cloud` project, the Hugo landing/docs site is not deployed as a separate static surface for v0.
- Hugo output must be included in the same production Docker image as the API and Vite record app.
- The container serves Hugo for `/` and `/docs/*`, while preserving `/<short_signature>` for record pages.

---

## 13. Producer UIs

### 13.1 Browser extension UI

Primary normal-user author UX. The explicit-start requirements below supersede the previous passive/capture-all design. Extension 0.2.0 introduced explicit activation; 0.2.1 adds durable drafts/links and explicit resumption. Versions before 0.2.0 use the superseded passive-capture behavior.

Surfaces:

- An explicit start action on a chosen editor, with context-menu and accessible keyboard/toolbar paths.
- Extension toolbar status and browser-owned session controls. A browser side panel hosts those controls; persistent controls over the host page are prohibited.
- Sign modal: “Finish & get link.”
- Capture-context review/redaction before upload.
- Actionable explanations that distinguish editor identity, available measurements and server observation; no raw `degraded` or `collision` labels.
- Persistent saved-record result with the full URL, Open record and Copy link; separate upload and clipboard outcomes.

Behavior:

1. Start only after explicit activation of the chosen editor. Unchosen fields create no sessions, capture text measurements or send checkpoints. Define activation, stop, reload and continuation behavior explicitly; local retention must not silently enroll fields again.
2. The user finishes when they want a link and reviews context and binding. A requested binding that cannot be obtained must pause for Cancel or an explicit process-only choice; it cannot be silently omitted. An immutable stopped snapshot cannot be resampled from later edits, so do not offer a dead-end binding retry. Upload failures can retry the same frozen record.
3. Signing freezes the session.
4. Extension computes the public process hash chain locally.
5. Extension uploads content-free manifest/events.
6. Backend returns short URL.
7. Extension presents a persistent saved-record result and copies the URL only when the user chooses Copy link. Claim copied only after clipboard success, and retain a visible usable URL if copying fails.
8. Local log is cleared shortly after successful upload.
9. Continuations must respect explicit activation and truthfully identify their coverage, linking to the uploaded record through `parent_record`; signed sessions stay frozen with their links. Edits missed while capture was stopped must not later appear covered. A failed upload can be retried with the same signed record. Same-document session sharing across deliberately activated tabs remains supported. (`/write` retains its existing behavior: its canvas keeps the text on screen, so it reopens the same session and re-signs the whole process.)

Extension local retention and resumption:

- Unsigned drafts and saved record links do not expire automatically. Explicit local removal, browser-data clearing or uninstall can remove them. Already expired entries cannot be restored from local state.
- Startup/registration/hourly cleanup removes redundant uploaded event logs and checkpoint credentials after the grace period while preserving the saved link.
- Reload and navigation detach capture. Select an unfinished draft, focus its field and choose **Resume in chosen field**; the field may contain existing text. Resumption is explicit and restricted to the same site origin, without guessing document identity.
- Resume preserves session identity, event history, checkpoint credentials and original clock. The next real edit includes the intervening pause. If prior edits may have been missed, its position is unknown (`pos: null`), so the viewer does not invent a continuous document-length curve. Reattachment adds no event.
- Duration ends at the last captured edit. Returning only to publish does not extend the signed event timeline to the publish action. Published records cannot be resumed or mutated in place.
- Shared producer-core default TTL and `/write` reload behavior are unchanged; this indefinite-retention policy applies to the extension.

### 13.2 Emacs UI

Commands:

```text
pmbah-mode
pmbah-sign-buffer
pmbah-show-session-status
pmbah-discard-session
```

UX:

- mode-line capture indicator: `PMBAH:N` plus `✓` (server has stamped every event), `·` (some events not yet stamped), or `✗` (diverged) when observation is on
- session status reports event count, duration, observation state with the last checkpoint failure, and API URL
- several buffers record at once, each in its own session; a file buffer resumes its saved session when the mode is re-enabled, and a message explains when saved state is set aside as `.stale`
- sign-buffer command, flushing the final checkpoint first
- capture-context review/redaction before upload
- upload returns and copies short URL

---

## 14. Deployment architecture

Deploy the public service as a **single Docker container** containing:

1. the Node/TypeScript ingestion API/runtime;
2. the built Vite React record app;
3. the built Hugo landing/docs site.

This follows the sister-project pattern in `~/prj/awebai/aweb-cloud`:

- multi-stage Dockerfile for deterministic builds;
- Makefile targets for local container, prod-like container, migrations, and shutdown;
- `.env.*.example` files with explicit required values;
- local Docker Compose stack for app + real Postgres;
- production/prod-like Compose path that uses an external managed database.

Important difference from `aweb-cloud`:

- `possiblymadebyahuman` has no Redis/worker/auth stack in v0.
- The Hugo landing page is included in the same container rather than being deployed separately.

### 14.1 Container responsibilities

The runtime container should:

- listen on `0.0.0.0:${PORT:-8000}`;
- expose `/api/*` API routes;
- expose health/readiness routes for container/load-balancer checks;
- serve Hugo static output for `/` and `/docs/*`;
- serve Vite record-app assets from a reserved prefix such as `/record-assets/*`;
- serve the Vite record app shell for `/<short_signature>`;
- never serve source files, local env files, tests, `.aw/`, or unbuilt workspace internals.

Recommended runtime environment variables:

```text
PORT=8000
DATABASE_URL=postgresql://...
PUBLIC_BASE_URL=https://possiblymadebyahuman.com
NODE_ENV=production
LOG_LEVEL=info
```

### 14.2 Docker/build files

Add deployment files before release readiness:

```text
Dockerfile
.dockerignore
docker-compose.local-container.yml
docker-compose.prod.yml
.env.local-container.example
.env.localprod.example
.env.production.example
Makefile
```

Expected Makefile targets should cover most day-to-day management work, similar to `aweb-cloud`:

```text
make help                  # list targets and ports
make install               # install workspace dependencies
make check                 # typecheck + tests + conformance
make test                  # tests only
make typecheck             # TypeScript typecheck only
make dev-api               # run API locally against DATABASE_URL
make dev-web               # run Vite record app dev server if needed
make dev-site              # run Hugo dev server if needed
make docker-build          # build the single production image
make local-container       # build image, start app + local Postgres, run migrations, wait for health
make local-container-down  # stop local stack
make local-container-logs  # tail local container logs
make local-container-test  # run HTTP ingest/readback smoke test against local container
make migrate               # run migrations against DATABASE_URL
make prod-container        # run built/published image locally against external Neon DATABASE_URL
make prod-container-migrate
make prod-container-down
make clean                 # remove local build/test output where safe
```

The Makefile should be the primary operator interface for local development, container smoke tests, migration runs, and prod-like Neon checks.

### 14.3 Local real-Postgres test

A local Docker Compose path with `postgres:16-alpine` is required. It should:

- start Postgres with a persistent named volume;
- run migrations against that Postgres;
- start the application container;
- verify `/api/health` and/or `/ready`;
- run at least one ingest/readback smoke test through the real HTTP API and Postgres path.

This is the preferred way to close the current live-Postgres test gap. In-memory storage is still useful for fast unit tests, but it is not sufficient for deployment readiness.

### 14.4 Production database

Production uses Neon.tech Postgres via `DATABASE_URL`.

Rules:

- Do not bake database credentials into the image.
- Keep `.env.production` out of git; only commit `.env.production.example`.
- Migration execution should be explicit (`make prod-container-migrate` or equivalent) rather than hidden behind record-page traffic.
- The app should fail readiness if it cannot connect to Neon or if required migrations are absent.

---

## 15. Milestones

### M0 — architecture/scaffold

- Commit this SOT into the repo.
- Create TypeScript monorepo skeleton.
- Add docs/architecture.md and docs/spec/canonicalization.md.
- Add package/app READMEs.
- Add placeholder test/typecheck commands.

### M1 — core format and conformance

- Implement event/manifest types.
- Implement canonicalization.
- Implement BLAKE3 `b3:` hashing.
- Implement hash-chain computation and verification.
- Implement content-blind process-length validation with Unicode codepoint offsets and explicit nulls for unknown process measurements.
- Add conformance vectors.
- Wire CI/test command.

### M2 — backend persistence and stats

- Postgres schema/migrations for `records`, `record_stats`, `analysis_results`.
- Implement immutable record store.
- Implement short-signature generation.
- Implement `POST /api/records`.
- Implement `GET /api/records/:id`.
- Implement stats computation.

### M2.x — Docker/local real-Postgres deployment foundation

- Add Dockerfile, .dockerignore, Docker Compose, env examples, and Makefile targets modeled after `aweb-cloud` but simplified for this app.
- Build one runtime image containing API + Vite record app + Hugo landing/docs output.
- Add local container stack with real Postgres and migration execution.
- Add smoke/integration test proving ingest/readback through the container against real Postgres.
- Add prod-like path for running the same image against external Neon `DATABASE_URL`.

### M3 — analyzers

- Implement analyzer interface and registry.
- Implement timing-distribution analyzer.
- Implement edit-topology analyzer.
- Store analyzer results.

### M4 — Vite React record app

- Implement public record page.
- Implement quick stats panel.
- Implement content-blind process timeline.
- Implement signal cards.
- Implement verification panel with browser-side chain verification.

### M5 — Hugo landing/docs

- Implement landing page.
- Add docs and threat model pages.
- Ensure routing works with Vite app and backend.

### M6 — browser extension producer

- Capture text fields/contenteditable.
- Local session store and consumer-specific retention policy.
- Capture-context prompt review.
- Sign/freeze/upload/copy-link flow.
- Conformance pass.

### M7 — Emacs producer

- Minor mode capture.
- Sign-buffer/upload flow.
- Capture-context prompt review.
- Conformance pass.

---

## 16. Implementation guardrails

- Do not add user management in v0.
- Do not add deletion API in v0.
- Do not store plaintext in public records.
- Do not add a humanness score, verdict, or badge.
- Do not call the record page a certificate unless clearly qualified as not certifying humanity.
- Do not let analyzers mutate records or depend on one another.
- Do not treat missing capabilities as suspicious; mark analyzer output not applicable.
- Do not conflate local removal/cleanup with uploaded server record lifetime; extension drafts and saved links have no automatic expiry.
- Keep work in small reviewable tasks with independent review.

---

## 17. When a bigger team helps

Current coordinator/developer/reviewer is enough for M0–M2.

A bigger team would help once boundaries are stable, especially for parallel work on:

- browser extension producer
- Emacs producer
- Vite React record UI
- Hugo content/site
- backend/API/storage
- analyzer/conformance suite

Recommended expansion point: after M1 core format/conformance is reviewed and stable, because every other workstream depends on that contract.
