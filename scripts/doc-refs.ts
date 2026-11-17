// The doc-drift rules behind `npm run check:docs` (scripts/check-doc-refs.ts), as a function of a repo root so the
// tests can run them on a fixture repo (packages/core/test/check-scripts.test.ts). Mechanical references only: it never
// judges or rewrites prose (that is Onboarding's daily sweep; the split is in the town doc dc_mu57k5t71o).
//
// Which docs: README.md, CLAUDE.md, AGENTS.md, skills/muster-town/SKILL.md and every docs/**/*.md except docs/log.md
// (frozen, scripts/log-rule.ts) and docs/log.d/ (dated entries). A doc whose first lines say `Status: history` (also
// `Status: **history**`) records what was decided then: its old names are correct as history, so it is skipped.
//
// What counts as a reference:
//   paths    a word in a `code span` or a fenced block whose first segment is a top-level entry of the repo, or that ends
//            in a file extension (.md, .ts, .json, …; a bare file name only when it is the whole span). It resolves
//            as written from the root, then as package-relative (`core/domain.ts` = packages/core/src/domain.ts,
//            `core/src/x.ts` = packages/core/src/x.ts), then as the suffix of any tracked file or directory
//            (`panels/DecisionQueue.tsx`, `kpis.ts`). `<placeholder>` and `*` segments match any entry; gitignored
//            runtime paths (collectives/<id>/data/, .env) and the EXAMPLES (files a reader is told to create, a
//            collective's own files, build output) pass. Also relative markdown links `[x](path)`.
//   names    (docs/) a `code span` that is one camelCase name (`familyCap`, `drawPool()`, `Budget.canStart`: each
//            camelCase part) must be declared or keyed in packages/*/src, packages/*/test or scripts/ (a function, const,
//            class, type, method, property, object key, member read or quoted string; comments don't count), or be a
//            column in packages/*/migrations. A name that is gone or not built yet is written without backticks.
//   scripts  `npm run <name>`, `npm start`, `npm test` (root package.json, or the --workspace package named on the line)
//   verbs    (the agent-facing docs: README, CLAUDE, AGENTS, SKILL, docs/invariants) `mcp__town__<verb>`, a snake_case
//            `code span`, `muster-town <command>`, and (SKILL.md) the `verb {…}` lines of a fenced block; checked against
//            VERB_NAMES and the CLI's commands. Elsewhere in docs/ a snake_case span is a table or column name.
//   tests    (docs/invariants/*.md) each `- Test: `<file>` › `<it text>`` line: the file exists and contains the it (or test) text
//            verbatim, so renaming a cited test fails the check. Each invariants doc cites at least one test.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { VERB_NAMES } from "@muster-town/schema";

export interface Problem { file: string; line: number; kind: "path" | "name" | "script" | "verb" | "test"; ref: string }
export interface Doc { file: string; verbs: boolean; names: boolean }

