# Content-opaque browser capture feasibility spike

Task: `default-aaaa.37`. Investigates which `PendingMutation` fields can be derived from browser APIs **without retaining or exfiltrating text content**. Output: matrix + recommendations for the format and producer-core contracts. No production code.

## The invariant, after clarification

> Producers may **transiently** inspect editor/browser/Emacs text only when necessary to derive process metadata (numeric position, inserted/deleted length, selection range, operation classification). Transient means: read it synchronously in-memory, derive the number, **discard the string in the same statement / event handler**.
>
> Producers must never **retain** text: no putting it into session state, storage, logs, helper payloads, public records, debug output, local fixtures, or uploaded JSON. No content hashes (`final_text_hash`, `ins_hash`). No local plaintext replay as a correctness requirement. No initial baseline snapshot of pre-existing buffer content.

This makes the spike less about *can we count* (we can) and more about *can we prove we don't keep* (we can, via a small set of structural rules + an audit).

## Allowed-by-default surfaces

All of these may be read transiently in a `beforeinput` / `input` handler, used to compute one or more of `pos`, `del_len`, `ins_len`, `op`, `source`, and then discarded. The discarded string must not be assigned to a long-lived variable, returned across an `await`, sent over `chrome.runtime.sendMessage`, written to `chrome.storage.*`, or passed to any function whose return value is retained.

- `InputEvent.inputType` (always closed-enum string; trivial).
- `InputEvent.timeStamp`, `InputEvent.isComposing`, `InputEvent.detail`.
- `InputEvent.data` — the inserted text, when present. Read its `.length` (UTF-16) or pass it through `Array.from(str).length` (codepoints), then discard. **Do not assign** it to a `SessionRecord`, `PendingMutation`, persistence record, log, popup state, or message envelope.
- `InputEvent.getTargetRanges()` — `StaticRange` array. `startContainer` / `endContainer` are nodes; their `nodeType`, `nodeName`, parent references are fine. `Range.startContainer.data` (the text node string) may be read transiently for character counting and then discarded.
- `Selection.getRangeAt(0)` — same rules as above.
- `HTMLInputElement.selectionStart`, `selectionEnd` — pure numbers.
- `HTMLInputElement.value`, `HTMLTextAreaElement.value` — string; may be transiently read for length / codepoint count, then discarded. **Do not assign**.
- `HTMLElement.innerText`, `HTMLElement.textContent` — same rule.
- `CompositionEvent.data`, `ClipboardEvent.clipboardData.getData(...)` — same rule.
- `MutationRecord.oldValue` (with `characterDataOldValue: true`) — same rule (transient counting only).
- `KeyboardEvent.key`, `.code` — usable transiently for shape classification (e.g. counting Backspace presses); `event.key` may be the typed character and must be discarded after the classifier returns.

## Forbidden behaviours (the retention invariant)

These remain forbidden in v0, regardless of how briefly text was held:

- Storing inserted, deleted, full, or final text in `chrome.storage.*`, `localStorage`, `IndexedDB`, in-memory long-lived `Map`/`WeakMap` keyed off text content, popup state, or session records.
- Uploading text in `POST /api/records` or any other producer-to-backend channel.
- Passing whole-buffer, final-text, or inserted-text strings to helper subprocesses or external tools.
- Computing or storing content hashes/fingerprints of actual text content: `final_text_hash`, `ins_hash`, BLAKE3/SHA over `value`/`innerText`/`event.data`, etc. The chain hash over canonical public events is fine (it hashes process events, not text).
- Local plaintext replay as a correctness requirement (i.e. requiring `verifyRecord` to round-trip through the text).
- Initial baseline / snapshot of pre-existing buffer content as a stored fixture.
- Debug console statements that include the inserted text string. Logging `event.inputType` is fine; logging `event.data` is not.
- Test helpers in production source paths that take a `text` argument.

## Per-PendingMutation-field × per-case matrix

`op`, `source` from `inputType` are trivially derivable. Below: `pos`, `del_len`, `ins_len` per case.

Legend: ✓ direct (numeric only) · ✓† transient string read, immediately discarded · `0` always zero · n/a not applicable

### `<textarea>` and `<input type="text|search|email|url|tel">`

