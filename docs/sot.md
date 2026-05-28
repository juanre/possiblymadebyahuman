# possiblymadebyahuman — Source of Truth

Status: approved architecture for v0 implementation.  
Audience: coordinator, developer, reviewer, and future contributors.  
Spec reference: `docs/spec.md` remains the product/format thesis; this document is the implementation source of truth for architecture, UI, backend, database, routing, and work breakdown.

---

## 1. Product promise

`possiblymadebyahuman` records the shape of a writing process and gives someone a replayable, hash-addressed record they can inspect.

The product is **not** a detector and must not become one.

Allowed claim:

> This record shows the shape of an editing process. It makes pasted and atomically inserted content visible. It does not prove that a human originated the ideas, and it cannot detect a human retyping an AI draft from another screen.

Hard rules:

1. **No verdicts.** No human/AI label, no confidence percentage, no badge implying certification of humanity.
2. **Process, not content.** The public service stores edit structure, metadata, and statistics; it does not store plaintext text.
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
- `apps/site` is the Hugo static site for the landing/docs/blog surface.
- The public root `/`, `/docs/*`, and `/blog/*` belong to Hugo.
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
- deterministic replay using Unicode codepoint offsets
- final-text hash computation for local verification/test fixtures

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
- deterministic replay/codepoint vectors
- golden sample records
- conformance runner
- documentation for what “conformant producer” means

A producer is conformant iff it passes canonicalization, hash-chain, replay, and capability-honesty checks.

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

### 3.4 `packages/storage`

Backend storage abstraction.

Owns:

- record-store interface
- Postgres implementation later
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
- replay scrubber
- quick stats panel
- analyzer signal cards
- verification panel
- browser-side chain verification using `packages/format`
- standing disclaimer

Does not own:

- marketing/docs/blog pages
- ingestion
- capture

### 3.7 `apps/site`

Hugo static site.

Owns:

- `/` landing page
- `/docs/*`
- `/blog/*`
- product explanation
- installation/use docs
- threat-model docs

The landing page should reinforce the product promise and avoid detector/certificate language.

### 3.8 `apps/browser-extension`

Primary future author UX for normal users.

Owns:

- capture-all text-field/contenteditable observation
- per-field session identity
- field badge
- popup
- sign modal
- local unsigned capture TTL
- sign/freeze/upload/copy-link flow
- local clear after upload
- capture-context preview/redaction before upload

### 3.9 `producers/emacs`

Native producer for Emacs.

Owns:

