// The repo's own check scripts (grant gr_baf19xtg7p): the frozen town log (scripts/log-rule.ts) and the tests
// `npm run check --fast` adds for a changed non-code file (scripts/fast-tests.ts). And the doc-drift rules
// (scripts/doc-refs.ts, grant gr_8k0nn380tp): every doc in docs/ cites only files and names that exist.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LOG, LOG_DIR, LOG_LINES, logProblems } from "../../../scripts/log-rule.ts";
import { TESTED, testSources, testsReading } from "../../../scripts/fast-tests.ts";
import { docRefProblems, docsIn } from "../../../scripts/doc-refs.ts";
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

/** A tiny repo (git init, nothing committed) with one package, a script and one doc in docs/ holding `doc`. */
function docRepo(doc: string): string {
  const root = mkdtempSync(join(tmpdir(), "doc-refs-"));
  const put = (rel: string, text: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
  put("package.json", JSON.stringify({ scripts: { check: "x" } }));
  put("packages/core/src/grants.ts", "export function queueStep(n: number) { return { stepCount: n }; }\n// oldHelper was here\n");
  put("packages/web/src/panels/DecisionQueue.tsx", "export const DecisionQueue = () => null;\n");
  put("packages/core/migrations/001_init.sql", "CREATE TABLE goals (id TEXT, poolId TEXT); -- legacyColumn\n");
  put("docs/log.md", "- `missing/file.ts` in the frozen log is not checked\n");
  put("docs/note.md", doc);
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}
const refs = (doc: string) => docRefProblems(docRepo(doc)).map((p) => `${p.kind} ${p.ref}`);

describe("check:docs: every doc in docs/", () => {
  it("reads every docs/*.md but the frozen log, with the verb rule only where it was", () => {
    const docs = docsIn(docRepo("# x\n"));
    expect(docs.map((d) => d.file)).toEqual(["docs/note.md"]);
    expect(docsIn(REPO_ROOT).map((d) => d.file)).toEqual(expect.arrayContaining(["docs/architecture.md", "docs/wakes.md", "docs/invariants/asks.md"]));
    expect(docsIn(REPO_ROOT).map((d) => d.file)).not.toContain("docs/log.md");
    expect(refs("Table `bank_reservations` and column `key_results`.\n")).toEqual([]);
  });

  it("fails a doc in docs/ that cites a deleted path", () => {
    expect(refs("Grants live in `packages/core/src/grants.ts`; rollups in `packages/schema/src/rollup.ts`.\n")).toEqual(["path packages/schema/src/rollup.ts"]);
  });

  it("resolves package-relative and suffix paths, placeholders and the example files", () => {
    expect(refs("`core/grants.ts`, `core/src/grants.ts`, `panels/DecisionQueue.tsx`, `grants.ts`, `packages/core/src/grants.ts:12`, `packages/<pkg>/src/grants.ts`, `town.json`, `packages/web/dist`, `buildings/<id>/README.md`, [a doc](dc_abc123).\n")).toEqual([]);
    expect(refs("`core/kpis.ts` and `kpis.ts`\n")).toEqual(["path core/kpis.ts", "path kpis.ts"]);
  });

  it("fails a doc in docs/ that cites an unknown camelCase name", () => {
    expect(refs("`queueStep` returns `stepCount`; column `poolId`; `Grants.queueStep()`.\n")).toEqual([]);
    expect(refs("The cap is `familyCap`, from `Grants.oldHelper()`; `legacyColumn` too.\n")).toEqual(["name familyCap", "name Grants.oldHelper()", "name legacyColumn"]);
    expect(refs("The cap was familyCap (removed): plain text is not a reference.\n")).toEqual([]);
  });

  it("skips a doc marked Status: history", () => {
    const old = "Gone: `packages/schema/src/rollup.ts`, `parseRollup`.\n";
    expect(refs(`# Old design\n\n${old}`)).toHaveLength(2);
    expect(refs(`# Old design\n\nStatus: history. Then: built.\n\n${old}`)).toEqual([]);
    expect(refs(`# Old design\n\nStatus: **history**\n\n${old}`)).toEqual([]);
  });

  it("the repo's own docs pass", () => expect(docRefProblems(REPO_ROOT)).toEqual([]));
});