| Case (`inputType`) | source | `pos` | `del_len` | `ins_len` | notes |
|---|---|---|---|---|---|
| `insertText` (typing) | typing | ✓ `selectionStart` before | ✓ `getTargetRanges()[0]` size or `selectionEnd − selectionStart` before | ✓ via cursor-displacement OR ✓† `event.data.length` (UTF-16) / `Array.from(event.data).length` (codepoints) | both paths content-opaque; cursor delta needs no string at all |
| `insertLineBreak`, `insertParagraph` | typing | ✓ | ✓ | `1` (constant) | |
| `insertFromPaste`, `insertFromPasteAsQuotation` | paste | ✓ | ✓ | ✓ via cursor delta, or ✓† `event.data.length` | paste content discarded after counting |
| `insertFromDrop` | drop | ✓ | ✓ | ✓ via cursor delta, or ✓† | |
| `insertCompositionText` (mid-IME) | ime | ✓ | partial during composition | ✓ via cursor delta on `compositionend`, or ✓† over `event.data` on the final compositionend event | best practice: buffer mutations during composition, emit one mutation on end |
| `insertReplacementText` (autocomplete commit) | autocomplete | ✓ | ✓ via target range | ✓ via cursor delta, or ✓† over `event.data` | |
| `deleteContent*` family | typing | ✓ | ✓ via target range | `0` | |
| `deleteByCut` | cut | ✓ | ✓ | `0` | |
| `deleteByDrag` | drop | ✓ | ✓ | `0` | |
| programmatic `el.value = "…"` | programmatic | ✓† compare `value.length` before/after (transient counts only) | ✓† via diff of before/after `value.length` (lower bound only — net delta) | ✓† via diff of before/after `value.length` (net delta) | best-effort. The producer captures only net length deltas, never strings. If the change is a replace, `del_len`/`ins_len` are not individually distinguishable from net delta; the format should accept this honestly. |

### `[contenteditable=true]`

| Case (`inputType`) | source | `pos` | `del_len` | `ins_len` | notes |
|---|---|---|---|---|---|
| `insertText` (typing) | typing | ✓† via DOM walk: enumerate text nodes up to the target node, sum `.data.length` transiently and discard each | ✓† via `getTargetRanges()[0]` walk | ✓ via cursor delta after event, or ✓† `event.data.length` | a single discarded substring per event |
| `insertFromPaste` | paste | ✓† | ✓† via inserted node count (DOM mutations between before/after) | ✓† `event.data.length` if `data` is present; otherwise `unknown` — paste of rich HTML may not yield a clean `data` | escalation candidate: contenteditable paste of multi-node HTML may not have a meaningful single `ins_len`. The format should accept `null` for these cases. |
| `insertCompositionText` | ime | ✓† | partial | ✓ via cursor delta on `compositionend`, or ✓† | |
| `deleteContent*`, `deleteByCut` | typing / cut | ✓† | ✓† via target range walk | `0` | |
| `insertFromDrop` | drop | ✓† | ✓† | ✓† if data is a string; otherwise nullable | |
| programmatic (DOM mutation w/o `input` event) | programmatic | unknown unless inferred via `MutationObserver` | nullable | nullable | `MutationObserver(characterDataOldValue:true)` exposes `oldValue` as a transient string; counting only is allowed, but reconstructing every mutation is fragile. The format should accept `null`. |

**Bottom line**: every user-driven case is capturable content-opaquely. The narrow remainder — multi-node HTML paste into contenteditable, programmatic mutations — is honestly handled by allowing `null` in the public event schema.

## Codepoints vs UTF-16 units

Both are reachable now:

- UTF-16: `event.data.length`, `value.length`, range size — pure numbers from the engine.
- Codepoints: `Array.from(str).length` over a transiently read string. The string is discarded in the same expression.

The spike's previous recommendation to switch the spec to UTF-16 is no longer necessary. **Stay with codepoint semantics** as the original spec already says; producers compute codepoint counts via transient `Array.from(str).length` and discard.

