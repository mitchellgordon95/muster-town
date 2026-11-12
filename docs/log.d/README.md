# Town log entries

One file per change, named `<YYYY-MM-DD>-<branch slug>.md` (lowercase; the date the change merges or is written, the slug from your branch name, e.g. `2026-11-10-mara-1-log-d.md`). The body is one or more `- ` bullets in `docs/log.md`'s style: `- 2026-11-10: what changed and why (PR or doc id).` Two PRs never write the same file, so the log never conflicts. `docs/log.md` is frozen; `npm run check:docs` (`scripts/log-rule.ts`) refuses a line appended to it and a misnamed file here. Read the log in order with `cat docs/log.md docs/log.d/*.md`.
