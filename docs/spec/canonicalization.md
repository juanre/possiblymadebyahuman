# Canonical JSON serialization

Status: M0 specification home. The implementation and conformance vectors land in M1.

Canonicalization is part of the event-log contract. Every conformant producer must serialize the same logical event to the same bytes before hashing.

## Scope

Canonicalization applies to event objects used in the hash chain. The record manifest is validated separately; the event chain commits to canonical event bytes.

## Rules

- Output UTF-8 JSON bytes.
- Object keys are sorted lexicographically by Unicode codepoint.
- No insignificant whitespace is emitted.
- Integers are emitted as JSON numbers, not strings.
- Optional fields that are absent remain absent.
- Optional fields must not be serialized as `null` unless the schema explicitly requires null; `ins_hash` is omitted when not present.
- Strings use JSON escaping rules and must not be normalized or otherwise rewritten during canonicalization.
- Arrays preserve their original order.
- Booleans and null, where schema-approved, use JSON literals.

## Event hash-chain use

For `format_version: "0.1"`, event chaining is defined as:

```text
chain[0] = H(format_version || session_id || canon(event[0]))
chain[i] = H(chain[i-1] || canon(event[i]))
```

`H` is BLAKE3 with the system hash prefix convention `b3:`. The final chain hash is the full `record_hash` and the basis for record addressing.

## M1 conformance expectations

M1 must add vectors covering:

- simple event canonicalization with sorted keys,
- omitted optional `ins_hash`,
- inserted `ins_hash` when present,
- Unicode string escaping behavior,
- chain hash outputs for a sample log.
