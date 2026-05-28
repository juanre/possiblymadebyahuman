---
title: "Records and short signatures"
summary: "How a buffer mutation log becomes a hash-addressed record with a short, shareable URL."
---

## The primitive: a buffer mutation

Producers do not capture raw keystrokes. They capture *buffer mutations*: a single change to the underlying field, recorded as positions and lengths only — never as the content of the change.

```json
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

- `seq` is monotonic and gap-free, starting at 0.
- `t` is integer milliseconds since session start.
- `pos`, `del_len`, `ins_len` are Unicode codepoint offsets and lengths — never UTF-16 units or bytes. Each is a number, or an explicit `null` when the producer cannot derive a value content-opaquely (e.g. multi-node HTML paste into a rich-text editor). Producers must not guess.
- `op` is one of `insert`, `delete`, or `replace`.
- `source` is one of `typing`, `paste`, `cut`, `drop`, `ime`, `autocomplete`, `programmatic`, or `unknown`. Producers must mark uncertain attribution as `unknown` rather than overclaiming `typing`.

## The manifest

Every record carries a manifest with format version, BLAKE3 `record_hash`, session id, producer info, capture context, basic stats, and ingestion time. The manifest's `record_hash` equals the final hash of the event log's hash chain.

## Hash chain

The chain is computed deterministically over canonical JSON of each event, salted with the format version and session id at `seq=0`:

```text
chain[0] = BLAKE3(format_version || session_id || canonical(event[0]))
chain[i] = BLAKE3(chain[i-1]      || canonical(event[i]))   for i > 0
record_hash = chain[N-1]
```

Any single-byte change to the events or manifest changes the chain, and the verifier shows a mismatch.

## Short signatures

Long BLAKE3 hashes are painful to share, so the backend derives a short, URL-safe signature from the hash bytes and stores it alongside the full hash:

```text
https://possiblymadebyahuman.com/<short_signature>
```

- Short signatures use a URL-safe alphabet and start around 10–12 characters.
- The backend collision-checks against the `records` table.
- Reserved route prefixes — `api`, `docs`, `blog`, `write`, `assets`, `record-assets`, `images`, `health`, `ready`, `live`, and similar — are never emitted as short signatures. (`blog` stays reserved even after the public blog route was dropped, so the prefix stays safe to reintroduce.)
- The full `record_hash` is always shown on the record page and is what browser verification recomputes against.

## Why a short URL still verifies safely

The short signature is only a friendlier index into the records table. The verifier in the browser recomputes the full BLAKE3 chain from the stored events and compares it to the full `record_hash`. Two records cannot accidentally share the same full hash; the short signature is only an aliasing convenience.