const CITATION = /^\s*- Test: `([^`]+)` › `([^`]+)`\s*$/;
/** Paths that are not repo files on purpose: ones the reader is told to create (README, "Start your own collective"),
 *  a collective's own files as docs/self-host.md and docs/hosted-collectives.md describe them, and build output. */
export const EXAMPLES = [
  /^collectives\/(garden|climate|acme|<[^>]*>)(\/|$)/,
  /^(mytown|my-town)(\/|$)/,
  /^(town|agents|collective|secrets)\.json$/,
  /^packages\/[\w-]+\/dist(\/|$)/,
  /(^|\/)dist\/[\w./-]*$/,
  // the export mirror and v0 building folders (docs/architecture.md "Export"): paths inside an exported town
  /^(index|building)\.json$/,
  /^(buildings|meetings|library|reports|wiki|sources)\/[\w<>.*/-]*$/,
];
/** Doc-only example paths: docs/skills.md shows a skill's own bundled files, which live in the skill, not the repo. */
const DOC_EXAMPLES: Record<string, RegExp[]> = {
  "docs/skills.md": [/^scripts\/[\w.-]+$/, /^references\/[\w./-]+$/],
  // the file the reader writes for their own Fly app
  "docs/self-host.md": [/^fly\.toml$/],
};
const EXT = /\.(md|ts|tsx|js|mjs|json|sh|toml|ya?ml|lock|html|css|sql|txt)$/;
const CAMEL = /^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$/;
const HISTORY = /^\s*(?:\*\*)?Status:?(?:\*\*)?:?\s*(?:\*\*)?history\b/i;

/** One path segment as a regex: `<x>` and `*` match any run of characters but a slash. */
function segmentRe(seg: string): RegExp {
  return new RegExp(`^${seg.split(/(<[^>]*>|\*)/).map((p, i) => (i % 2 ? "[^/]+" : p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("")}$`);
}

/** The docs check:docs reads under a root (the verbs rule only where the docs are agent-facing). */
export function docsIn(root: string): Doc[] {
  const docs: Doc[] = ["README.md", "CLAUDE.md", "AGENTS.md", "skills/muster-town/SKILL.md"]
    .filter((f) => existsSync(join(root, f)))
    .map((file) => ({ file, verbs: true, names: false }));
  const walk = (dir: string): string[] =>
    readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? (e.name === "log.d" ? [] : walk(`${dir}/${e.name}`)) : e.name.endsWith(".md") ? [`${dir}/${e.name}`] : []);
  if (existsSync(join(root, "docs"))) {
    for (const file of walk("docs").sort()) {
      if (file === "docs/log.md") continue;
      docs.push({ file, verbs: file.startsWith("docs/invariants/"), names: true });
    }
  }
  return docs;
}

/** Is this doc marked `Status: history` in its first lines? */
export function isHistory(text: string): boolean {
  return text.split("\n").slice(0, 8).some((l) => HISTORY.test(l));
}

/** Every name declared or keyed in packages/*\/src and scripts/ (the set a camelCase span in a doc must be in). */
export function codeNames(root: string, files: string[]): Set<string> {
  const names = new Set<string>();
  const add = (n: string | undefined) => { if (n) names.add(n); };
  const code = files.filter((f) => /^(packages\/[\w-]+\/(src|test)|scripts)\/.*\.(ts|tsx|mjs|js)$/.test(f));
  // a migration declares the tables' columns (`poolId` stays in the schema after the code stops reading it)
  for (const f of files.filter((f) => /^packages\/[\w-]+\/migrations\/.*\.sql$/.test(f))) {
    for (const m of readFileSync(join(root, f), "utf8").replace(/--.*$/gm, "").matchAll(/\b([A-Za-z_][\w]*)\b/g)) add(m[1]);
  }
  for (const f of code) {
    // comments don't declare anything: a name only a comment still mentions is gone
    const src = readFileSync(join(root, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\\w])\/\/.*$/gm, "$1");
    for (const m of src.matchAll(/\b(?:function\*?|const|let|var|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
    // keys and typed params (`foo:`, `foo?:`), methods and calls being defined (`foo(`), assignments (`.foo =`)
    for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\s*\??\s*[:(]/g)) add(m[1]);
    for (const m of src.matchAll(/\.([A-Za-z_$][\w$]*)\s*=[^=]/g)) add(m[1]);
    // shorthand object keys and destructured names: `{ a, b }`
    for (const m of src.matchAll(/[{,]\s*([A-Za-z_$][\w$]*)\s*(?=[,}])/g)) add(m[1]);
    // quoted strings that are one name (keys, event kinds, column names)
    for (const m of src.matchAll(/["'`]([A-Za-z_$][\w$]*)["'`]/g)) add(m[1]);
    // names the code reads (`ws.readyState`): they exist on some type, ours or a library's
    for (const m of src.matchAll(/\.([A-Za-z_$][\w$]*)/g)) add(m[1]);
    // dotted string keys (`"musterTown.goalEditor.detailWidth"`)
    for (const m of src.matchAll(/["'`]([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)["'`]/g)) add(m[1]);
    // `export { a as b }`
    for (const m of src.matchAll(/\bas\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  }
  return names;
}

function scriptsOf(root: string, dir: string): Set<string> {
  const pkg = join(root, dir, "package.json");
  return existsSync(pkg) ? new Set(Object.keys(JSON.parse(readFileSync(pkg, "utf8")).scripts ?? {})) : new Set();
}

function tracked(root: string): string[] {
  try {
    return execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** Run the doc rules over the docs under a root: the broken references, in doc order. */
export function docRefProblems(root: string, docs: Doc[] = docsIn(root)): Problem[] {
  const topLevel = new Set(readdirSync(root));
  const rootScripts = scriptsOf(root, ".");
  const cliCommands = new Set<string>();
  const cliDir = join(root, "packages/cli/src");
  if (existsSync(cliDir)) {
    for (const f of readdirSync(cliDir)) {
      if (!statSync(join(cliDir, f)).isFile()) continue;
      for (const m of readFileSync(join(cliDir, f), "utf8").matchAll(/\.command\("([\w-]+)"\)/g)) cliCommands.add(m[1]!);
    }
  }
  const verbs = new Set<string>(VERB_NAMES);
  const files = tracked(root);
  const entries = new Set(files);
  for (const f of files) for (let d = dirname(f); d !== "."; d = dirname(d)) entries.add(d);
  const packages = existsSync(join(root, "packages")) ? new Set(readdirSync(join(root, "packages"))) : new Set<string>();
  let names: Set<string> | null = null;

  /** Does a repo-relative path exist, expanding `<x>` and `*` segments over the entries of their parent? */
  const existsAt = (rel: string): boolean => {
    const segs = normalize(rel).split("/").filter((s) => s && s !== ".");
    const walk = (base: string, i: number): boolean => {
      if (i === segs.length) return true;
      const seg = segs[i]!;
      if (/<[^>]*>|\*/.test(seg)) {
        if (!existsSync(base) || !statSync(base).isDirectory()) return false;
        // the last segment is a file the reader makes there (`blog/posts/<slug>.md`)
        if (i === segs.length - 1) return true;
        const re = segmentRe(seg);
        return readdirSync(base).some((e) => re.test(e) && walk(join(base, e), i + 1));
      }
      const next = join(base, seg);
      return existsSync(next) && walk(next, i + 1);
    };
    return walk(root, 0);
  };
  const suffix = (rel: string): boolean => {
    const clean = normalize(rel).replace(/\/$/, "");
    const re = new RegExp(`(^|/)${clean.split("/").map((s) => segmentRe(s).source.slice(1, -1)).join("/")}$`);
    for (const e of entries) if (re.test(e)) return true;
    return false;
  };
  const exists = (rel: string): boolean => {
    if (existsAt(rel)) return true;
    const [first, ...rest] = rel.split("/");
    if (first && packages.has(first) && rest.length) {
      if (existsAt(`packages/${rel}`) || existsAt(`packages/${first}/src/${rest.join("/")}`)) return true;
    }
    return suffix(rel);
  };
  const ignored = (rel: string): boolean => {
    const probe = rel.replace(/<[^>]*>|\*/g, "x");
    return [probe, `${probe}/`].some((p) => {
      try {
        execFileSync("git", ["check-ignore", "-q", "--no-index", p], { cwd: root });
        return true;
      } catch {
        return false;
      }
    });
  };
  const pathWords = (text: string, file: string): string[] => {
    const alone = !/\s/.test(text.trim());
    const examples = [...EXAMPLES, ...(DOC_EXAMPLES[file] ?? [])];
    return text
      .split(/\s+/)
      .map((w) => w.replace(/^["'([]+|["'),;:.\]]+$/g, "").replace(/(\.\w+):\d+(?::\d+)?$/, "$1"))
      .filter((w) => {
        if (!w || /^(\/|~|\.\.|#|-|@|\$)|:\/\/|[=`{}|&]|…/.test(w)) return false;
        if (examples.some((re) => re.test(w))) return false;
        if (!w.includes("/")) return alone && EXT.test(w) && !w.startsWith(".");
        return topLevel.has(w.split("/")[0]!) || EXT.test(w);
      });
  };
  const known = (span: string): boolean => {
    names ??= codeNames(root, files);
    const bare = span.replace(/\(.*\)$/, "");
    if (names.has(bare)) return true;
    const parts = bare.split(".");
    return parts.every((p) => !CAMEL.test(p) || names!.has(p));
  };

  const problems: Problem[] = [];
  for (const { file, verbs: withVerbs, names: withNames } of docs) {
    const body = readFileSync(join(root, file), "utf8");
    if (isHistory(body)) continue;
    const lines = body.split("\n");
    const invariants = file.startsWith("docs/invariants/");
    let fenced = false, diagram = false, citations = 0;
    lines.forEach((text, i) => {
      const line = i + 1;
      const bad = (kind: Problem["kind"], ref: string) => problems.push({ file, line, kind, ref });
      if (/^\s*```/.test(text)) { fenced = !fenced; diagram = fenced && /```\s*mermaid/.test(text); return; }
      if (diagram) return;
      if (invariants && !fenced && /^\s*- Test:/.test(text)) {
        const m = CITATION.exec(text);
        citations++;
        if (!m) bad("test", `${text.trim()} (want - Test: \`<file>\` › \`<it text>\`)`);
        else if (!existsAt(m[1]!) || !statSync(join(root, m[1]!)).isFile()) bad("test", m[1]!);
        else if (!["it", "test"].some((fn) => ['"', "'", "`"].some((q) => readFileSync(join(root, m[1]!), "utf8").includes(`${fn}(${q}${m[2]}${q}`)))) bad("test", `${m[1]} › ${m[2]}`);
      }
      const spans = fenced ? [text.replace(/#.*$/, "")] : [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);

      for (const span of spans) {
        for (const w of pathWords(span, file)) if (!exists(w) && !ignored(w)) bad("path", w);
        if (withVerbs && !fenced && /^[a-z]+(_[a-z]+)+$/.test(span) && !verbs.has(span)) bad("verb", span);
        if (withNames && !fenced && !EXT.test(span) && /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*(\(\))?$/.test(span) && span.split(".").some((p) => CAMEL.test(p.replace(/\(\)$/, ""))) && !known(span)) bad("name", span);
      }
      for (const m of (fenced ? "" : text.replace(/`[^`]*`/g, "")).matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1]!.split("#")[0]!;
        // a URL, a site path (`/api/...`) or a town doc id (`dc_…`, `mt_…`): not a repo file
        if (!target || /^[a-z]+:|^\/|^[a-z]{2}_\w/.test(target)) continue;
        const rel = normalize(join(dirname(file), target));
        if (!existsAt(rel)) bad("path", target);
      }
      for (const m of text.matchAll(/\bnpm (?:run ([\w:.-]+)|(start|test)\b)/g)) {
        const name = (m[1] ?? m[2])!;
        const ws = /(?:--workspace[= ]|-w )(packages\/[\w-]+)/.exec(text)?.[1];
        if (!(ws ? scriptsOf(root, ws) : rootScripts).has(name)) bad("script", `npm run ${name}${ws ? ` --workspace ${ws}` : ""}`);
      }
      if (!withVerbs) return;
      for (const m of text.matchAll(/mcp__town__(\w+)/g)) if (!verbs.has(m[1]!)) bad("verb", m[0]);
      for (const m of text.matchAll(/\bmuster-town ([a-z_]+)\b/g)) {
        if (!verbs.has(m[1]!) && !cliCommands.has(m[1]!)) bad("verb", m[0]);
      }
      if (fenced && file.endsWith("SKILL.md")) {
        const m = /^([a-z_]+) \{/.exec(text);
        if (m && !verbs.has(m[1]!)) bad("verb", m[1]!);
      }
    });
    if (invariants && !citations) problems.push({ file, line: 1, kind: "test", ref: "(no `- Test:` citation)" });
  }
  return problems;
}
