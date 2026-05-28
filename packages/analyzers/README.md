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

Analyzers are pure functions over `{ events, manifest }`. Missing required capabilities return `applicable: false`; they are not treated as suspicious.
