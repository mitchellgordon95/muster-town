// The repo's own check scripts (grant gr_baf19xtg7p): the frozen town log (scripts/log-rule.ts) and the tests
// `npm run check --fast` adds for a changed non-code file (scripts/fast-tests.ts).
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LOG, LOG_DIR, LOG_LINES, logProblems } from "../../../scripts/log-rule.ts";
import { TESTED, testSources, testsReading } from "../../../scripts/fast-tests.ts";
import { REPO_ROOT } from "./helpers.ts";

function logRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "log-rule-"));
  mkdirSync(join(root, LOG_DIR), { recursive: true });
  writeFileSync(join(root, LOG), Array.from({ length: LOG_LINES }, (_, i) => `- line ${i}`).join("\n") + "\n");
  writeFileSync(join(root, LOG_DIR, "README.md"), "# how\n");
  writeFileSync(join(root, LOG_DIR, "2026-11-10-mara-1-log-d.md"), "- 2026-11-10: the log is one file per change.\n");
  return root;
}

describe("town log", () => {
  it("check:docs refuses a new line in docs/log.md", () => {
    const root = logRepo();
    expect(logProblems(root)).toEqual([]);
    appendFileSync(join(root, LOG), "- 2026-11-11: appended the old way\n");
    expect(logProblems(root)).toEqual([expect.stringMatching(/^docs\/log\.md: 1 new line\(s\) appended\. It is frozen/)]);
  });

  it("entries under docs/log.d are dated, slugged files of bullets", () => {
    const root = logRepo();
    writeFileSync(join(root, LOG_DIR, "My Change.md"), "- x\n");
    writeFileSync(join(root, LOG_DIR, "2026-11-10-empty.md"), "\n");
    writeFileSync(join(root, LOG_DIR, "2026-11-10-prose.md"), "Did a thing.\n");
    expect(logProblems(root)).toEqual([
      "docs/log.d/2026-11-10-empty.md: empty",
      expect.stringContaining("docs/log.d/2026-11-10-prose.md: each entry is a \"- \" bullet"),
      expect.stringContaining("docs/log.d/My Change.md: name it"),
    ]);
  });

  it("the repo's own log passes", () => expect(logProblems(REPO_ROOT)).toEqual([]));
});

describe("check --fast: tests that read a changed non-code file", () => {
  const sources = testSources(REPO_ROOT, TESTED);

  it("finds the tests behind the most-failed CI runs", () => {
    expect(testsReading(["docs/manual.md"], sources)).toEqual(expect.arrayContaining(["packages/core/test/manual-seed.test.ts", "packages/web/test/manual.test.ts"]));
    expect(testsReading(["fly.town.toml"], sources)).toContain("packages/core/test/finance-fly.test.ts");
    expect(testsReading(["collectives/workshop/collective.json"], sources)).toContain("packages/core/test/fresh-seed.test.ts");
    expect(testsReading(["packages/core/src/grants.ts", "docs/log.d/2026-11-10-x.md"], sources)).toEqual([]);
  });

  it("every test reading a repo file is in the fast map", () => {
    // each string literal in a test that names an existing non-code file of the repo (from the root or relative to the
    // test) must make that test run when the file changes
    const missed: string[] = [];
    let named = 0;
    for (const t of sources) {
      for (const m of t.text.matchAll(/["'`]([\w./-]+\.(?:md|toml|json|ya?ml|txt|sh|sql|html|css))["'`]/g)) {
        const lit = m[1]!;
        const abs = lit.startsWith(".") ? resolve(REPO_ROOT, dirname(t.path), lit) : join(REPO_ROOT, lit);
        const rel = relative(REPO_ROOT, abs);
        if (rel.startsWith("..") || !existsSync(abs)) continue;
        named++;
        if (!testsReading([rel], sources).includes(t.path)) missed.push(`${t.path} → ${rel}`);
      }
    }
    expect(named).toBeGreaterThan(0);
    expect(missed).toEqual([]);
  });
});
