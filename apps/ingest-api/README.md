# ingest API

Layer 2 ingestion service package.

## Responsibility

- `POST /api/records`, `GET /api/records/:short_signature_or_hash`, and `GET /api/health` endpoint handlers.
- Schema validation through `packages/format`.
- Public content-blind enforcement: plaintext/content-bearing fields are rejected.
- Hash-chain verification, content addressing, `ingested_server_t` stamping, short-signature generation, immutable storage, and record stats computation.
- Returning the content-blind `{ manifest, events, stats, signals }` record shape for the web app.

## Non-responsibility

- Producer capture logic.
- Frontend presentation.
- Plaintext storage in public mode.
- Human/AI verdicts, scores, or badges.
- User management, auth, public DELETE endpoint, or owner-delete flow in v0.
- Analyzer implementation; M2 only stores/returns the analysis-results shape.

The implementation exposes a Fetch `Request` handler plus direct functions for tests and future server wiring.
