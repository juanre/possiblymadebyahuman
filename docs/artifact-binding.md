# Artifact binding and process anchoring

Status: **proposal, not approved.** Needs coordinator and reviewer
sign-off before any implementation. This note amends, if accepted,
spec `§2.1` (anti-forgery scope), `§3.4` (content opacity boundary),
and `§4.3` (server-observed commitments). It does not change the
product promise: this remains a content-blind writing-record service,
not a detector, and adds **no** humanness verdict, score, or badge.

---

## 1. The gap

Today a record commits to the *shape* of an editing process — per-event
`pos`/`del_len`/`ins_len`/`source`/`t`, hash-chained to a `record_hash`
(spec §3.2, §3.5). It commits to nothing about the text. Two consequences:

1. **The record is unbound from any artifact.** It proves "a writing
   process of this shape happened," but any text can be pointed at any
   record. Someone can write and sign one document and then publish a
   different one under the same link; nothing detects the swap, because
   the record never committed to the document in the first place. This
   is not a missing verification endpoint — it is a missing commitment.

2. **The forgery floor is low.** Because the log binds only shape, a
   forger holding a finished document can attach a synthetic
   shape-log of plausible length and timing and sign it. Nothing forces
   the recorded process to correspond to the actual text.

This note proposes two layers that close (1) and raise the cost in (2),
while keeping storage content-blind and verification client-side. Both
are honest, descriptive bindings — provenance, not authorship.

## 2. Mission fit and non-goals

Binding an artifact to a process record is **provenance**, not a
humanness claim. The strongest statement either layer can make is:

> The text you are holding is the document that came out of this
> recorded process (exactly, or with these specific differences), and
> the process traced this text's actual content over real elapsed time.

It still says nothing about who originated the ideas, and it cannot
detect a human retyping an AI draft. Anti-forgery here **raises cost**;
it never claims tamper-proofness. We keep the descriptive, no-score
framing throughout — verification output is *facts about
correspondence*, never a verdict.

Non-goals: asymmetric signatures / per-author identity (no key-management
model in v0; the `record_hash` chain plus server-stamped checkpoints
already give tamper-evidence and a trusted time anchor), continuous
server monitoring, and storing any plaintext.

## 3. Terminology

- **CDC** — content-defined chunking. Chunk boundaries are chosen by a
  rolling hash over a local byte window hitting a target pattern, not by
  fixed offsets. A localized edit disturbs only the chunk(s) it lands
  in; downstream boundaries and hashes are unchanged. This is the rsync
  insight and the reason the binding survives small edits.
- **Canonical text** — the text after a fixed, specified normalization
  (line-ending normalization, trailing-whitespace collapse, Unicode
  NFC) applied before chunking. Absorbs cosmetic reflow (e.g. a mail
  client rewrapping lines) that would otherwise read as a large false
  difference. The exact normalization must be pinned in
  `docs/spec/canonicalization.md` and covered by conformance vectors.
- **Leaf hash** — salted BLAKE3 of a canonical chunk:
  `b3(record_hash ‖ chunk_index ‖ chunk_bytes)`. Salting with
  `record_hash` kills cross-record correlation and precomputed
  dictionaries.
- **Chunk-Merkle root** — BLAKE3 Merkle root over the ordered leaf
  hashes of a text.

## 4. Layer 1 — artifact binding (final text ↔ record)

### 4.1 Commit (producer, at sign time)

The producer has the final text. It computes, over the canonical final
text, a CDC chunking, the ordered salted **leaf hashes**, and the
**chunk-Merkle root**, and embeds them in the manifest so the existing
`record_hash` chain covers them. The text itself is never uploaded or
stored.

Proposed manifest addition (covered by the chain):

```jsonc
"final_commitment": {
  "scheme": "cdc-merkle/0.1",
  "chunk_count": 9,
  "root": "b3:...",
  "leaves": ["b3:...", "b3:...", ...]   // ordered, salted; see §6 for the leakage decision
}
```

### 4.2 Verify (anyone, client-side)

The record page offers a "check a document against this record" box. The
browser canonicalizes the pasted text, recomputes CDC chunks and leaf
hashes with the public salt, and **aligns** the candidate leaf sequence
against the recorded leaf sequence (a sequence alignment over
chunk-hash arrays — insert/delete/substitute chunks, not a positional
compare). The text never leaves the page.

Output is descriptive, e.g.:

> All 9 recorded segments are present, in order, plus 1 trailing segment
> not in the record.

### 4.3 Why CDC and not a whole-document hash

A whole-document hash is avalanche: append one signature line and it
mismatches entirely. The motivating case — *write and sign a mail, then
append `possiblymadebyahuman.com/<sig>` to the mail* — is the easy case
for CDC:

```
signed:     [c1][c2][c3][c4]                          root R
published:  [c1][c2][c3][c4][ — recorded at .../<sig> ]
                              ^ append → one new trailing chunk
verify:     c1..c4 present, in order; 1 trailing segment not in record  ✓
```

Mid-document edits localize to the chunk(s) touched. Pervasive edits
(rewrite throughout) produce a large diff — which is honest: the record
*should not* claim a match if the document was substantially rewritten.

Fuzzy/similarity hashing (ssdeep, TLSH, simhash) is rejected: it is not
cryptographically binding (forgeable), and a "% similar" score is
exactly the verdict framing the product forbids.

## 5. Layer 2 — process anchoring (process ↔ actual text)

Layer 1 binds the *final* artifact. Layer 2 raises the cost of faking
the *process*, by binding intermediate process states to the actual text.

