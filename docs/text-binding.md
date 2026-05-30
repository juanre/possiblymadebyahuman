# Text binding

Status: **approved direction, design detail under review.** Coordinator
has signed off on the direction (bind a visible artifact to a record;
two separate claims; aggressive canonicalization as the starting
semantic; seal the binding into the signed surface). This document is the
implementation spec; the epic `default-aaaa.59` tracks the work. It does
not change the product promise: still content-blind in storage, still no
humanness verdict, score, or badge. The binding is artifact provenance,
not detection.

If accepted it amends spec `§3.4` (content opacity boundary) to permit
one text-derived commitment in the public manifest, and bumps the format
to `0.2` (the binding is sealed into `record_hash`).

---

## 1. The gap

A record commits to the *shape* of a writing process — per-event
`pos`/`del_len`/`ins_len`/`source`/`t`, hash-chained to a `record_hash`.
It commits to nothing about the text, so any document can be pointed at
any record: someone can write and sign one thing and publish another,
and nothing detects the swap, because the record never committed to the
document.

## 2. Design

Two cleanly separated claims. The system makes the first; the human
makes the second. The UI must never collapse them into a single
"verified" state.

### 2.1 Text binding — an automated claim of *wording*, not identity

At sign time the user selects the final text. The producer computes the
**aggressive canonical form** of the selection, hashes it, and the
commitment is sealed into `record_hash` (§2.4). The text itself is never
uploaded or stored.

```jsonc
"text_binding": {
  "scheme": "canon-letters/0.1",
  "policy": "prefix",          // "exact" | "prefix"
  "canonical_length": 1840,    // codepoints of the canonical form
  "commitment": "b3:..."       // b3(session_id ‖ canonical_form)
}
```

- `exact`: the candidate's canonical form must equal the committed one.
- `prefix`: **edge-anchored** (v1). The committed canonical form matches the
  whole candidate, its start (trailing material after it — e.g. an appended
  signature line), or its end (leading material before it — e.g. a quoted
  header), each by exact commitment equality on the relevant codepoint slice.
  There is no interior substring, fuzzy, or chunk search; a signed run that sits
  in the candidate's interior (material both before and after) does not match in
  v1. The normative rule lives in `docs/spec/canonicalization.md`.

**Default policy: `prefix`.** It tolerates accidental over-selection at one edge
— an appended footer/signature after, or a quoted header before — which `exact`
would reject; the producer lets the signer choose `exact` when they mean
"exactly this and nothing added."

### 2.2 Aggressive canonical form (`canon-letters/0.1`)

Operation order, applied to a Unicode-codepoint sequence: **NFKC →
full case folding → keep only code points with Unicode property Letter,
Number, or Mark**; drop everything else (punctuation, whitespace, symbols,
case). Case folding is Unicode Default Case Folding (full, language-neutral
— e.g. `ß` → `ss`), **not** locale lowercasing, which diverges on forms
such as Greek/polytonic. `canonical_length` and prefix slicing operate on
the post-fold codepoint sequence.
Digits are kept; separators and decimal points (punctuation) are dropped —
so the canonical form compares letters and digits in order but not number
*formatting*. Works for any script (Han ideographs are Letter; no ASCII
assumption).

`docs/spec/canonicalization.md` is **normative** and must pin: the Unicode
version baseline; the exact operation ordering above; codepoint-based
prefix slicing semantics (the `prefix` policy slices the canonical form by
*codepoint* count, never by UTF-16 unit or byte); and conformance vectors
covering combining marks, NFKC compatibility forms, non-Latin casefold,
surrogate handling, and the zero-length case.

**Zero-length canonical form is unbindable.** A selection that reduces to
nothing — symbol/emoji-only (`🎉🎉🎉`) or punctuation/whitespace only —
yields `canonical_length == 0`. Producers must refuse to create a binding
from it (sign without a binding, telling the user the selection has no
letters or digits to bind); the backend rejects any `text_binding` with
`canonical_length == 0`.

This is the deliberately robust, lossy starting semantic: it survives
the transformations a document suffers in transit — line rewrapping,
smart-quote substitution, collapsed/added spaces, non-breaking spaces,
case changes — because none of them touch letters.

**The honest meaning of a match is the load-bearing part of this whole
feature.** A match means *the same letters and digits, in order* — it is
**not** a check of exact text. Materially different texts that share an
ordered letter/digit sequence (e.g. `$1,000.00` and `$100,000` both
reduce to `100000`) verify as matching. That is acceptable **only
because we never claim identity**: the threat being closed is "a wholly
different document published under this record," and a wholly different
document has different letters. The match result must state plainly:

