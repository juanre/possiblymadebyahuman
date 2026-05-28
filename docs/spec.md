# possiblymadebyahuman — Technical Specification (v0.1)

Status: draft for implementation. Audience: the engineering team taking this over.

---

## 1. What this is

> We can't prove a human wrote this. This is us caring enough to show you anyway.

That sentence is the product. Everything below serves it.

`possiblymadebyahuman` records the *editing process* that produced a piece of writing and presents it as a hash-addressed, replayable record. A reader can scrub through how the text was built. The name's hedge is deliberate and load-bearing: "possibly" is not weakness, it is the honest part, and the honesty is what makes the gesture worth anything.

### 1.1 The thesis: costly signaling, not proof

The value of this system is **not** that it proves authorship. It can't, and we say so. The value is that producing and sharing a record is *costly* — you ran the capture, you're handing someone a replay they can inspect, you're inviting scrutiny instead of asserting a verdict. **Caring enough to show your work is the message.** Like a handwritten thank-you note, it proves nothing about sincerity yet is unfakeable-in-spirit, because the people who don't mean it don't bother.

This reframes who the product is for and what it must withstand. It is a gesture between people who already half-trust each other (a flagged forum comment, a contested essay, a freelancer showing a client the deliverable took real work) — not a fraud-grade authority that adversaries are motivated to defeat at scale. A spammer laundering AI output will not set this up for a cold blast; the friction that makes it useless for mass fraud is exactly what makes it meaningful as a gesture. We are not in an arms race, and we win by refusing to enter one.

### 1.2 Tone is a feature

Lightweight and a little funny, on purpose. A solemn authorship-verification *authority* invites attack, because people attack things that take themselves seriously as judges. A tool that opens with a shrug — "we can't really win this, but here's us caring anyway" — got to the cynicism first, and the self-awareness is armor. Keep that voice in the copy, the UI, and the README.

### 1.3 What the system is allowed to claim

The only claim any part of this system may make:

> This record shows the shape of an editing process. It makes pasted and atomically-inserted content visible. It does **not** prove that a human originated the ideas, and it cannot detect a human retyping an AI draft from another screen.

Three rules follow, binding every decision below:

1. **No verdict.** The system never emits a binary "human / AI" judgment or a confidence-percentage badge. It shows the replay and *descriptive signals* with explanations, and lets a human conclude. A verdict would relocate us into the unreliable-detector trap and attach our name to any forged log that passes — and it would betray the gesture, which is an invitation to look, not an assertion to trust.
2. **Process, not content.** The public service stores the *structure* of the edit history, not the text. The captured text never leaves the client in the default deployment.
3. **The format is the product (technically).** The web app is a reference producer. The real artifacts are the event-log specification (§3) and the analyzer interface (§6). Everything else is a producer or consumer of those two contracts.

We are not building a detector, a plagiarism checker, or a keylogger. We are building a lightweight, extensible, tamper-evident *writing-record* format plus a reference implementation — a way to make a stand and show you cared.

### 1.4 What this lets us NOT build (for v0)

Because we are explicitly *not* making a proof claim, the heavy anti-forgery machinery is out of scope for the first version. A determined forger can fake a caring-gesture — but faking a gesture nobody is being graded on is a strange use of effort, so the threat barely applies. Concretely, **deferred out of v0**: server-streaming timestamp attestation, entropy/rate plausibility checks, third-party timestamping, client attestation (all of §4.3 beyond a plain ingestion timestamp). We still hash-chain the log so it is at least **tamper-evident** (§3.5) — cheap, and it protects the gesture's integrity — but we do not pretend it is tamper-proof. The proof-grade version can come later, for the later audience that actually wants it (§8, §10).

---

## 2. Architecture overview

Four layers with hard boundaries. Features extend *down* layer 3 (analyzers); input modes extend *across* layer 1 (producers). The two axes meet only at the event-log format, so a contributor can add a VS Code producer without understanding any analyzer, and add a new heuristic without understanding any producer.

