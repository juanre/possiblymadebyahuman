---
title: "Records and short signatures"
summary: "How a buffer mutation log becomes a hash-addressed record with a short, shareable URL."
group: "Read and verify a record"
weight: 1
---

## The primitive: a buffer mutation

Producers do not capture raw keystrokes. They capture *buffer mutations*: a single change to the underlying field, recorded as positions and lengths only, never as the content of the change.

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
- `pos`, `del_len`, `ins_len` are Unicode codepoint offsets and lengths, never UTF-16 units or bytes. Each is a number, or an explicit `null` when the producer cannot derive a value content-blindly (e.g. multi-node HTML paste into a rich-text editor). Producers must not guess.
- `op` is one of `insert`, `delete`, or `replace`.
- `source` is one of `typing`, `paste`, `cut`, `drop`, `ime`, `autocomplete`, `programmatic`, or `unknown`. Producers must mark uncertain attribution as `unknown` rather than overclaiming `typing`.

## The manifest

Every record carries a manifest with format version, BLAKE3 `record_hash`, session id, producer information, event count and duration. It says nothing about the page, site or file where the text was written. The API adds ingestion metadata. A record may carry an optional `text_binding`, a locally computed commitment that lets readers check a copy of the text without uploading it. See [Bind and check a document](/docs/checking-a-document/).

Format **0.3** additionally seals elapsed finish time and an optional `parent_record` link into the record hash. Its duration includes time from the session's start to the confirmed finish action, even if no edits occurred during the final pause. That signed duration is a client claim. It is separate from the span between checkpoints received by the server. Active and idle statistics measure only intervals between captured edits.

All producers create new records in this format. Records created in earlier formats keep their original format and hash, and still verify; an older draft whose upload failed retries exactly the record it froze.

## Hash chain and final seal

Events are hashed deterministically as canonical JSON. Formats 0.1 and 0.2 use their own version as the chain's starting domain. Format 0.3 deliberately uses the **0.2 event-chain domain**, so a draft can finish as 0.3 without invalidating checkpoints already received for its events.

```text
event_domain = "0.2" for format 0.3; otherwise format_version
chain[0] = BLAKE3(utf8(event_domain) || utf8(session_id) || canonical(event[0]))
chain[i] = BLAKE3(bytes(chain[i-1]) || canonical(event[i]))
event_tip = chain[N-1]
```

The final record hash depends on the format:

- **0.1:** the event tip is the record hash; text bindings are not supported.
- **0.2:** without a binding, the event tip is the record hash. With a binding, the hash is `BLAKE3(bytes(event_tip) || canonical(text_binding))`.
- **0.3:** every record has a final seal, with or without a text check:

```text
finalization = {
  format_version: "0.3",
  duration_ms: elapsed time at confirmed finish,
  parent_record: earlier record hash or null,
  text_binding: binding object or null
}
record_hash = BLAKE3(bytes(event_tip) || canonical(finalization))
```

Here `bytes` means the raw 32-byte digest and `canonical` means UTF-8 JSON with sorted keys and no extra whitespace. Changing an event or any sealed field changes the hash. Other manifest metadata, including capture context and calendar timestamps, is not newly sealed by format 0.3.

## Continuing after publication

A published record is immutable. Continuing it (**Continue in chosen field** in the Chrome extension, **Keep writing** on `/write`, or further edits in Emacs) creates a new session and a new record linked through `parent_record`. It records new mutations only. Its elapsed clock begins at the previous segment's signed finish, so time away appears before the next captured edit. Older saved records without a signed finish use the retained local upload time as an approximate boundary.

A continuation's first edit tells readers how it starts:

- **A gap at the first edit.** The producer cannot vouch that the text was unchanged since the previous record, for example because the field was reopened later. The continuation's document length is unknown, and the viewer shows edit activity instead of a length curve.
- **A known position at the first edit.** The producer claims it picks up exactly where the previous record ended, because capture never stopped in between. Emacs does this when it continues straight after publishing, and for a copy made with `M-x pmbah-copy-file`. The service then starts the continuation's length from the previous record's final length, and the viewer draws the length curve from there.

Either way the relationship does not establish that nothing happened between the two records beyond what the producer claims, and a record page says when it continues an earlier one, with a link. The previous public link stays available, and it does not link forward to later records.

## Short signatures

Long BLAKE3 hashes are painful to share, so the backend derives a short, URL-safe signature from the hash bytes and stores it alongside the full hash:

```text
https://possiblymadebyahuman.com/<short_signature>
```

- Short signatures use a URL-safe alphabet and start around 10–12 characters.
- The backend collision-checks against the `records` table.
- Reserved route prefixes (`api`, `docs`, `blog`, `write`, `assets`, `record-assets`, `images`, `health`, `ready`, `live`, and similar) are never emitted as short signatures.
- The full `record_hash` is always shown on the record page and is what browser verification recomputes against.

Every record page also offers a QR code for its address, under **QR code for this record**, to download as SVG or PNG and print on a copy of the text. The page draws it in your browser; no other service is asked to make it.

## Why a short URL still verifies safely

The short signature is only a friendlier index into the records table. The verifier in the browser recomputes the full BLAKE3 record hash using the stored events and the format’s final-seal rules and compares it to the full `record_hash`. The short signature is an alias; verification uses the full hash, whose collision resistance comes from BLAKE3.
