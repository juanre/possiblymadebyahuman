# Web app

Vite/React public record viewer and first-party `/write` producer.

## Responsibility

- Public `/<short_signature>` and full-hash record pages with capture context,
  measured statistics, timelines, descriptive analyzer facts and local integrity
  verification through `packages/format`. Large records load a bounded summary;
  explicit full verification runs in a worker over 4096-event pages, with a fixed
  128-bin activity overview. A partial download never enables a document check.
- Local document checking against an optional sealed text binding. Integrity
  failure disables this check; pasted candidate text stays in the browser.
- `/write` captures numeric applied-input measurements through producer-core's
  shared browser rules. Canvas text is not persisted or uploaded.
- Format 0.3 finish, durable frozen retries, recovered saved links and linked
  continuation segments. Failed local saving stops editable capture and offers
  a save retry; accepted upload links stay visible even when local saving fails.
- IndexedDB stores append-only event rows separately from small session metadata.
  Legacy localStorage drafts migrate once and are removed only after the new
  journal verifies. Publication resumes bounded chunks from the server cursor.
- Exclusive Web Lock ownership for `/write` local storage so two tabs cannot
  overwrite one session. Reload can recover the event log or frozen upload,
  never the canvas text. Browser storage availability remains a prerequisite.

## Boundaries

Hugo owns marketing and documentation; the ingest API owns public persistence.
The viewer renders content-blind public records, not stored document text. No
human/AI verdict, confidence score or humanity certification is produced.

Run `npm run build:web` from the repository root. The browser suite exercises
record checks, capture, persistence failure, retry and multi-tab ownership with
local fixtures; it does not establish production deployment or manual IME and
assistive-technology acceptance.
