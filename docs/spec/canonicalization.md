# Canonicalization

Status: normative for PMBAH format `0.1` event JSON and format `0.2` text bindings.

Canonicalization is part of the record contract. Conformant implementations must produce the same UTF-8 bytes for the same public process event and the same text-binding input.

## Canonical JSON

Canonical JSON is used for public mutation events and for the `text_binding` object that is sealed into a format `0.2` `record_hash`.

Rules:

- Output UTF-8 JSON bytes.
- Object keys are sorted lexicographically by Unicode codepoint.
- No insignificant whitespace is emitted.
- Integers are emitted as JSON numbers, not strings.
- Non-finite numbers and non-integer numbers are rejected.
- Optional fields that are absent remain absent.
- Optional fields must not be serialized as `null` unless the schema explicitly permits `null`.
- Arrays preserve their original order.
- Booleans and null, where schema-approved, use JSON literals.
- `undefined`, functions, symbols, and bigint values are not valid canonical JSON values.
- String values use JSON escaping rules and are not normalized by canonical JSON itself.

Public content-blind mutation shapes contain only process shape:

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

Unknown `pos`, `del_len`, or `ins_len` measurements are represented as explicit JSON `null`, not omitted.

For public mutation events, canonical JSON is the bytes hashed by the event chain.

## Event hash-chain use

For `format_version: "0.1"` and `format_version: "0.2"`, event chaining is:

```text
chain[0] = H(utf8(format_version) || utf8(session_id) || canon(event[0]))
chain[i] = H(bytes(chain[i-1]) || canon(event[i]))
```

Where:

- `H` is BLAKE3-256.
- Displayed hashes are lowercase hex with the shared `b3:` prefix.
- `bytes(chain[i-1])` means the 32 raw digest bytes decoded from the previous `b3:` hash string, not the UTF-8 characters of that displayed string.
- `canon(event[i])` means the UTF-8 bytes of the canonical JSON event.

For format `0.1`, the final event-chain hash is the `record_hash`.

For format `0.2`, the final event-chain hash is the event tip. If no `text_binding` is present, `record_hash` is the event tip. If `text_binding` is present:

```text
record_hash = H(bytes(event_tip) || utf8(canon(text_binding)))
```

`canon(text_binding)` is canonical JSON of exactly:

```jsonc
{
  "scheme": "canon-letters/0.1",
  "policy": "exact",              // or "prefix"
  "canonical_length": 123,
  "commitment": "b3:..."
}
```

A `text_binding` is invalid on a format `0.1` manifest.

## Text binding canonicalization: `canon-letters/0.1`

`canon-letters/0.1` is the only text-binding scheme in format `0.2`. It is intentionally lossy and content-blind: producers compute the canonical form locally, hash it, discard the text, and upload only `{scheme, policy, canonical_length, commitment}`.

Unicode baseline: implementations must follow Unicode 17.0 data for this scheme. The reference implementation pins Unicode 17.0.0 `CaseFolding.txt` (`CaseFolding-17.0.0.txt`, 2025-07-30) and uses ECMAScript Unicode property escapes and Unicode normalization data from Node 24 / ICU 78.3 (`process.versions.unicode == "17.0"`).

Given input text, produce the canonical form in this exact order:

1. Interpret the input as a Unicode codepoint sequence.
2. Apply Unicode Normalization Form KC (`NFKC`) to the whole string.
3. Apply Unicode full case folding from Unicode 17.0.0 `CaseFolding.txt`, using status `C` (common) and `F` (full) mappings and excluding status `T` (Turkic-only) mappings. This is not locale-sensitive lowercase. Full mappings may expand one codepoint to multiple codepoints, e.g. `ß → ss`, `ΐ → ΐ`, `ΰ → ΰ`, and `ᾷ → ᾶι`; final sigma `ς` folds to `σ`.
4. Iterate by Unicode codepoint and keep only codepoints whose Unicode general category has property `Letter`, `Number`, or `Mark` (`\p{Letter}`, `\p{Number}`, `\p{Mark}`).
5. Drop every other codepoint: punctuation, whitespace, symbols, emoji, controls, and separators.
6. Concatenate the kept codepoints in order.

All lengths for this scheme are Unicode codepoint counts of the canonical form, never UTF-16 code units and never bytes.

A zero-length canonical form is unbindable. Producers must refuse to create a binding for text whose canonical form is empty, and verifiers/backends must reject `text_binding.canonical_length == 0`.

## Text binding commitment

For a non-empty canonical form:

```text
commitment = H(utf8(session_id) || utf8(canonical_form))
```

The salt is `session_id`, not `record_hash`, because format `0.2` `record_hash` may itself depend on the binding.

The public binding stores:

- `scheme`: exactly `canon-letters/0.1`.
- `policy`: `exact` or `prefix`.
- `canonical_length`: codepoint length of the committed canonical form; must be greater than zero.
- `commitment`: the `b3:` BLAKE3 commitment above.

## Text binding candidate verification

Given public `session_id`, public `text_binding`, and local candidate text `C`:

1. Compute `canon(C)` with `canon-letters/0.1`.
2. For `policy: "exact"`: pass iff `len(canon(C)) == canonical_length` and `H(utf8(session_id) || utf8(canon(C))) == commitment`.
3. For `policy: "prefix"`: pass iff `len(canon(C)) >= canonical_length` and `H(utf8(session_id) || utf8(canon(C)[0:canonical_length])) == commitment`.

The prefix slice is by Unicode codepoint count in the canonical form, not by UTF-16 code unit and not by byte. Any canonical material after `canonical_length` is appended material and is not part of the commitment check.

Candidate text verification is client-side. Candidate text must not be uploaded.

## Conformance vectors

Vectors live under `packages/conformance/vectors/` and cover:

- canonical JSON for content-blind mutation events, including explicit-null unknown measurements;
- hash-chain outputs for format `0.1` and format `0.2`;
- sealed format `0.2` `record_hash` with `text_binding`;
- `canon-letters/0.1` cases for CJK/Han, combining marks, mixed scripts, punctuation/whitespace stripping, NFKC compatibility forms, non-Latin full case folding including Greek/polytonic expansions, surrogate-pair codepoints, and zero-length canonical form;
- exact and prefix text-binding candidate checks;
- observed process-length math using Unicode codepoint counts supplied by producers;
- golden content-blind records;
- capability-accuracy checks documenting how missing source attribution is represented.
