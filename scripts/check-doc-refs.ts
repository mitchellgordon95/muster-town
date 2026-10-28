// Doc-drift check (CI): fails when the developer docs name a file path, npm script or verb/tool that doesn't exist.
// Mechanical references only: it never judges or rewrites prose (that is Onboarding's daily sweep; the split is in
// the town doc dc_mu57k5t71o). Run from the repo root: `npm run check:docs`.
//
// What counts as a reference:
//   paths    a word in a `code span` or a fenced block whose first segment is a top-level entry of the repo, or that ends
//            in a file extension (.md, .ts, .json, …; a bare file name only when it is the whole span, resolved at the
//            root); `<placeholder>` and `*` segments match any entry; gitignored
//            runtime paths (collectives/<id>/data/, .env) pass. Also relative markdown links `[x](path)`.
//   scripts  `npm run <name>`, `npm start`, `npm test` (root package.json, or the --workspace package named on the line)
//   verbs    `mcp__town__<verb>`, a snake_case `code span`, `muster-town <command>`, and (SKILL.md) the `verb {…}` lines
//            of a fenced block; checked against VERB_NAMES and the CLI's commands. Not in docs/manual.md, which names
//            UI buttons in human prose.
//   tests    (docs/invariants/*.md) each `- Test: `<file>` › `<it text>`` line: the file exists and contains the it text
//            verbatim, so renaming a cited test fails the check. Each invariants doc cites at least one test.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { VERB_NAMES } from "@muster-town/schema";

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const DOCS: { file: string; verbs: boolean }[] = [
  { file: "README.md", verbs: true },
  { file: "CLAUDE.md", verbs: true },
  { file: "AGENTS.md", verbs: true },
  { file: "skills/muster-town/SKILL.md", verbs: true },
  { file: "docs/manual.md", verbs: false },
  ...readdirSync(join(ROOT, "docs/invariants")).filter((f) => f.endsWith(".md")).sort().map((f) => ({ file: `docs/invariants/${f}`, verbs: true })),
];
const CITATION = /^\s*- Test: `([^`]+)` › `([^`]+)`\s*$/;
// paths the reader is told to create (README, "Start your own collective")
const EXAMPLES = [/^collectives\/garden(\/|$)/];
const EXT = /\.(md|ts|tsx|js|mjs|json|sh|toml|ya?ml|lock|html|css|sql|txt)$/;

const topLevel = new Set(readdirSync(ROOT));
const rootScripts = scriptsOf(".");
const cliCommands = new Set<string>();
for (const f of readdirSync(join(ROOT, "packages/cli/src"))) {
  for (const m of readFileSync(join(ROOT, "packages/cli/src", f), "utf8").matchAll(/\.command\("([\w-]+)"\)/g)) cliCommands.add(m[1]!);
}
const verbs = new Set<string>(VERB_NAMES);

function scriptsOf(dir: string): Set<string> {
  const pkg = join(ROOT, dir, "package.json");
  return existsSync(pkg) ? new Set(Object.keys(JSON.parse(readFileSync(pkg, "utf8")).scripts ?? {})) : new Set();
}

/** Does a repo-relative path exist, expanding `<x>` and `*` segments over the entries of their parent? */
function exists(rel: string): boolean {
  const segs = normalize(rel).split("/").filter((s) => s && s !== ".");
  const walk = (base: string, i: number): boolean => {
    if (i === segs.length) return true;
    const seg = segs[i]!;
    if (/^<[^>]*>$|^\*$/.test(seg)) {
      if (!existsSync(base) || !statSync(base).isDirectory()) return false;
      return readdirSync(base).some((e) => walk(join(base, e), i + 1));
    }
    const next = join(base, seg);
    return existsSync(next) && walk(next, i + 1);
  };
  return walk(ROOT, 0);
}

function ignored(rel: string): boolean {
  const probe = rel.replace(/<[^>]*>|\*/g, "x");
  try {
    execFileSync("git", ["check-ignore", "-q", "--no-index", probe], { cwd: ROOT });
    return true;
  } catch {
    return false;
  }
}

function pathWords(text: string): string[] {
  const alone = !/\s/.test(text.trim());
  return text
    .split(/\s+/)
    .map((w) => w.replace(/^["'(]+|["'),;:.]+$/g, ""))
    .filter((w) => {
      if (!w || /^(\/|~|\.\.|#|-|@|\$)|:\/\/|[=`{}|&]|…/.test(w)) return false;
      if (EXAMPLES.some((re) => re.test(w))) return false;
      if (!w.includes("/")) return alone && EXT.test(w) && !w.startsWith(".");
      return topLevel.has(w.split("/")[0]!) || EXT.test(w);
    });
}

interface Problem { file: string; line: number; kind: "path" | "script" | "verb" | "test"; ref: string }

function checkDoc(file: string, withVerbs: boolean): Problem[] {
  const problems: Problem[] = [];
  const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
  const invariants = file.startsWith("docs/invariants/");
  let fenced = false, citations = 0;
  lines.forEach((text, i) => {
    const line = i + 1;
    const bad = (kind: Problem["kind"], ref: string) => problems.push({ file, line, kind, ref });
    if (/^\s*```/.test(text)) { fenced = !fenced; return; }
    if (invariants && !fenced && /^\s*- Test:/.test(text)) {
      const m = CITATION.exec(text);
      citations++;
      if (!m) bad("test", `${text.trim()} (want - Test: \`<file>\` › \`<it text>\`)`);
      else if (!exists(m[1]!) || !statSync(join(ROOT, m[1]!)).isFile()) bad("test", m[1]!);
      else if (!['"', "'", "`"].some((q) => readFileSync(join(ROOT, m[1]!), "utf8").includes(`it(${q}${m[2]}${q}`))) bad("test", `${m[1]} › ${m[2]}`);
    }
    const spans = fenced ? [text.replace(/#.*$/, "")] : [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);

    for (const span of spans) {
      for (const w of pathWords(span)) if (!exists(w) && !ignored(w)) bad("path", w);
      if (withVerbs && !fenced && /^[a-z]+(_[a-z]+)+$/.test(span) && !verbs.has(span)) bad("verb", span);
    }
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1]!.split("#")[0]!;
      if (!target || /^[a-z]+:/.test(target)) continue;
      const rel = normalize(join(dirname(file), target));
      if (!exists(rel)) bad("path", target);
    }
    for (const m of text.matchAll(/\bnpm (?:run ([\w:.-]+)|(start|test)\b)/g)) {
      const name = (m[1] ?? m[2])!;
      const ws = /(?:--workspace[= ]|-w )(packages\/[\w-]+)/.exec(text)?.[1];
      if (!(ws ? scriptsOf(ws) : rootScripts).has(name)) bad("script", `npm run ${name}${ws ? ` --workspace ${ws}` : ""}`);
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
  return problems;
}

const problems = DOCS.flatMap((d) => checkDoc(d.file, d.verbs));
for (const p of problems) console.error(`${p.file}:${p.line}: ${p.kind} \`${p.ref}\` doesn't exist`);
if (problems.length) {
  console.error(`\n${problems.length} broken reference(s). Fix the doc (or the code) in this change; see scripts/check-doc-refs.ts for what counts.`);
  process.exit(1);
}
console.log(`doc references ok: ${DOCS.map((d) => d.file).join(", ")}`);
