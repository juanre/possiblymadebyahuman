# `@possiblymadebyahuman/analyzers`

Pure analyzer plugin layer.

## Responsibility

- `Analyzer` interface, registry, and runner.
- v0 `timing-distribution` analyzer.
- v0 `edit-topology` analyzer.
- Descriptive measures and explanations only.

## Non-responsibility

- Network access, global state, per-author memory in v0, record mutation, or analyzer-to-analyzer dependency.
- Aggregate humanness scores, detector verdicts, confidence percentages, or badges.

Analyzers are pure functions over `{ events, manifest }`. The runner gives each analyzer an isolated, frozen copy of that input and catches analyzer failures. A failing analyzer becomes an `applicable: false` error signal for that analyzer only; later analyzers and stored records keep using the original record shape. Missing required capabilities return `applicable: false`; they are not treated as suspicious.

`edit-topology` reports `deletion_count` as the number of mutation events that remove codepoints, including `replace` operations. `replacement_count` separately reports events whose `op` is `replace`.
