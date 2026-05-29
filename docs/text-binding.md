# Text binding

Status: **proposal, not approved.** Needs coordinator and reviewer
sign-off before any implementation. If accepted it amends spec `§3.4`
(content opacity boundary) to permit one text-derived commitment in the
public manifest, and adds a verification surface to the record app
(`§11`). It does **not** change the product promise: still content-blind
in storage, still no humanness verdict, score, or badge. The binding is
artifact provenance, not detection.

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
makes the second.

### 2.1 Text binding — an automated claim of text identity

At sign time the user selects the final text. The producer computes the
**aggressive canonical form** of the selection, hashes it salted with
`record_hash`, and embeds the commitment in the manifest (covered by the
existing chain). The text itself is never uploaded or stored.

```jsonc
"text_binding": {
  "scheme": "canon-letters/0.1",
  "policy": "prefix",          // "exact" | "prefix"
  "canonical_length": 1840,    // codepoints of the canonical form
  "commitment": "b3:..."       // b3(record_hash ‖ canonical_selection)
}
```

- `exact`: the published text's canonical form must equal the
  committed one.
- `prefix`: the committed canonical form must be a prefix of the
  published text's canonical form. Covers the motivating case — sign a
  mail, then append `possiblymadebyahuman.com/<sig>`; the appended line
  is trailing material after the signed body.

**Aggressive canonical form.** Unicode NFKC → casefold → keep only code
points with Unicode property Letter, Number, or Mark; drop everything
else (punctuation, whitespace, symbols, case). This is what makes the
binding robust to the transformations a document suffers in transit —
line rewrapping, smart-quote substitution, collapsed/added spaces,
non-breaking spaces — none of which touch letters. It works for any
script (Han ideographs are Letter; no ASCII assumption).

The honest meaning of "match" under this canonicalization: *the same
sequence of letters and digits, in order, ignoring punctuation, spacing,
and case* — not byte-identical text. A genuine reword changes letters
and will correctly fail to verify.

### 2.2 Verification — fully client-side

The record page offers a "check a document against this record" box. The
browser canonicalizes the pasted text, recomputes the salted hash (or
the prefix hash at `canonical_length`), and reports match / no-match plus
the signed text's size. The candidate text never leaves the page.

### 2.3 Commensurability — a human judgment, not an automated check

The binding proves text identity; it says nothing about whether the
recorded process plausibly *produced* that much text. That second
question is inherently contextual — a forum comment, an email reply, and
an essay carry different expectations — so it is left to the reader.

The record already publishes the raw materials: duration, event count,
typed codepoints, paste counts, largest atomic insert. The record page
presents the signed text's size alongside these so a reader can judge
for themselves whether the writing process is commensurate with the
text. No threshold, no automated verdict, no badge.

This handles quoted email cleanly: sign the whole reply, quotes included;
the binding proves "this is the email," the process stats show only a
fraction was actively written, and a quoted email visibly reads as
quoted — the reader reconciles it without the system pretending to.

## 3. Why this works on every surface that matters

The binding reads the **final selection at sign time** and is therefore
independent of capture fidelity. On rich-text surfaces (e.g. a Gmail
reply) where positional/length capture degrades to `null` ("partial
capture"), the binding is unaffected — we read the selected text
directly. Commensurability also degrades gracefully there: the timing
and event count survive even when exact lengths do not, so
"~340 words" vs "18 minutes across ~1,900 edits, no large pastes" remains
a judgment a human can make.

Google Docs remains unsupported: it renders to canvas, so there is no
process to record and no DOM selection to bind. The extension should
declare itself inapplicable there rather than fake a record.

## 4. Two claims must not be collapsed

The UI must keep these visually distinct and never merge them into one
"verified" state:

- **Text identity** (binding): automated, robust to formatting, catches
  the swap.
- **Commensurability** (process vs text size): human judgment, no
  automated check.

Collapsing them into a single green checkmark would manufacture exactly
the certification-of-effort claim the product refuses to make.

## 5. Explicitly out of scope

Dropped after analysis as effort that does not pay for itself here:

- An **automated length/consistency check** at sign time — fragile on
  rich-text surfaces, confused by quoted/pre-seeded text, and a poor fit
  for a contextual question. Replaced by §2.3 human judgment.
- **Content-defined chunking / per-chunk leaf hashes** for mid-document
  diffs — aggressive canonicalization plus `exact`/`prefix` covers the
  real cases (same letters, optionally with an appended tail). Internal
  mid-document edit tolerance is not a requirement.
- **Process anchoring** (per-checkpoint buffer commitments, all-surviving
  reconstruction) — larger architectural jump with empirical unknowns;
  not needed for the binding to stand on its own.
- **Server-mediated verification** — unnecessary; verification is
  client-side and text never reaches the server.

## 6. Honest limits

- "Match" means letters, not formatting (§2.1); a genuine reword fails by
  design.
- Interleaved replies (writing between quote blocks) can't be one
  contiguous selection. v1 answer: sign the whole reply, rely on visible
  quoting plus commensurability. Multi-span selection is a future
  nicety, not now.
- Commensurability needs an engaged reader; it is a judgment aid, not a
  guarantee.
- Google Docs is unsupported.

## 7. What needs sign-off before code

1. Accept the §3.4 amendment: one salted, aggressive-canonical
   text-of-selection commitment (plus its canonical length) may enter the
   public manifest. This is a whole-selection hash, not per-chunk leaf
   hashes; confirming a guess requires already possessing the whole
   selection, so leakage is bounded to "confirm a hypothesis."
2. Approve adding `text_binding` to the manifest (chain-covered) and a
   client-side verification surface to the record app.
3. Pin the aggressive canonicalization precisely in
   `docs/spec/canonicalization.md` and add conformance vectors for it.
4. Confirm the two-claims separation (§4) as a UI invariant.

No implementation until 1–4 are settled.
