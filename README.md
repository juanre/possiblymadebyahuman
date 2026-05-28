# possiblymadebyahuman

`possiblymadebyahuman` records the shape of a writing process and presents it as a replayable, hash-addressed writing record.

It is **not** a human/AI detector. It must not emit humanness verdicts, confidence percentages, or certification-style badges. The allowed claim is narrower and more honest: this record shows the shape of an editing process; it does not prove who originated the ideas.

The public service is content-blind by default: uploaded records store mutation structure, metadata, statistics, and analyzer facts, not plaintext writing. Plaintext belongs only in local replay flows or test fixtures.

## Current milestone

M2: ingestion API, immutable storage abstractions, Postgres schema, record stats, and short URLs. Producers, frontend UI, and analyzers are intentionally not implemented yet.

## Commands

The Makefile is the main management surface:

```bash
make help
make install
make check
make docker-build
make local-container
make local-container-test  # full local Docker+Postgres HTTP e2e journey
make local-container-down
```

Equivalent npm checks remain available:

```bash
npm install
npm run typecheck
npm test
npm run check
```
