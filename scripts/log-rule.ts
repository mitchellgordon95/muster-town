// The town log without merge conflicts (grant gr_baf19xtg7p). docs/log.md was one file every change appended to, so any
// two open PRs conflicted on its last line: 116 hand resolutions in 10 days (dc_z9oix2r66w). It is now frozen at
// LOG_LINES lines, and each change adds its own file under docs/log.d/ named `<YYYY-MM-DD>-<branch slug>.md`, so two
// PRs never touch the same file. Read the whole log in order with `cat docs/log.md docs/log.d/*.md`.
// `npm run check:docs` (scripts/check-doc-refs.ts) runs logProblems.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const LOG = "docs/log.md";
export const LOG_DIR = "docs/log.d";
/** docs/log.md's line count when it was frozen; a PR that appends to it fails check:docs. */
export const LOG_LINES = 355;
const ENTRY_FILE = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9.-]*\.md$/;

/** What is wrong with the town log under `root`: one line per problem, empty when it is fine. */
export function logProblems(root: string): string[] {
  const problems: string[] = [];
  const lines = readFileSync(join(root, LOG), "utf8").replace(/\n$/, "").split("\n").length;
  if (lines > LOG_LINES) {
    problems.push(`${LOG}: ${lines - LOG_LINES} new line(s) appended. It is frozen: put the entry in ${LOG_DIR}/<YYYY-MM-DD>-<branch slug>.md instead (one file per change, so PRs never conflict on it).`);
  }
  if (!existsSync(join(root, LOG_DIR))) return [...problems, `${LOG_DIR}/ is missing`];
  for (const f of readdirSync(join(root, LOG_DIR)).sort()) {
    if (f === "README.md") continue;
    if (!ENTRY_FILE.test(f)) { problems.push(`${LOG_DIR}/${f}: name it <YYYY-MM-DD>-<branch slug>.md (lowercase)`); continue; }
    const body = readFileSync(join(root, LOG_DIR, f), "utf8").split("\n").filter((l) => l.trim());
    if (!body.length) problems.push(`${LOG_DIR}/${f}: empty`);
    const bad = body.find((l) => !l.startsWith("- ") && !l.startsWith("  "));
    if (bad) problems.push(`${LOG_DIR}/${f}: each entry is a "- " bullet like docs/log.md's (got "${bad.slice(0, 60)}")`);
  }
  return problems;
}