```
  Layer 1  PRODUCERS          web form · emacs mode · VS Code ext · Docs-history importer
              │  emit Event Log (§3)
              ▼
  Layer 2  INGESTION          verify hash chain · content-address · (optional) server timestamp · store immutably
              │  stored Record (§4)
              ▼
  Layer 3  ANALYZERS          timing · edit-topology · paste-ratio · pause/position coupling · …  (plugins, §6)
              │  Signals (§6.2)
              ▼
  Layer 4  PRESENTATION       hash-addressed page: replay scrubber + signals as facts (§7)
```

The rule for v0: **two of everything.** Two producers (emacs minor mode + capture-all browser extension, §2.1) and two analyzers (timing + edit-topology), even in the first release, so that the format and the plugin interface are exercised by more than one implementation before they are frozen. Single-implementation boundaries bake in single-case assumptions. The two chosen producers span the widest useful gap — a non-browser native editor and a browser environment — so neither is a throwaway demo and the format is stressed across genuinely different capture surfaces before it is frozen.

### 2.1 The two v0 producers

**emacs minor mode (native, for the author and the emacs community).** Hooks `after-change-functions`, which hands the producer `(beg end len)` for every buffer change from any source — typing, yank, `kill-region`, `query-replace`, macros, programmatic edits. That is the mutation stream natively, with none of the keystroke-reconstruction mess; it is the cleanest capture surface we have. Small, elegant, and a real tool for a small high-affinity audience, not a personal hack.

**Capture-all browser extension (the distribution play).** Meets non-technical people in the text field they are already typing in — the forum reply box, Gmail, a CMS field — with zero behavior change, which for that audience is the whole game. One artifact covering many sites. Design below.

The earlier idea of a website with its own text box is **demoted to an optional format demo**, not a real usage path: asking people to leave where they write, come to our box, and carry a link back stacks friction at the exact moment they are least motivated. People do not change where they write to pre-empt an accusation that has not happened yet.

### 2.2 Browser-extension producer design

**Capture-all, content-blind, local.** The extension attaches a capturer to text fields as they appear and records passively from the first edit. Nothing is sent anywhere until the user signs (§2.2.3). This is acceptable — indeed better than arm-then-write — precisely because capture never leaves the machine, the store is content-blind, and the project is OSS so the "we never send your keystrokes" claim is auditable rather than trust-me. Store mutation *shapes* (positions, lengths, timings, sources), never plaintext, at most a salted `ins_hash`; the privacy promise must survive someone reading the local store.

Capture-all makes signing a **retroactive** decision: write first, decide to sign after. This fits reality — you do not know you will need to prove authorship until someone accuses you, by which point arm-then-write is too late. Capture-all means the evidence already exists.

#### 2.2.1 Per-field identity

Each field gets a random id minted when the capturer first sees it, held in memory keyed to the live DOM node; its mutation log is keyed to that id. Stability across reloads is not required (a reload is a new session). The hard cases:

- **Multiple fields on a page** (subject + body; comment + reply): each gets its own id and independent log. Sign seals only the focused field.
- **Field re-mounts under you** (SPA re-render replaces the `<textarea>` node while the field looks unchanged on screen): the node→id map breaks exactly when the user thinks nothing changed. Detect re-mounts and either re-attach the existing log to the new node or accept a clean session boundary. This is the genuine engineering fiddliness of this producer — more than the capture itself.
- **Rich-text / contenteditable** (Gmail body, many comment boxes): these mutate via their own handlers; `beforeinput` visibility is partial. Declare degraded capability (§4.2) for such fields and emit `source: unknown` rather than minting confident-looking attribution over a half-observed stream. Degrade gracefully and *announce* the degradation; never fake confidence.

#### 2.2.2 Focus, blur, and pauses

The captured field stays the session regardless of focus coming and going — clicking away to copy a URL, alt-tabbing to read, returning to write more all stay one session. Genuine long idle (walked away for an hour) is recorded as one session with a real gap in `t`, per §3.6; the timing analyzer reports the long pause as a fact rather than the producer splitting or compressing it. Blur/focus session handling on a live web field is the fiddly part, not the capture.

#### 2.2.3 The sign loop

The entire user-facing loop, no site visit, no leaving the page:

