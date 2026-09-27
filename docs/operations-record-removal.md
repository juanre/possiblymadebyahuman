# Record removal runbook

The [terms](../apps/site/content/docs/terms.md) allow the operator to remove a reported record that is clearly abusive (spam, illegal content) or an impersonation. There is no public deletion API. After removal the record's URL returns not-found, and no list of removed hashes is published.

## Before removing

1. Confirm the report in the issue tracker and record the decision there. Do not paste the full hash into a public comment if the reporter asked for discretion.
2. Identify the record by its short signature (the path of its URL) or its full `b3:` hash.
3. Use the production `DATABASE_URL` from Neon. Run from a trusted machine; the command needs no running app.

## Remove

Preview first. The preview runs the whole removal in a transaction and rolls it back:

```bash
make remove-record SIGNATURE=<short-signature-or-hash> DATABASE_URL='postgresql://...'
```

It prints the full hash and how many observed sessions, uploads, event chunks and continuations are affected. Check that the hash is the reported record, then remove it:

```bash
make remove-record SIGNATURE=<short-signature-or-hash> DATABASE_URL='postgresql://...' CONFIRM=yes
```

The same command is available in the image as `node apps/ingest-api/scripts/remove-record.mjs <id> [--confirm]`.

## What removal does

In one transaction, holding the same per-hash lock as publication:

- deletes the record row and, by cascade, its statistics and analyzer results;
- deletes the observed session it finalized, with all its checkpoints;
- deletes every upload that owns or is staging this hash, with their event chunks and delay counts;
- adds the hash to `removed_records`.

Afterwards `/<short-signature>`, `/<hash>` and every `/api/records/...` read for it return 404, the same as a record that never existed. Publishing the same hash again, directly or through a resumable upload, returns `410 record_removed`; a new continuation naming it as parent is refused as a missing parent.

## Continuations

A continuation signs its parent's hash into its own record hash, so it cannot be edited without breaking its verification. Removal therefore leaves continuations published and verifiable. Their manifest still names the parent hash. Where the viewer shows it as a "Continues from" link (inline records), the link now opens the same not-found page as any unknown address; it does not say the parent was removed. If a continuation must go too, remove it separately; each removal reports how many continuations remain.

## Undoing

Removal deletes data; it cannot be undone from the service. The author may still hold the record locally and could publish it again only after the hash is deleted from `removed_records`, which requires an explicit decision recorded in the issue tracker. Neon point-in-time restore is the only way to recover the deleted rows.
