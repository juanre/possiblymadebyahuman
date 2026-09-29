# Release 0.4.7 handoff

Release tag `v0.4.7` ships the application image. The Chrome extension stays
at 0.4.3 and Emacs at 0.1.5.

- **QR code for a record.** The record header has a closed disclosure,
  **QR code for this record**, with a QR code for the page's address (without
  any query or fragment the reader arrived with), the address itself, and SVG
  and PNG downloads for printing on a copy of the text. The page draws the
  code in the browser with `qrcode-generator` (error correction level M, four
  modules of quiet zone); no other service is asked to make it, so none learns
  which records are opened.

## Publication and deployment

Deploy the service's `:latest` image on Render after the tag workflow
publishes it. No migration.

## Validation

Before tagging: type checking, 570 Node tests under managed PostgreSQL (one
intentional skip), including decoding the generated code for a short-signature
and a full-hash address, and the release gate with 191 browser tests,
including decoding the code the record page shows and both downloads.