> **Same wording as the signed text.** This compares letters and digits in
> order and ignores spacing, punctuation, case, and number formatting — it
> is **not** a check of exact text.

Overclaiming (a bare "verified ✓", "identical", "authentic text") is
forbidden. The disclaimer travels with the result, not in a tooltip.

### 2.3 Commensurability — a human judgment, not an automated check

The binding proves wording; it says nothing about whether the recorded
process plausibly *produced* that much text. That question is contextual
(a forum comment, an email reply, and an essay differ), so it is left to
the reader. The record already publishes the raw materials — duration,
event count, typed codepoints, paste counts, largest atomic insert. The
record page presents the signed text's size alongside these. No
threshold, no automated verdict, no badge.

This handles quoted email cleanly: sign the whole reply, quotes included;
the binding proves "this is the email," the process stats show only a
fraction was actively written, and a quoted email visibly reads as
quoted — the reader reconciles it without the system pretending to.

### 2.4 Commitment model — sealing the binding into `record_hash`

The current `record_hash` commits to the **event log only** (the BLAKE3
chain seeded with `format_version ‖ session_id`); other manifest fields
are stored but not hash-committed. So a binding placed in the manifest
would be **server-mutable** — anyone storing or serving the record could
swap in a binding for a different text and the chain would still verify.
For something called a signature, that is unacceptable.

Therefore the binding is sealed into the record's identity hash:

```
event_tip = chain[last]                        // BLAKE3 event chain; seed uses format_version "0.2"
record_hash = event_tip                        // when no text_binding is present
record_hash = b3(event_tip ‖ canon(binding))   // when a text_binding is present
```

where `canon(binding)` is the existing canonical-JSON serialization of
the binding's `{scheme, policy, canonical_length, commitment}`.

Consequences:
- The short signature / URL derives from `record_hash`, so the URL
  commits to the bound text exactly as it commits to the events. The
  bound text cannot be changed without changing the URL.
- `verifyRecord` recomputes the event chain, then re-applies the seal
  when a binding is present, and compares to `manifest.record_hash`.
  Browser-verifiable, same as the event chain today.
- **Format version → `0.2`.** The event-chain seed includes
  `format_version`, so a `0.2` record's `record_hash` is **not**
  byte-identical to a `0.1` record over the same events — and it need not
  be. Existing `0.1` records keep their version, seed, and hashes and
  continue to verify under `0.1` rules untouched; `verifyRecord`
  dispatches on `format_version`. New conformance vectors cover the `0.2`
  no-binding and sealed cases; all existing `0.1` vectors must keep
  passing unchanged.

**Circularity note:** the commitment is salted with `session_id`
(`b3(session_id ‖ canonical_form)`), **not** with `record_hash` —
`record_hash` now depends on the binding, so it cannot also be an input
to the commitment. `session_id` is a per-record UUID nonce, sufficient to
defeat cross-record correlation and precomputed-dictionary attacks on the
canonical form.

**Verification dispatch.** `verifyRecord` reads `manifest.format_version`
and branches:
- `0.1`: recompute the chain with seed `format_version = "0.1"`; require
  `record_hash == event_tip`; a `text_binding` on a `0.1` record is
  invalid.
- `0.2`: recompute the chain with seed `format_version = "0.2"`; require
  `record_hash == event_tip` when no binding, else
  `record_hash == b3(event_tip ‖ canon(binding))`.

A producer that does not bind may keep emitting `0.1`; `0.2` is for
binding-capable producers. The version is a clean capability cut-over, not
a forced migration.

## 3. Verification (fully client-side)

The record page offers a check box. Given candidate text `C`:

- compute `canon(C)`;
- **exact**: pass iff `len(canon(C)) == canonical_length` and
  `b3(session_id ‖ canon(C)) == commitment`;
- **prefix** (edge-anchored): pass iff `len(canon(C)) >= canonical_length` and
  the committed form matches the candidate's start
  (`b3(session_id ‖ canon(C)[0:canonical_length]) == commitment`, with the
  remainder reported as appended material) **or** its end
  (`b3(session_id ‖ canon(C)[len−canonical_length:len]) == commitment`, with the
  leading codepoints reported as material before it). Equal-length candidates
  are the whole match. No interior search.

`session_id` and the binding are public in the record, so the browser
computes everything locally. The candidate text never leaves the page.

