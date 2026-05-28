# Emacs producer

Future native Emacs producer.

## Responsibility

- Emacs minor mode capture using `after-change-functions`.
- Buffer/session status, sign-buffer command, discard command, upload flow, and capture-context review/redaction.
- Emitting conformant event logs that pass `packages/conformance` vectors.

## Non-responsibility

- TypeScript runtime implementation.
- Backend storage.
- Record page presentation.
- Plaintext upload in the public deployment.
- Human/AI verdicts, scores, or badges.

M0 is scaffold only. Emacs producer implementation begins in M7.
