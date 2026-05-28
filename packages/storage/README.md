# `@possiblymadebyahuman/storage`

Backend storage abstraction package.

## Responsibility

- Future immutable record-store interface.
- Future lookup by full `record_hash` and `short_signature`.
- Future stats and analysis-result persistence interfaces.
- Postgres implementation later in M2.

Uploaded records are permanent by default in v0. Owner-delete is a future option and is not implemented in M0.

## Non-responsibility

- HTTP routing.
- Analyzer execution policy.
- Frontend presentation.
- Plaintext storage for public records.
- User management or public deletion API in v0.

M0 contains only scaffold placeholders. Storage implementation begins in M2.
