// Which tests read a changed non-code file. vitest --changed follows the module graph only, so a test that reads its
// input with readFileSync (docs/manual.md, fly.town.toml, collectives/workshop/collective.json) never re-runs when
// that file changes: those were 19 of 97 failed CI runs in 2026-10-25..11-04 (dc_z9oix2r66w). `npm run check --fast`
// adds the tests found here to the --changed set. A test "names" a file when its source has the file's base name as a
// whole string literal or as the end of one ("fly.town.toml", "../../../docs/manual.md"); over-matching (every test
// naming "collective.json") only runs a few more tests.
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

/** workspaces with tests, in dependency order (schema has none) */
export const TESTED = ["core", "runtime", "server", "cli", "desk", "web"];

/** Files vitest's module graph already covers: --changed finds their tests. */
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

export interface TestSource { path: string; text: string }

/** Every test file of the tested workspaces (repo-relative path and source). */
export function testSources(root: string, workspaces: string[]): TestSource[] {
  const out: TestSource[] = [];
  for (const ws of workspaces) {
    const dir = join("packages", ws, "test");
    let entries: string[];
    try { entries = readdirSync(join(root, dir), { recursive: true }) as string[]; } catch { continue; }
    for (const n of entries.sort()) {
      if (/\.test\.tsx?$/.test(n)) out.push({ path: join(dir, n), text: readFileSync(join(root, dir, n), "utf8") });
    }
  }
  return out;
}

/** Does this test source name the repo file `rel` in a string literal? */
function names(text: string, rel: string): boolean {
  const base = basename(rel).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`["'\`/]${base}["'\`]`).test(text);
}

/** The tests that read one of the changed non-code files, repo-relative, sorted. */
export function testsReading(changed: string[], tests: TestSource[]): string[] {
  const files = changed.filter((f) => !CODE.test(f) && !f.startsWith("docs/log.d/"));
  return tests.filter((t) => files.some((f) => names(t.text, f))).map((t) => t.path).sort();
}