- minor mode
- `after-change-functions` capture
- buffer/session status
- sign-buffer command
- conformant event logs
- capture-context preview/redaction before upload

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
  "source": "paste",
  "ins_hash": "b3:..." // optional; omitted in public/default content-blind mode
}
```

Requirements:

- `seq` is monotonic, gap-free, and starts at 0.
- `t` is integer milliseconds since session start.
- `pos`, `del_len`, and `ins_len` are Unicode codepoint offsets/lengths, not UTF-16 units and not bytes.
- `op` is one of `insert`, `delete`, `replace`.
- `source` is one of `typing`, `paste`, `cut`, `drop`, `ime`, `autocomplete`, `programmatic`, `unknown`.
- Producers must not label uncertain input as `typing`; use `unknown` when attribution is degraded.

Manifest includes:

```jsonc
{
  "format_version": "0.1",
  "record_hash": "b3:...",
  "session_id": "uuid",
  "producer": {
    "id": "browser-extension",
    "version": "0.1.0",
    "capabilities": ["timing", "source_attribution", "selection", "pause_fidelity", "keystroke_level"]
  },
  "capture_context": {},
  "event_count": 1429,
  "duration_ms": 1384502,
  "final_text_hash": "b3:...",
  "final_text_length": 5821,
  "created_client_t": "client-claimed timestamp, untrusted",
  "ingested_server_t": "server-stamped timestamp, trusted if present",
  "parent_record": null,
  "attestations": []
}
```

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

Privacy rules:

- The signer must be able to review, edit, or omit capture context before upload.
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
final_text_length

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
- Define an idle threshold in code/config, e.g. 30 seconds, for active-vs-idle summaries.
- Keep raw events available for exact replay; stats are a render/cache optimization, not the source of truth.

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
final_text_hash          text not null
final_text_length        integer not null

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
3. `/`, `/docs/*`, `/blog/*` -> Hugo static site
4. Static assets for the Hugo site and Vite app -> static file serving
5. `/<short_signature>` -> Vite React record app

Reserved route prefixes/paths must not be emitted as short signatures: `api`, `docs`, `blog`, `assets`, `record-assets`, `health`, `ready`, `live`, and any future static/runtime prefix. Implementations may use a deterministic leading-`X` rescue candidate for hashes whose base58 prefix collides with a reserved route; future routes must not reserve `x`/`X` unless the rescue strategy changes too.

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
  "events": []
}
```

Backend behavior:

1. Validate schema.
2. Verify events are content-blind by default; no plaintext field is accepted in public mode.
3. Recompute canonical event bytes.
4. Recompute BLAKE3 hash chain.
5. Verify manifest `record_hash` equals final chain hash.
6. Verify `event_count`, `duration_ms`, `final_text_length`, and other manifest fields are structurally consistent where possible.
7. Stamp `ingested_server_t`.
8. Generate collision-checked `short_signature`.
9. Store immutable record row.
10. Compute and store `record_stats`.
11. Run v0 analyzers and store `analysis_results` if cheap enough synchronously; otherwise queue later.
12. Return record URL.

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
  "signals": []
}
```

Still content-blind.

### 10.3 `GET /api/health`

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
  ReplayScrubber
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
   - final text length
   - typing events / typed codepoints
   - insertions / deletions / replacements
   - paste/unknown counts
   - largest atomic insert
   - active vs idle time
   - delay distribution summary
4. Replay scrubber.
5. Analyzer signals as facts.
6. Verification panel.

### 11.2 Replay scrubber in content-blind mode

The public service should not render text. Instead, replay visualizes structure:

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
/blog/*
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

- Unlike the sister `aweb-cloud` project, the Hugo landing/docs/blog site is not deployed as a separate static surface for v0.
- Hugo output must be included in the same production Docker image as the API and Vite record app.
- The container serves Hugo for `/`, `/docs/*`, and `/blog/*`, while preserving `/<short_signature>` for record pages.

---

## 13. Producer UIs

### 13.1 Browser extension UI

Primary normal-user author UX.

Surfaces:

- Field badge on textareas/contenteditable fields.
- Extension popup listing current captured sessions.
- Sign modal: “Finish & get link.”
- Capture-context review/redaction before upload.
- Degraded-capture warning where applicable.
- Toast after signing: “Record saved, link copied.”

Behavior:

1. Capture passively and locally.
2. User signs when they want a link.
3. Signing freezes the session.
4. Extension computes final text hash locally.
5. Extension uploads content-free manifest/events.
6. Backend returns short URL.
7. Extension copies URL to clipboard.
8. Local log is cleared after successful upload.
9. Further edits start a new session.

Unsigned local capture TTL:

- Default 3 days after last edit.
- Sweep opportunistically on startup, new field capture, and session access.
- Alarm-based cleanup may be a backup but not the only cleanup mechanism.

### 13.2 Emacs UI

Commands:

```text
pmbah-mode
pmbah-sign-buffer
pmbah-show-session-status
pmbah-discard-session
```

UX:

- mode-line capture indicator
- sign-buffer command
- capture-context review/redaction before upload
- upload returns and copies short URL

---

## 14. Deployment architecture

Deploy the public service as a **single Docker container** containing:

1. the Node/TypeScript ingestion API/runtime;
2. the built Vite React record app;
3. the built Hugo landing/docs/blog site.

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
- serve Hugo static output for `/`, `/docs/*`, and `/blog/*`;
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
- Implement deterministic replay with Unicode codepoint offsets.
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
- Build one runtime image containing API + Vite record app + Hugo landing/docs/blog output.
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
- Implement content-blind replay scrubber.
- Implement signal cards.
- Implement verification panel with browser-side chain verification.

### M5 — Hugo landing/docs/blog

- Implement landing page.
- Add docs and threat model pages.
- Ensure routing works with Vite app and backend.

### M6 — browser extension producer

- Capture text fields/contenteditable.
- Local session store and TTL.
- Capture-context preview/redaction.
- Sign/freeze/upload/copy-link flow.
- Conformance pass.

### M7 — Emacs producer

- Minor mode capture.
- Sign-buffer/upload flow.
- Capture-context preview/redaction.
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
- Do not conflate unsigned local TTL with uploaded server record lifetime.
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
