---
title: "Terms / Service Notes"
summary: "What you can expect from this service, and what the service expects from you. v0, candid."
---

This is a lightweight v0 statement of what `possiblymadebyahuman` is and isn't as a hosted service. It is intentionally short. The code that runs the service is [open source, MIT licensed](https://github.com/juanre/possiblymadebyahuman/blob/main/LICENSE), but the MIT licence covers the code; it does not by itself describe how the hosted service behaves. This page does.

If you need formal terms — for an employer, an institution, or a use case where written assurance matters — this page is not those, and you should reach out via the [project issue tracker](https://github.com/juanre/possiblymadebyahuman/issues) to discuss before relying on the service.

## What the service is

- A content-blind writing-record producer plus an ingest endpoint that stores those records and serves them at hash-addressed URLs.
- The producer never reads the text of what you write; the public record contains only the shape of the editing (positions, lengths, timing, source attribution), a BLAKE3 hash chain over those events, and a small `capture_context` block you reviewed before signing. See the [privacy page](/docs/privacy/) for the full data inventory.
- The service makes no claim about whether a human wrote anything. It is **not a detector** and not a verdict, score, badge, or certificate. The [claims page](/docs/claims/) lists exactly what is and is not asserted.

## Service is provided as-is

- v0 is provided as a best-effort service with no guarantee of availability, no guarantee of indefinite record persistence, no warranty (express or implied), no service-level agreement, no support agreement, and no commitment to backward-compatible URLs beyond what the existing record format already guarantees.
- The service may go down, be rebuilt, change ingest endpoints, or be shut down. Records are produced on your machine and you keep the local event log until you choose to sign and upload; if the service is unavailable when you sign, the upload fails and you keep the local session for retry.
- Code changes ship under the same MIT licence; service-side behaviour changes are documented in the [release docs](/docs/) and at the project's [GitHub releases](https://github.com/juanre/possiblymadebyahuman/releases).

## What we expect of you

- **Don't try to break the service.** No automated abuse, mass-scraping, or attempts to overload the ingest endpoint. No attempts to inject content into other people's records. No exploitation of platform features in ways that materially degrade the service for others.
- **Don't impersonate.** When you choose what `capture_context` to include with a record, the page URL, page title, buffer name, or major mode you upload is information *you* asserted about a session *you* signed; it is not validated by the service. Don't upload context that implies another person, organisation, or platform authored the writing.
- **Don't upload unlawful material.** Records that contain instructions, links, or other content that is illegal in the operator's jurisdiction may be removed when reported. See the moderation section below.
- **Respect the no-deletion model when you sign.** Once a record is uploaded, the v0 service has no public deletion API. Before you click sign, the producer shows you the capture context and lets you redact or omit it. Use that review step.

## What you keep

- All rights to your writing. The producer doesn't see it, the service doesn't store it, and nothing about ownership of the text changes by signing a record. You keep the words; we keep a numeric description of how the editing happened.
- All rights to records you sign. The record format is open, locally verifiable in a browser, and tied to a BLAKE3 hash chain. You can keep your own copy; you can verify any copy against the public record; you can pin records elsewhere.
- Producer code is yours to fork. The MIT licence on the repository lets you run your own producer, your own ingest service, or both. The conformance vectors in `packages/conformance` define what a conformant producer has to do.

## Identity and authorship assertions

- The service does not validate identity. When you sign a record you are asserting, in your own name and on your own authority, that you produced the writing. The service stores your assertion alongside the record and gives the assertion a permanent, hash-addressed URL; it does not certify the assertion.
- The product was built to make spoofing the writing process materially more work — committing chain tips at real wall-clock cadence makes after-the-fact fabrication take roughly as long as the original writing would have. That is a useful property; it is not a proof of authorship.

## Moderation and removal

- The service does not pre-screen records before upload. Because the records are content-blind, the service operator has no view of the text the record describes.
- A record may be removed on a case-by-case basis if it is reported and the operator concludes it contains material that is clearly abusive (spam, illegal content) or that the upload was made by someone the operator believes to be impersonating another party. Removals are recorded so a separate listing of removed record hashes can be checked later. Reports go through the [project issue tracker](https://github.com/juanre/possiblymadebyahuman/issues).
- The service may rate-limit, block, or refuse uploads from sources that violate the "don't try to break the service" section above.

## Liability

- To the extent permitted by law, the service is provided without warranty and without liability for indirect, incidental, or consequential damages arising from use or unavailability of the service. v0 is a hobbyist research surface; deploy your own instance if you need guarantees.

## Changes to this page

- Material changes to this page will be noted in the project's commit history. The current version is always the one served at `/docs/terms/`. A renamed or restructured version will redirect from this path; if it doesn't, the page was changed by someone who shouldn't have, and you should consult the [GitHub history](https://github.com/juanre/possiblymadebyahuman/commits/main/apps/site/content/docs/terms.md) before relying on the new version.

## Contact

The canonical channel for v0 is the [project issue tracker](https://github.com/juanre/possiblymadebyahuman/issues). There is no separate support email. The service operator is the maintainer named in the repository.

## Open question

Whether this lightweight v0 page is sufficient depends on the operator's jurisdiction, the audience the service ends up serving, and whether the human/operator decides a formal terms-of-service document is warranted before broader release. The maintainer's working assumption is that v0 ships under these notes and that a more formal document is a deliberate decision attached to a later release milestone, not a default. If you have a use case that requires more, open an issue.
