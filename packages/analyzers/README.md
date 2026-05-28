# `@possiblymadebyahuman/analyzers`

Pure analyzer plugin layer.

## Responsibility

- Future `Analyzer` interface, `Signal` type, registry, and runner.
- Homes for v0 `timing-distribution` and `edit-topology` analyzers.
- Descriptive measures and explanations.

## Non-responsibility

- Network access, global state, per-author memory in v0, record mutation, or analyzer-to-analyzer dependency.
- Aggregate humanness scores, detector verdicts, confidence percentages, or badges.

M0 contains only scaffold placeholders. Analyzer implementation begins in M3.
