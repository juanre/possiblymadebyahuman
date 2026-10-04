# OATS roles

The PMBAH OATS workspace uses a private workspace host and this repository as
a public member. The membership backlink grants workspace membership; it
contains no machine paths or credentials. `docs/sot.md` remains the product
source of truth. These roles do not introduce product behavior or a release.

| Soul | Responsibility | Work view |
| --- | --- | --- |
| `pmbah-maintainer` | Direction, integration, review, authorized merges | Read-only workspace |
| `pmbah-records-expert` | Format/conformance, analyzers, API/storage, public privacy | Read-only workspace |
| `pmbah-producers-expert` | Capture/journals, extension, `/write` capture, Emacs | Read-only workspace |
| `pmbah-web-expert` | Viewer, `/write` presentation, Hugo/public docs | Read-only workspace |
| `pmbah-developer` | One expert's scoped implementation | Isolated product worktree |

An expert coordinates a concrete task, writes its specification, and delegates
to the developer. One task lead coordinates cross-domain interfaces. The
packaged `oats.engineering/code-reviewer` reviews the consolidated worktree
independently before expert acceptance and a PR. No idle fleet is needed.
The maintainer reviews direction and integration; merge and release authority
must come from the task or human. Deployment is a separate explicit task.

All roles preserve content-blind public records, explicit capture, immutable
signed records, honest continuations, and local-only private drafts. The
public record is never a verdict about humanity or origin. Do not publish
plaintext, `capture_context`, page/site details, URLs, or editor names.

Knowledge and task-provider slots start empty. Experts and maintainers keep
resume state (`STATE.md`, `log.md`, useful `notes/`) in their instance homes;
accepted product decisions go through reviewed repository documentation.
Host configuration maps the existing product clone for worktree spawns; no
source checkout move, credentials, or generated OATS state belongs here.