A very short `canonical_length` under `prefix` is ambiguous — many
documents share a short leading letter/digit sequence. The checker should
warn when the bound canonical length is below a small threshold rather
than present a confident prefix match.

## 4. UX

### 4.1 Signing flow (producers)

Common shape across producers: the signer **selects** the final text and
**affirms an explicit claim** before the binding is computed.

**Binding is on by default.** Signing computes a binding from the user's
selected text when the producer has an active selection, otherwise from the
producer's whole current writing surface; an explicit opt-out ("sign the
process only — don't bind a document") covers the case where the author is
still editing or deliberately won't pin the text. A selection/fallback text
whose canonical form is empty (§2.2) is unbindable: the producer disables
binding and offers process-only signing.

- The affirmation copy: *"I affirm this is the text this record is meant
  to cover."* with the chosen policy shown (`exact` / `prefix`) and the
  honest note that the binding compares wording, not exact text.
- `/write`: after writing, "Sign" → bind selected text in the writing
  canvas if present, otherwise all current canvas content → affirmation +
  policy → sign.
- Browser extension sign modal: bind selected text inside the active
  field/editor if present (for example, just the body text in Gmail),
  otherwise all current content of that field/editor → affirmation + policy
  → sign.
- Emacs `pmbah-sign-buffer`: use the active region if any, else whole
  buffer → affirmation + policy → sign.

Plaintext boundary: the producer reads the selection **locally**,
computes the canonical form and commitment, discards the text, and
uploads only `{scheme, policy, canonical_length, commitment}`. No
plaintext and no reversible text reaches the server, consistent with the
content-blind invariant.

### 4.2 Checking flow (record page, near the verification area)

- **Binding present:** a "Check a document" box; the reader pastes a
  document; the browser reports `exact` match / `prefix` match (with the
  count of appended characters) / no match, each carrying the §2.2
  "not exact text" disclaimer. A prominent "checked in your browser —
  nothing is uploaded" line. Separately and always shown, in a visually
  distinct card headed **"How this was written"**: the commensurability
  facts (§2.3) — signed-text size next to the process facts, closing with
  *"What counts as 'enough' is yours to read."* Never merged with the
  match result into one verdict.
- **No binding present** (legacy `0.1` records, and any record signed
  without binding): show plainly *"No document was bound to this
  record."* Do not hide the section; absence is honest information.

## 5. Explicitly out of scope

- Automated sign-time length/consistency checking — fragile on rich-text,
  confused by quoted text; replaced by §2.3 human judgment.
- Content-defined chunking / per-chunk leaf hashes / mid-document diffs —
  aggressive canon + `exact`/`prefix` covers the real cases.
- Process anchoring (per-checkpoint buffer commitments) — separate, larger
  effort with empirical unknowns.
- Server-mediated verification — verification is client-side; text never
  reaches the server.
- Google Docs producer — canvas-rendered; no process to record and no DOM
  selection to bind. The extension declares itself inapplicable there.

## 6. Honest limits

- A match means letters and digits, not exact text (§2.2); a genuine
  reword fails by design.
- Interleaved replies can't be one contiguous selection; v1 answer is
  "sign the whole reply, rely on visible quoting + commensurability."
  Multi-span selection is a future nicety.
- Commensurability needs an engaged reader; it is a judgment aid, not a
  guarantee.
- Google Docs is unsupported.

## 7. Rollout stages

1. **Format core** (`packages/format`, `packages/conformance`): the
   `text_binding` type, `canon-letters/0.1` canonicalization, sealed
   `record_hash` (format `0.2`), `verifyRecord` update, conformance
   vectors. Everything else depends on this.
2. **Backend** (`apps/ingest-api`, `packages/storage`): accept and
   validate `text_binding` on `POST /api/records` (recompute and check
   the seal), persist it, return it on `GET`. DB migration for the new
   manifest field.
3. **Checking UX** (`apps/web`): check box, exact/prefix/no-match
   results with the disclaimer, commensurability panel, no-binding state,
   client-side verification. May be built in parallel with stage 4, but
   **must not ship to users ahead of `/write` signing** — a checker with
   nothing to check against is meaningless.
4. **Signing UX — `/write`** (`apps/web` + `packages/producer-core`):
   selection + affirmation + local commitment compute + upload. Land this
   together with (or before) stage 3 at user-visible launch.
5. **Signing UX — extension and Emacs** (`apps/browser-extension`,
   `producers/emacs`): same flow on those producers; conformance pass.
6. **Docs/site** (`apps/site`): explain signing and checking, update the
   threat model, state plainly what a match does and does not mean.