### 5.1 The reconstruction insight

The shape log already stores every insert's `(pos, len)` and every
delete's `(pos, len)`. Replay it forward as an anonymous piece table:
each insert creates `len` unlabeled slots; each delete removes slots. At
the end, surviving slots line up 1:1, in order, with the characters of
the final text T. Therefore a verifier holding T can:

- label every final character with the `seq` that inserted it, and
- identify the slots that were typed and later deleted ("ephemeral" —
  content unknown).

So for any checkpoint k, the buffer is fully determined **except** for
ephemeral slots that are live at k.

### 5.2 The verifiable-checkpoint rule

> A checkpoint is **verifiable** iff no ephemeral slot is live at that
> moment — i.e. every character currently in the buffer survives to T.
> When that holds, the verifier reconstructs the *exact* buffer text (a
> known subsequence of T, in order) and checks its committed root.

```
final T:        The quick brown fox.
checkpoint @k:  The quick brown        all chars survive to T   → VERIFIABLE
checkpoint @j:  The quikc brown        "kc" deleted later (live) → SKIP
```

Honest forward writing hits all-surviving states constantly (you pause
after a clean sentence). Heavy cut-and-rewrite sessions expose fewer
verifiable points — but still some, and that is honest: we assert only
what we can prove.

### 5.3 Commit (producer, per checkpoint)

At each server-observed checkpoint (spec §4.3) the producer additionally
commits to the **chunk-Merkle root of the current canonical buffer** —
**root only**, no leaf hashes. Intermediate verification is exact-match
against the reconstructed substring, so leaves are unnecessary, and a
bare root leaks essentially nothing beyond buffer length (already
public). This piggybacks on the existing checkpoint channel; the
checkpoint body still carries no text and no leaf hashes.

### 5.4 Verify

For each recorded checkpoint, the verifier determines whether it is
verifiable (§5.2); if so, it reconstructs the exact buffer substring
from T and confirms the recorded root matches. Output stays descriptive:

> All-surviving checkpoints at seq 40, 120, 310 reproduce the final
> text in order over a server-observed span of 2 h 14 m.

### 5.5 What this forces on a forger

To pass, a fabricated process must produce all-surviving buffer states
that hash to **actual ordered substrings of T**, at the recorded times.
A generic same-length log fails: its reconstructed buffers will not hash
to T's content. The forger is forced to *write T out in order* — they
must possess the real text and reproduce it, not attach "any reasonable
process."

## 6. The content-blindness decision (reviewer + human call)

Layer 1 changes spec §3.4, which today forbids `final_text_hash`,
`ins_hash`, and any text-derived hash in public records. The substantive
choice is what Layer 1 publishes:

- **(a) root only** — zero text leakage, but verification is
  all-or-nothing exact match (brittle; fails the mail-append case).
- **(b) root + ordered salted leaf hashes** — enables the robust
  localized diff, but allows a *confirmation* attack: someone who
  already guesses a chunk's text can confirm it. With paragraph-coarse
  chunks, confirming a guess means you essentially already have that
  paragraph; the leak is "confirm a hypothesis," not "recover content."

Recommendation: **(b) with coarse, `record_hash`-salted chunks** for the
final commitment, since (a) cannot deliver the stated robustness
requirement. Layer 2's per-checkpoint commitments stay **root only**
regardless, so the intermediate layer adds near-zero leakage.

## 7. Threat model and honest limits

- **Unattended paced bot.** Because checkpoints are server-time-stamped,
  a forger's script must feed T through a producer over *real elapsed
  wall-clock*, paced like a human, hitting all-surviving states in T's
  order. That makes forging a 3-hour session take ~3 hours of unattended
  runtime and a piece-table-aware paced injector — real elapsed time
  comparable to writing, and annoying to build — **but it is unattended
  elapsed time, not human effort.** A patient automated forger with T
  still wins. No content-blind scheme can stop that; we must not claim
  otherwise.
- **The "30 s / 1000 words" case is already mostly caught** by the
  server-observed span (spec §4.3) plus the timing-distribution
  analyzer — independent of these commitments. Surfacing
  `server_observed_span_ms` prominently is the cheapest, highest-leverage
  defense for that case. Layer 2 is hardening on top, not the primary
  guard.
- **Revision coverage.** Only all-surviving checkpoints are verifiable.
  Sessions dominated by cut-and-rewrite expose fewer verifiable points.
- **Normalization is load-bearing.** If the canonical normalization is
  too weak, cosmetic reflow reads as a false diff; too aggressive, and a
  real change hides. It must be pinned and conformance-tested.
- **Layer 2 still does not prove authorship.** It binds the process to
  T's content over time; it says nothing about who originated the ideas.

## 8. Tuning left open (not architecture)

- Checkpoint cadence: denser cadence yields more verifiable points but
  stores more commitments.
- Whether a checkpoint must be *offered* at every all-surviving moment
  or only opportunistically.
- CDC target chunk size for the final commitment (drives both diff
  granularity and the §6 leakage profile).

## 9. What needs sign-off before code

1. Accept the §3.4 amendment (text-derived commitments enter public
   records) and the §2.1 amendment (revive a bounded anti-forgery layer).
2. Choose §6 (a) vs (b) for the final commitment.
3. Approve adding `final_commitment` to the manifest (chain-covered) and
   a per-checkpoint root to the server-observed checkpoint commitments.
4. Commit to pinning the canonical normalization and adding conformance
   vectors for CDC, leaf-salting, and the verifiable-checkpoint rule.

No implementation until 1–4 are settled.
