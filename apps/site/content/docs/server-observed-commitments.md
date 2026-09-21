---
title: "Server-observed commitments"
summary: "What the server-observed checkpoints on a record mean, and the limits of what they say."
group: "Read and verify a record"
weight: 3
---

A writing record published by `possiblymadebyahuman` can carry a list of **server-observed commitments**. Each commitment is a short, content-blind message that the producer sent to the ingest service while the writing session was still open: it names a position in the event-chain (the commitment's `event_count`) and a chain-tip (a BLAKE3 prefix hash that depends on every event up to that point). The server timestamps each commitment as it arrives and stores it alongside the finalised record.

The record page surfaces this as a one-line **Observation status** and a collapsible list of commitments inside the **Signature & details** section. Below is what each public state name means.

## Observation status values

The public record carries one of four observation state values, in this order of decreasing server knowledge:

### Server observed checkpoints

The server received commitments to the event-chain at one or more points, with the last covering every submitted event, and the final signed record matches every commitment's chain-tip prefix. The commitments are records of what the server saw, not claims about who wrote the words or how much time was spent writing. A reader can recompute the final record's hash chain in their browser and check it against the displayed `Full record hash`.

### Partially observed

The last bound checkpoint covers only a prefix of the submitted events. The attempt to cover the tail before signing may have failed or timed out. The signed record's event log is complete and locally verifiable; the server's observation timeline stops at the last commitment.

### Not observed

No server commitment is bound to this record. Observation was requested, but no checkpoint succeeded, the observation became unavailable, or the producer left out commitments that diverged from the final record. The signed record remains valid on its own; absence of observation supplies no server timing evidence.

### No observation requested

Some producers do not request observation, for example a producer used entirely offline or one that chooses to ship records without server timestamps. The signed record is verifiable on its own.

## Server-observed span

When a record is observed or partially observed, the page shows a **Server-observed span**: the wall-clock distance between the first and last commitments; it does not count active typing, and it includes any idle gaps between commitments.

A reader might reasonably ask: "If the server saw a chain tip at 14:02 and another at 14:34, doesn't that mean the writing took at least 32 minutes?" The precise answer is no. The server received commitments to the event-chain prefix at those times. A commitment shows that the events covered by it were already shaped before the server received the commitment, and a later check against the final record can confirm the commitment matches the corresponding prefix. The mechanism does not establish how much active writing time elapsed, and it does not rule out an attacker pre-computing events offline and submitting commitments at cadence. The product makes after-the-fact fabrication materially more work; it does not make fabrication impossible.

## What the commitments are not

- They are not a claim about authorship. The record does not name the person at the keyboard and the server cannot.
- They are not a measurement of continuous typing. The span includes any idle gaps between commitments.
- They are not a detection score, a badge, or a certificate of humanity.
- They are not a content fingerprint. Each commitment is a chain-tip over the event sequence (position, lengths, source, time deltas), never over the document text. Nothing about what was typed is sent to the server.

## What they are

- A timestamped, content-blind record of what the server received and when it received it.
- A check the ingest service can use at finalisation: if bound commitments do not match the submitted record's event-chain prefix, that upload is rejected. A producer can explicitly upload the process record as unobserved without binding those commitments.
- A bound that makes after-the-fact fabrication of a session materially more work. An attacker who wants to publish a record with a long server-observed span has to commit chain tips at real wall-clock cadence; they cannot fold a long span onto a single offline burst.

First-party producers attempt a checkpoint on the first mutation, then after fifty new events or sixty seconds with new events since the last attempt. Before signing, a producer with successful observation attempts to commit any remaining tail, within a bounded wait. A never-committed session is left unobserved; a diverged session is uploaded without its commitments. There are no idle heartbeats.

Reproducing a server-observed span takes that much elapsed time between submissions: a twenty-minute span takes twenty minutes, a week-long span takes a week. This does not establish writing effort. A script can precompute the events and wait, and an unobserved record can claim any duration without waiting.