1. Write normally in the field; capture is already running.
2. Click sign (icon or the field badge) → "finish & get link."
3. The extension hash-chains that field's log, computes `final_text_hash` from the locally-reconstructed buffer (the determinism check, §3.2), POSTs the **content-free** record, receives `/<record_hash>`, copies it to the clipboard. Toast: "record saved, link copied."
4. Paste the link wherever — into the comment, or hand it to whoever is accusing you.

**Freeze on sign.** Signing freezes that field's session: further edits start a *new* session. A signed record must correspond to a definite state; "I signed then kept editing" would muddy what the link attests. **Clear on sign.** Once uploaded, drop the local log immediately — it has served its purpose and is now on the server. Manual paste only in v0; auto-appending the link to a site's submit is more magic, more fragile per-site, and presumptuous (it edits the user's text) — defer as a per-site nicety.

#### 2.2.4 Local cleanup / TTL

Unsigned local captures **expire N days (default: 3) after their last edit** — TTL measured from last activity, not creation, so a slow multi-day draft survives as long as it is being touched. If a capture was not signed within the window, it was never going to be; the TTL costs nothing real and bounds the local store. Two clean end-states only: **signed → uploaded → local copy cleared immediately**, or **unsigned → expired and gone**; nothing lingers between.

Cleanup mechanism: do not rely on a background timer (extension service workers get killed). Stamp each session with an expiry and sweep opportunistically — on extension startup, on each new field capture, and lazily discarding any expired session encountered — with a periodic alarm as backup.

This TTL applies to **unsigned local captures only**, and must not be conflated with server record lifetime (§5.1), which is the opposite policy.

---

## 3. The Event Log format (the core contract)

This is the spec the whole repo organizes around. Version it independently of any implementation. Current: `format_version: "0.1"`.

### 3.1 The primitive is a buffer mutation, not a keystroke

A keystroke does not map cleanly to a text change: paste, cut, select-and-replace, drag-drop, IME composition, autocomplete, and programmatic edits all mutate the buffer without a 1:1 key→character correspondence. Modeling the unit as a *mutation* makes all of these collapse to one primitive, makes deterministic replay possible, and turns paste from a hole in the model into a visible, labeled event.

A mutation:

```jsonc
{
  "seq": 412,              // monotonic integer, gap-free, starts at 0
  "t": 184523,             // ms since session start (integer)
  "op": "replace",         // "insert" | "delete" | "replace"
  "pos": 1043,             // codepoint offset into the buffer BEFORE this op
  "del_len": 12,           // codepoints removed at pos (0 for pure insert)
  "ins_len": 47,           // codepoints inserted at pos (0 for pure delete)
  "source": "paste",       // see §3.3
  "ins_hash": "b3:…"       // OPTIONAL: hash of inserted text (see §3.4)
}
```

Notes:

- Offsets and lengths are in Unicode **codepoints**, not UTF-16 units and not bytes. Producers must normalize. This is the single most common place implementations will disagree; it is mandatory and tested.
- `op` is derivable from the lengths (`del_len>0 && ins_len>0` ⇒ replace) but is stored explicitly for cheap filtering and human readability.
- `t` is relative to session start. Absolute wall-clock time, if attested, lives on the record manifest (§4), not on every event — that keeps the event stream content-free and lets the ingestion layer be the authority on real time.

### 3.2 Determinism requirement

Applying the mutations in `seq` order to an empty buffer must produce the final text, exactly. A verifier confirms this by reconstructing the buffer locally and comparing its hash to `final_text_hash` on the manifest (§4) — **without the text ever being transmitted**, because the verifier either has the text (the author, re-checking) or only needs to confirm the producer's own claim is internally consistent.

Producers are responsible for emitting a stream that satisfies this. The conformance test suite (§9) is the arbiter.

### 3.3 The `source` field

Enumerated, extensible, and central to honesty about input fidelity:

| value | meaning |
|---|---|
| `typing` | character-by-character entry attributable to discrete input events |
| `paste` | insertion from clipboard |
| `cut` | deletion to clipboard |
| `drop` | drag-and-drop insertion |
| `ime` | committed IME composition |
| `autocomplete` | editor/OS-suggested completion accepted |
| `programmatic` | edit not originating from a user input gesture (macro, script, find-replace) |
| `unknown` | producer cannot attribute the source |

A producer **must not** label something `typing` it cannot prove was typing. `unknown` is the correct, honest fallback and must be available. A producer that can only ever emit `unknown` (e.g. a Docs-history importer) declares this via capabilities (§4.2) so analyzers do not penalize a coarse source for looking suspicious.

### 3.4 `ins_hash` and the content-privacy boundary

By default the public service is **content-blind**: `ins_hash` is omitted entirely, and the event log carries only the *shape* of edits (positions, lengths, timings, sources). This makes "we do not store your text" an architectural property, not a policy promise.

A producer **may** include `ins_hash` (a per-insertion hash, salted per-record) when a deployment wants tamper-evidence on individual insertions without storing plaintext. A private/self-hosted deployment **may** additionally store plaintext via an out-of-band content blob, gated behind an explicit `stores_content: true` capability. The public reference deployment sets neither.

Hash algorithm: BLAKE3, prefixed `b3:`. All hashes in the system use the same algorithm and prefix convention so the chain (§3.5) and any content hashes are consistent.

### 3.5 Hash chaining (tamper-evidence)

Events are chained so the log cannot be silently edited after the fact:

```
chain[0]   = H(format_version ‖ session_id ‖ canon(event[0]))
chain[i]   = H(chain[i-1] ‖ canon(event[i]))
```

- `H` = BLAKE3.
- `canon(event)` = canonical JSON serialization: keys sorted lexicographically, no insignificant whitespace, integers as integers, `ins_hash` omitted if absent (not null). The canonicalization algorithm is specified precisely in `/spec/canonicalization.md` and is part of the conformance suite — two conformant producers must produce byte-identical `canon` for the same logical event.
- The final `chain[n-1]` is the **record hash**, and is the `/…` address of the record (§5).

Chaining gives tamper-*evidence*, not tamper-*proofing*: a producer can still fabricate an internally consistent log from scratch (§8). Server-side ingestion timestamping (§4.3) is the mitigation for that, and it is a property stamped by Layer 2, not something a producer can forge.

### 3.6 Sessions, pauses, and merging

- A **session** is one continuous capture with one `session_id` (UUIDv4). `t=0` is session start.
- Producers should record genuine pauses as genuine gaps in `t`; they must not silently compress idle time, because pause structure is signal (§6).
- Multiple sessions composing one document (you wrote over three days) are stored as separate event logs and stitched at the record level via a `parent_record` link on the manifest. Analyzers may operate per-session or across the linked set; each declares which.

---

## 4. The Record and its manifest

A **Record** = one event log + a manifest. The manifest is content-free metadata describing provenance of the *capture*, not the text.

### 4.1 Manifest fields

```jsonc
{
  "format_version": "0.1",
  "record_hash": "b3:…",          // = final chain hash; also the URL slug
  "session_id": "uuid",
  "producer": {
    "id": "web-reference",        // stable producer identifier
    "version": "0.3.1",
    "capabilities": ["timing", "source_attribution", "selection"]  // §4.2
  },
  "event_count": 1429,
  "duration_ms": 1384502,
  "final_text_hash": "b3:…",      // for the determinism check (§3.2)
  "final_text_length": 5821,      // codepoints
  "created_client_t": "…",        // client-claimed wall clock (UNTRUSTED)
  "ingested_server_t": "…",       // server-stamped (TRUSTED if present) §4.3
  "parent_record": null,          // or a record_hash, for multi-session docs §3.6
  "attestations": []              // §4.3
}
```

### 4.2 Capabilities — the field that makes heterogeneous inputs comparable

Every producer declares what it can observe. This is the unglamorous piece most designs skip and then cannot add a low-fidelity importer without breaking scoring. Declared capabilities tell analyzers what is *absent by design* versus *suspiciously missing*.

Defined capabilities (extensible list):

| capability | the producer can observe… |
|---|---|
| `timing` | per-event millisecond timing |
| `source_attribution` | reliable `source` values beyond `unknown` |
| `selection` | cursor/selection state, enabling accurate replace attribution |
| `pause_fidelity` | genuine idle gaps (not coarse autosave snapshots) |
| `keystroke_level` | sub-edit granularity (individual keys within a word) |

A Google-Docs-revision importer might declare only `[]` or `[pause_fidelity:false]`-style absence and emit `source: unknown` throughout. Analyzers that need `source_attribution` then return *not applicable* for that record rather than a damning low score. An importer must never be scored as if it were a high-fidelity live capture that happens to look weak.

### 4.3 Attestations and server timestamping

Layer 2 may add attestations — facts the *server* vouches for, distinct from anything the producer claims:

- `ingested_server_t`: the server's clock when events arrived. For *streaming* ingestion (events POSTed as they happen), this anchors the timeline to a clock the author does not control, which is the primary defense against a fully synthetic log (§8).
- Future: third-party timestamping authority, transparency-log inclusion proof.

Attestations are additive metadata; their presence or absence is shown in the UI (§7). The system never pretends an unattested record is attested.

---

## 5. Addressing and storage

- **Address = record hash.** The URL `https://possiblymadebyahuman.com/<record_hash>` *is* a commitment: anyone can recompute the chain from the stored events and confirm the page was not swapped. Random tokens would mean "trust our database"; content-addressing means "verify it yourself." Same UX, stronger claim, no extra work. (Slug may be a truncated, collision-checked prefix of the full hash for readability; the full hash is always shown on the page.)
- Storage is **immutable and append-only** per record. No edit endpoint.
- Layer 2 is deliberately dumb: verify chain → content-address → optionally stamp time → store. No analysis happens here, so storage and analysis scale and version independently.

### 5.1 Server record lifetime (durable by default)

A signed, uploaded record is **permanent by default.** This is the deliberate opposite of the local-capture TTL (§2.2.4), and the two must never be conflated. The reasoning: the entire point of the `/<record_hash>` link is that it works when pasted into an argument, possibly months later. A dead provenance link is worse than no link — it reads as "the proof vanished," actively undermining the gesture. So uploaded records do not expire.

Counterbalancing controls:

- **Owner delete.** The signer can delete their own record. Deletion is real removal, not a tombstone, and afterward the link 404s honestly. The owner is identified by a capability returned at sign time (a delete token / account binding) — decide the mechanism, but the signer must be able to retract.
- Because the upload is content-free, a permanent record exposes only edit *shape*, not text — so durable retention is a modest privacy footprint by design.

Summary of the two opposite policies, stated together so no one mixes them up: **unsigned local captures expire in days; signed server records are permanent until the owner deletes them.**

---

## 6. Analyzers — the feature-extensibility axis

### 6.1 Plugin, not pipeline

Each analyzer is a **pure function** `(EventLog, Manifest) → Signal`. Analyzers are independent: they do not see each other's output, cannot veto each other, and run in any order. Adding research is: write an analyzer, register it, done — including re-running it over *already-stored* records to enrich them. No core change, ever, to add a heuristic.

Independence is the safety property: a weak, biased, or wrong analyzer pollutes only its own signal, not the record. There is no aggregate score to corrupt because there is no aggregate score (§6.3).

### 6.2 The Signal type

```jsonc
{
  "analyzer_id": "edit-topology",
  "analyzer_version": "1.0.0",
  "applicable": true,            // false ⇒ required capabilities absent; UI shows "n/a"
  "measures": [                  // descriptive facts, never a verdict
    { "key": "atomic_insert_max_len", "value": 340, "unit": "codepoints" },
    { "key": "deletion_count", "value": 412 },
    { "key": "interleave_ratio", "value": 0.83 }
  ],
  "human_range": {               // OPTIONAL: where typical human values fall, for context
    "interleave_ratio": [0.4, 0.95]
  },
  "explanation": "One insertion of 340 characters arrived in a single operation with no preceding edits, consistent with a paste. The remainder shows small interleaved insertions and deletions."
}
```

Hard rules for analyzer authors:

- Emit **measurements and plain-language explanations**, not conclusions. "One 340-char atomic insert at 3:21" — not "likely AI."
- If required capabilities are absent, set `applicable: false`. Never infer-and-penalize missing data.
- Version the analyzer; the record shows which analyzer versions produced which signals so results are reproducible and comparable over time.
- Be a pure function of the log. No network, no global state, no per-author memory (biometric identity is explicitly out of scope for v0, see §10).

### 6.3 No aggregation in v0

The presentation layer shows the list of signals. It does **not** combine them into a score. If a future version wants a combined view, it must be an *additional, clearly-labeled, optional* analyzer-of-analyzers that itself obeys §6.2 (descriptive, versioned, explainable) — never a headline verdict.

### 6.4 v0 analyzers (the two required)

1. **timing-distribution** — inter-event interval distribution; flags intervals outside human ranges; reports active vs idle time. Requires `timing`.
2. **edit-topology** — ratio of small interleaved edits to large atomic inserts; deletion count and clustering; largest atomic insert; revision "dead-ends" (text inserted then later deleted). Requires nothing beyond the base log; richer with `source_attribution`.

Both ship in v0 specifically to exercise the plugin interface with two different capability requirements before it is frozen.

### 6.5 Roadmap analyzers (not v0, listed to shape the interface)

- **paste-ratio** — fraction of final text arriving via `source: paste`/`drop`/large atomic inserts.
- **pause/position coupling** — whether pauses cluster where composition is cognitively hard (sentence/clause boundaries, first use of a term) versus uniform transcription rhythm. This is the signal that takes a real swing at the "human transcribing an AI draft" case, and the whole architecture exists so it drops in as just another analyzer.

---

## 7. Presentation layer

The record page, at the hash address, contains:

1. **Replay scrubber (the hero).** Reconstructs the buffer step by step from the event log and lets the reader scrub/play the writing unfolding. In content-blind mode it renders structure (insert/delete positions, sizes, sources, timing) rather than the words; in a content-bearing deployment it can render the text. The replay is the thing that actually persuades a skeptic — make it primary, not the signals.
2. **Signals as facts.** Each analyzer's `measures` and `explanation`, with `human_range` context where given, and a clear "not applicable" state. Never a badge, never a percentage-human, never a pass/fail on humanness.
3. **Verification panel.** The full `record_hash`; a one-click "re-verify chain" that recomputes it in the browser; the determinism check result; producer id/version/capabilities; which attestations are present (e.g. "timeline server-attested" vs "client-claimed time only"); analyzer ids/versions.
4. **The standing disclaimer**, in plain sight: what the record does and does not establish (§1).

The word "certificate" does not appear unqualified. The page is a **writing record**, not a certificate of humanity.

---

## 8. Threat model (state it in the README)

Read this through the §1 thesis: we are defending *the integrity of a gesture*, not erecting a fraud-grade authority. The bar is **"forging is more annoying than just writing,"** and — more to the point — **forging a gesture nobody is grading is a strange use of effort.** We do not claim impossibility and we do not enter an arms race.

| attack | does the system catch it? |
|---|---|
| Copy-paste of AI text into the editor | **Yes** — appears as a large atomic insert with `source: paste`; visible in replay and edit-topology. |
| Silent post-hoc editing of a stored log | **Yes** — breaks the hash chain; re-verification fails. |
| Swapping the page behind a URL | **Yes** — URL is the record hash; recompute and compare. |
| Fully synthetic log (a script emits a plausible internally-consistent mutation stream with a correct final-text hash, never touching a keyboard) | **No, and v0 does not try.** The hash chain and determinism check both *pass* — the log is internally consistent, just fabricated. This is acceptable: it costs real effort to fake a gesture that carries no verdict and grants no authority, so the incentive is largely absent. Defenses (streaming server timestamp, entropy checks, client attestation) are **deferred** (§1.4, §4.3) until a proof-grade audience needs them. |
| Human retypes an AI draft from a second screen | **No.** Same information-theoretic ceiling every process-based approach hits. Atomic paste is caught; manual retyping is not. The pause/position-coupling analyzer (§6.5) is the only thing that takes a swing, and only probabilistically. |

What we *do* defend, cheaply, with the hash chain: a shared record can't be tampered with after the fact or swapped behind its URL without detection. That is enough to keep the gesture honest. Everything beyond it is a later, optional, proof-grade tier — not the thing we are shipping or the thing we are.

---

## 9. Conformance and testing

The format is only real if independent producers agree. Ship a **conformance suite** alongside the spec:

- **Canonicalization vectors**: logical events → expected `canon` bytes → expected chain hashes. Any producer in any language must reproduce these byte-for-byte.
- **Determinism vectors**: event logs → expected `final_text_hash`. Catches codepoint/UTF-16/byte offset bugs, the most common disagreement.
- **Capability honesty checks**: a producer declaring `source_attribution` must never emit `unknown` for events it could attribute; importers must declare absence.
- **Golden records**: a handful of real captured sessions (a genuine compose, a paste-heavy session, a synthetic log) with expected analyzer outputs, so analyzer changes are diffable.

A producer is "conformant" iff it passes canonicalization + determinism + capability-honesty. Put the badge criteria in the repo.

---

## 10. Explicit non-goals for v0

- **No biometric identity / typing-signature enrollment.** It authenticates *who typed*, not *who originated*, needs multi-session data we will not have on day one, and is orthogonal to the v0 value. Revisit as a v2 friction layer ("the enrolled author personally typed this, so the labor can't be outsourced"), implemented as analyzers that may hold per-author state — which is why §6.2 forbids per-author state in the *base* analyzer contract, to keep that complexity quarantined when it arrives.
- **No combined/aggregate humanness score** (§6.3).
- **No content storage in the public deployment** (§3.4).
- **No OS-level keystroke capture.** A producer that owns its text buffer (browser field, emacs buffer, editor extension) can satisfy determinism; an OS keylogger observes a motor stream that does *not* reconstruct the final document in someone else's app, dropping us from "reproduce" to "correlate," which is both forgeable and unreliable. Producers must own a buffer.

---

## 11. Suggested build order

1. **Spec repo first.** `format_version 0.1`: event schema, `canonicalization.md`, chaining, manifest, capabilities, conformance vectors. This is the artifact everything references.
2. **Reference producer #1 — emacs minor mode.** Hooks `after-change-functions` (which hands you `(beg end len)` for every change from any source — the mutation stream natively). The cleanest capture surface and the smallest producer; proves the format against a real long-form, non-browser workflow first. Content-blind, passes conformance. (§2.1)
3. **Reference producer #2 — capture-all browser extension.** Content script attaching a `beforeinput`/`input` capturer to text fields; per-field id with re-mount handling, capability degradation on rich-text fields, focus/blur session handling, sign-to-seal loop (freeze + clear + upload + clipboard link), few-day TTL on unsigned local captures. The distribution play and the fiddlier producer; build it second, against a format already proven by emacs. (§2.2)
4. **Ingestion + storage.** Chain verification, content-addressing, immutable store, **permanent signed records with owner-delete (§5.1)**. A plain ingestion timestamp is fine; streaming/attested timestamping is deferred (§1.4).
5. **Analyzers — timing-distribution and edit-topology.** Two capability profiles to exercise the interface.
6. **Presentation.** Replay scrubber first (the hero), then signals-as-facts, then verification panel, then the disclaimer.
7. **Conformance suite wired to CI**, gating any change to the format or a producer.

Build "two of everything" (emacs + browser extension, timing + topology) in v0 so no boundary is defined by a single implementation. The optional website text box is a format demo, not a build-order item.

---

## 12. Glossary

- **Mutation** — one buffer change: `{seq, t, op, pos, del_len, ins_len, source, ins_hash?}`.
- **Event log** — ordered, hash-chained list of mutations for one session.
- **Record** — event log + manifest; addressed by its hash.
- **Producer** — anything that emits a conformant event log (Layer 1).
- **Analyzer** — pure function from log to a descriptive Signal (Layer 3).
- **Signal** — measured facts + explanation from one analyzer; never a verdict.
- **Capability** — a declared observation the producer can make; lets analyzers tell "absent by design" from "suspiciously missing."
- **Record hash** — final chain hash; the record's content-addressed URL.
