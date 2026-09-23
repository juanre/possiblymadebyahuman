# 0.3.0 candidate handoff

This candidate implements viewer issue #17, the panel work in #13, and the signed-finish/continuation contract in #14. It is separate from the deployed 0.2.1 release. Authenticated Gmail acceptance remains outstanding.

## Changes and evidence

- Document length stays flat between edits and changes only at captured mutations. Rhythm overflow is explicit; durations are readable. Signed duration, editing span, and waits without captured edits are separate.
- The panel follows exact editor identity in its own window and active tab. Other fields stay inactive. Private names remain distinct from public context. Saved history is last, collapsed, paginated, searchable and exportable without automatic eviction.
- Finish review pins its draft and shows Selected text or Whole field. A changed selection requires confirmation again before capture stops. Success reports the actual text-check result even when a history filter excludes the new record.
- Format 0.3 seals finish duration, parent link and optional text binding, preserving historical 0.1/0.2 hashes. It reuses the 0.2 event-chain domain so old draft checkpoints survive upgrade. Frozen finish state is durable before checkpoint or upload network waits.
- Explicit Continue creates a new segment linked to the previous immutable record. Its clock begins at the previous signed finish (legacy anchors use local upload time). The previous link remains. A second continuation cannot silently join an existing unfinished child.
- Storage failures are reported before acknowledging captured events or explicit deletion. Failed private renames cannot overwrite a concurrent successful rename.

Independent reviewers covered format/lifecycle/compatibility, extension authorization and routing, finish/privacy flows, panel UX/copy, public documentation and prerelease image tags. Review findings were fixed and regression-tested. Root independently reviewed viewer changes and narrow-panel screenshots.

The pgdbm-backed Node suite and the production-container gate passed locally; the latter ran 101 browser tests, including installed-extension tests against the packaged API. The tests use the supplied pgdbm fixtures, including real PostgreSQL roundtrips and upgrade coverage. No custom database lifecycle was introduced. Site and extension packages build. GitHub CI provides the final commit-specific results.

## Deployment order

Deploy the compatible candidate API/viewer before installing extension 0.3.0. This candidate adds no SQL migration; it relies on migration 003 already deployed with 0.2.1. Old 0.1/0.2 clients and records remain supported by the new server. An old API/viewer cannot verify the new 0.3 records, so do not revert to it after accepting new-format records.

The release candidate tag is v0.3.0-rc.1. Its container version and commit tags are separate from stable latest/minor tags. The extension package reports 0.3.0 (Chrome's numeric version requirement), while the GitHub release is explicitly a prerelease. Creating the image does not deploy it. The owner deploys through their existing Render workflow.

## Authenticated Gmail acceptance

After deployment is validated, replace the files in the existing unpacked extension directory, reload that extension, and reload Gmail. Keep one PMBAH installation enabled to preserve the existing local history.

1. Open two compose windows and explicitly start only each message body. Switching between bodies should highlight the corresponding card. Focusing recipients or subject should show no active record for that field.
2. Give the two drafts private names. Confirm the public label remains independent in finish review.
3. Select text, open finish review, and confirm Selected text. Change the selection before confirming: the panel must ask for confirmation again and publish nothing yet.
4. Publish, open the record and copy its visible URL. Dismiss the success result; the link should remain in collapsed Saved records. Search for it and export the list.
5. Stop another draft, reload Gmail, then explicitly resume it in its field. Finish without another edit to check the signed wait; a text check is unavailable until a real new edit has been captured.
6. Continue a saved record in its chosen field, add an edit and publish. The new record should link to the previous one, and both saved links must remain available.

The long-delay, failed-storage, restart, multi-frame and 200-record cases are automated. The authenticated-site check is still needed for Gmail's actual editor behavior. /write and Emacs retain their existing finalization contract; they have not opted into format 0.3.
