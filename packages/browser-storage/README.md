# Browser session journal

Both the extension worker and `/write` use `IndexedDbSessionStorage`. The pure producer kernel knows only its journal adapter interface. IndexedDB holds `sessions` metadata keyed by session UUID, immutable `events` rows keyed by `[session_id, seq]`, and a migration marker in `control`. No document text is stored. Metadata and new events commit in one strict-durability transaction. Cached session state is independent of event history size, and event reads are capped at 4,096 rows.

The extension uses `pmbah.extension.journal.v1`; `/write` uses `pmbah.write.journal.v1` and retains its exclusive cross-tab Web Lock. Ownership is checked before reads and writes. Storage errors surface to the caller; there is no snapshot fallback.

Legacy `chrome.storage.local`/`localStorage` snapshots import once. Import validates each event and its saved chain, writes bounded pages, then rereads pages to verify the imported tip. The original snapshot is removed only after all session metadata and the completion marker commit. Interrupted migration can restart from the original snapshot. Invalid input or quota failure preserves it. Old JSON storage inherently requires a one-time full snapshot read; current sessions never use that path again.

`uploadJournal` begins a resumable upload with the persisted private `upload_id`, manifest and observation envelope. It reads only the server-advertised batch size (hard cap 4,096), sends ordered chunks, and finalizes the upload. Every retry begins again to obtain the server's durable event cursor. A response lost after an accepted chunk therefore does not resend the accepted prefix. Each HTTP request, including reading the response, has a 30-second deadline. Acknowledgements validate capability, cursor and final record hash before the frozen state can be retired.

The server independently validates all persisted events and the final seal. Local signing uses the existing validated chain tip; it does not load the event journal into memory. Upload capabilities and observation bearer tokens remain private local metadata.
