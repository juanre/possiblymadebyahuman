# ingest API

Future Layer 2 ingestion service.

## Responsibility

- Future `POST /api/records`, `GET /api/records/:short_signature_or_hash`, and `GET /api/health`.
- Schema validation, hash-chain verification, content addressing, `ingested_server_t` stamping, short-signature generation, immutable storage, stats computation, and v0 analyzer execution when approved.

## Non-responsibility

- Producer capture logic.
- Frontend presentation.
- Plaintext storage in public mode.
- Human/AI verdicts, scores, or badges.
- User management or public deletion API in v0.

M0 is scaffold only. API implementation begins in M2.