Producers that *cannot* produce codepoint counts (Emacs's `after-change-functions` reports lengths in characters which in modern Emacs are typically codepoints, but old multibyte buffers might differ) declare honestly via a producer capability or emit nulls.

## Recommendations for the format (`.35`) and producer-core (`.36`)

Unchanged from the previous version, but with the rationale corrected:

1. **Drop `final_text_hash` and `final_text_length`** from the v0 public manifest. These are *retained* hashes of text content; the no-retention rule forbids them regardless of when the producer computed them.
2. **Drop `BufferMutation.ins_hash`**. Same reason.
3. **No `getInsertedText` or replay-with-text mode** in `verifyRecord`. Replay is a retention vector (the consumer would have to keep the original text to replay it).
4. **Producer-core's `sign(id)`** has no content parameter. Self-checks chain only.
5. **Format admits `pos`/`del_len`/`ins_len` as `number | null`.** Producers emit `null` only for cases where even transient inspection cannot derive a sensible value (multi-node HTML paste into contenteditable, programmatic mutations). The chain hash and validation handle nulls.
6. **Codepoint units stay** per the original spec; producers count via transient `Array.from(s).length` and discard.

## Recommendations for `.7` (browser extension)

- **Capture `<input type="text|search|email|url|tel">`, `<textarea>`, and `[contenteditable=true]` in v0.** Contenteditable is back in scope thanks to transient reads being allowed.
- **Compute `ins_len` via cursor displacement** where possible (cleanest, never instantiates a string); fall back to `Array.from(event.data ?? "").length` transient read for cases where displacement is ambiguous (composition, autocomplete). The transient pattern is:

  ```ts
  // ALLOWED — transient, discarded same statement
  const ins_len = event.data ? Array.from(event.data).length : 0;

  // FORBIDDEN — retains the inserted text on the session
  session.lastInsertedText = event.data;
  ```
- **No persistence of any text-derived string**. The `SessionRecord` written to `chrome.storage.local` has only numeric event fields plus `capture_context` (signer-approved provenance metadata). The `chrome.runtime.sendMessage` envelope between content script and service worker has no text fields.
- **No console.log of `event.data` or field values** in production source. Diagnostic logs may report `inputType` and numeric lengths.
- **IME**: buffer between `compositionstart`/`compositionend`, emit a single mutation on end, transient read for `ins_len` if cursor displacement is unreliable.
- **Programmatic capture**: best-effort via `MutationObserver`. When the only knowable length is "net delta" or "unknown", emit `null` rather than guess.
- **Source attribution**: declare `source_attribution` only if the manual evidence shows `inputType → Source` is reliable across the supported cases.

## No-retention audit (the new load-bearing test)

Three layers, in increasing strength.

### Layer 1 — Static greps for known retention sinks

A node test walks production source under `apps/browser-extension/src/`, `apps/web/src/write/`, `packages/producer-core/src/` and asserts no match for:

```text
# Retained-text sinks
\bchrome\.storage\.[^.]*\.set\([^)]*(?:value|innerText|textContent|\.data\b)
\blocalStorage\.setItem\([^)]*(?:value|innerText|textContent|\.data\b)
\bsessionStorage\.setItem\([^)]*(?:value|innerText|textContent|\.data\b)
\bindexedDB\b[\s\S]{0,200}(?:value|innerText|textContent|\.data\b)

# Retained-text crypto
\bb3HashText\b
\bbHashText\(.*value
\bsha\d+\(.*(?:value|innerText|textContent|event\.data)

# Retained-text shipped over the wire
\bsendMessage\([^)]*(?:value|innerText|textContent|event\.data\b)
\bfetch\([^)]*(?:value|innerText|textContent|event\.data\b)

# Banned helper symbols (retained-text or implies-retained-text)
\bgetInsertedText\b
\bReplayTextProvider\b
\breplayEvents\b
\breplayEventsWithText\b
\bcomputeFinalTextMetadata\b
\bfinal_text_hash\b
\bfinal_text_length\b
\bins_text\b
\bins_hash\b
\bplaintext\b
```

Hits in `.md` / `tests/**.test.mjs` are allowed if the reviewer ACKs them; production source must have zero hits.

### Layer 2 — Type-shape gate

`BufferMutation` in `packages/format` has no string fields about content. `PendingMutation` in `packages/producer-core/src/types.ts` likewise. `SessionRecord.events` is `BufferMutation[]`. The type system itself prevents `event.data` from being assigned into the public record — any attempt fails typecheck.

Producer-core message envelopes (`apps/browser-extension/src/lib/messages.ts`) have no fields typed as the inserted-text string. A typecheck pass guarantees that nothing flows from `event.data` into the service worker.

### Layer 3 — Runtime probe (optional, for `.7` Playwright smoke)

Drive the loaded extension through a Playwright fixture, type the literal string `RETENTION-CANARY-9F4A2B`, then inspect:

- `chrome.storage.local`: scan all values, fail if `RETENTION-CANARY-9F4A2B` appears anywhere.
- Every message intercepted via `chrome.runtime.onMessage` during the run: fail if the canary string appears.
- The mock backend's received payload: fail if the canary string appears.
- Any console log captured during the run: fail if the canary string appears.

This is the strongest evidence and the one the reviewer should ask for at `.7` handoff.

## Answers to the five open questions from the previous draft

1. **Tier 1 boundary**: moot. Transient text reads are explicitly allowed. The rule is no-retention.
2. **Length unit**: stay with codepoints per the original spec, computed via transient `Array.from(str).length`.
3. **Contenteditable in v0**: in scope. Captured via transient DOM walks for position/length; multi-node HTML paste cases that don't have a clean `ins_len` emit `null`.
4. **`KeyboardEvent.key`**: allowed transiently (just classification). No retention.
5. **Programmatic capture**: best-effort via `MutationObserver`. Net deltas only when individual lengths aren't knowable. Emit `null` rather than guess.

## What is NOT proposed

- No production code lands in this task.
- No new dependencies.
- No restoration of the `.7` stash in tracked form. Several pieces (field discovery, source attribution mapping, chrome adapters, popup UI) are reusable; they will be re-introduced as part of `.7` resumption after `.36` lands.

— frontend, `.37`
