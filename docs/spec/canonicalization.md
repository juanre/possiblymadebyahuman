# Canonical JSON serialization

Status: format `0.1` normative rules.

Canonicalization is part of the event-log contract. Every conformant producer must serialize the same logical public process event to the same UTF-8 bytes before hashing.

## Scope

Canonicalization applies to public EventMutation objects used in the hash chain. The record manifest is validated separately; the event chain commits to canonical event bytes.

Format `0.1` intentionally does not define general-purpose canonicalization for arbitrary user-provided strings. Public EventMutation string values are constrained to ASCII operation/source enums. Arbitrary user strings such as capture-context labels, URLs, browser titles, and Emacs buffer names are manifest metadata, not part of the event hash-chain canonical bytes in v0.

Public events contain only the mutation shape:

```jsonc
{
  "seq": 0,
  "t": 0,
  "op": "insert",
  "pos": 0,
  "del_len": 0,
  "ins_len": 1,
  "source": "typing"
}
```

Text-bearing or text-derived fields such as `ins_text`, `ins_hash`, `final_text`, and `final_text_hash` are not valid public event/manifest fields in v0. Unknown `pos`, `del_len`, or `ins_len` measurements are represented as explicit JSON `null`, not omitted.

Session identifiers are UUIDv4 strings.

## JSON rules

- Output UTF-8 JSON bytes.
- Object keys are sorted lexicographically by Unicode codepoint.
- No insignificant whitespace is emitted.
- Integers are emitted as JSON numbers, not strings.
- Non-finite numbers and non-integer numbers are rejected for format `0.1` canonical event JSON.
- Optional fields that are absent remain absent.
- Optional fields must not be serialized as `null` unless the schema explicitly requires null.
- For public mutation events, unknown `pos`, `del_len`, and `ins_len` are schema-required explicit `null` values and participate in canonical bytes as JSON `null`.
- Event string values use JSON escaping rules and must not be normalized or otherwise rewritten during canonicalization. In format `0.1`, public event strings are constrained to ASCII enum values for cross-language safety.
- Arrays preserve their original order.
- Booleans and null, where schema-approved, use JSON literals.
- `undefined`, functions, symbols, and bigint values are not valid canonical JSON values.

## Event hash-chain use

For `format_version: "0.1"`, event chaining is defined as:

```text
chain[0] = H(utf8(format_version) || utf8(session_id) || canon(event[0]))
chain[i] = H(bytes(chain[i-1]) || canon(event[i]))
```

Where:

- `H` is BLAKE3-256.
- Displayed hashes are lowercase hex with the shared `b3:` prefix.
- `bytes(chain[i-1])` means the 32 raw digest bytes decoded from the previous `b3:` hash string, not the UTF-8 characters of that displayed string.
- `canon(event[i])` means the UTF-8 bytes of the canonical JSON event.

The final chain hash is the full `record_hash` and the basis for record addressing.

## Conformance vectors

M1 vectors live under `packages/conformance/vectors/` and cover:

- event canonicalization for content-blind mutation shapes, including explicit-null unknown measurements,
- hash-chain outputs for a sample log,
- observed process-length math using Unicode codepoint counts supplied by producers,
- a golden content-blind sample record,
- capability-accuracy checks documenting how missing source attribution is represented.
