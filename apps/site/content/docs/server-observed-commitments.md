---
title: "Server-observed commitments"
summary: "What the server-observed checkpoints on a record mean — and the limits of what they say."
---

A writing record published by `possiblymadebyahuman` can carry a list of **server-observed commitments**. Each commitment is a short, content-blind message that the producer sent to the ingest service while the writing session was still open: it names a position in the event-chain (the commitment's `event_count`) and a chain-tip (a BLAKE3 prefix hash that depends on every event up to that point). The server timestamps each commitment as it arrives and stores it alongside the finalised record.

The record page surfaces this as a one-line **Observation status** and a collapsible list of commitments inside the Verification panel. Below is what each public state name means.

## Observation status values

The public record carries one of four observation state values, in this order of decreasing server knowledge:

### Server observed checkpoints

The server received commitments to the event-chain at several points across the session, and the final signed record matches every commitment's chain-tip prefix. The commitments are records of what the server saw, not claims about who wrote the words or how much time was spent writing. A reader can recompute the final record's hash chain in their browser and check it against the displayed `Full record hash`.

### Partially observed

The server saw the start of this session but not the tail. Either connectivity was lost, the producer entered a backoff window after a transient failure, or the user signed before another commitment was due. The signed record's event log is complete and locally verifiable; the server's observation timeline stops at the last commitment.

### Not observed

No server commitment was received for this session. Either the producer was offline for the whole session, every commitment attempt failed, or the producer was configured without observation. The signed record remains valid on its own — absence of observation is itself a real signal in the record, not a defect.

### No observation requested

Some producers do not request observation — for example a producer used entirely offline or one that chooses to ship records without server timestamps. The signed record is verifiable on its own.

## Server-observed span

When a record is observed or partially observed, the page shows a **Server-observed span**: the wall-clock distance between the first and last commitments — it does not count active typing, and it includes any idle gaps between commitments.

A reader might reasonably ask: "If the server saw a chain tip at 14:02 and another at 14:34, doesn't that mean the writing took at least 32 minutes?" The precise answer is no. The server received commitments to the event-chain prefix at those times. A commitment shows that the events covered by it were already shaped before the server received the commitment, and a later check against the final record can confirm the commitment matches the corresponding prefix. The mechanism does not establish how much active writing time elapsed, and it does not rule out an attacker pre-computing events offline and submitting commitments at cadence. The product makes after-the-fact fabrication materially more work; it does not make fabrication impossible.

## What the commitments are not

- They are not a claim about authorship. The record does not name the person at the keyboard and the server cannot.
- They are not a measurement of continuous typing. The span includes any idle gaps between commitments.
- They are not a detection score, a badge, or a certificate of humanity.
- They are not a content fingerprint. Each commitment is a chain-tip over the event sequence (position, lengths, source, time deltas), never over the document text. Nothing about what was typed is sent to the server.

## What they are

- A timestamped, content-blind record of what the server received and when it received it.
- A check the ingest service can use at finalisation: if the commitments do not match the submitted record's event-chain prefix, finalisation is rejected and no public record is published.
- A bound that makes after-the-fact fabrication of a session materially more work. An attacker who wants to publish a record with a long server-observed span has to commit chain tips at real wall-clock cadence; they cannot fold a long span onto a single offline burst.

The cadence is fixed in v0: the producer commits on the first mutation, then again after fifty new events or after sixty seconds with at least one new event since the last attempt, and once more before the final upload. The producer never sends idle heartbeats. The cadence is not user-configurable in v0.
