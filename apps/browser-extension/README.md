# browser extension

Future capture-all browser producer.

## Responsibility

- Passive local capture for text fields and contenteditable surfaces.
- Per-field session identity, field badge, popup, sign modal, local unsigned capture TTL, sign/freeze/upload/copy-link flow, local clear after upload, and capture-context review/redaction.
- Honest degraded-capture states when source attribution is uncertain.

## Non-responsibility

- Backend storage.
- Record page presentation.
- Plaintext upload in the public deployment.
- Claiming typing when source attribution is unknown.
- Human/AI verdicts, scores, or badges.

M0 is scaffold only. Browser producer implementation begins in M6.
