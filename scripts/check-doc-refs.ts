// Doc-drift check (CI): fails when a developer doc names a file path, code name, npm script or verb/tool that doesn't
// exist. The rules, and which docs they read (every docs/*.md but the frozen log, plus README, CLAUDE, AGENTS and
// SKILL), are in scripts/doc-refs.ts. Run from the repo root: `npm run check:docs`.
// It also holds docs/manual.md to its word cap (MANUAL_CAP): over the cap it fails with the count, the overage and the
// largest sections, so the trim happens in the same change; under it, a warning once fewer than 50 words are left.
// And it keeps the town log conflict-free (scripts/log-rule.ts): docs/log.md is frozen, entries go in docs/log.d/.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { docRefProblems, docsIn } from "./doc-refs.ts";
import { logProblems } from "./log-rule.ts";

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const DOCS = docsIn(ROOT);
// the manual is read by people in one sitting: it stays under this many words (the web manual sheet splits it at h2)
const MANUAL = "docs/manual.md";
const MANUAL_CAP = 1900;
const HEADROOM_WARN = 50;

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** The manual's word count against MANUAL_CAP: the failure line (with the overage and the five largest h2 sections) or null. */
function checkManualCap(): string | null {
  const md = readFileSync(join(ROOT, MANUAL), "utf8");
  const count = words(md);
  if (count <= MANUAL_CAP) {
    const left = MANUAL_CAP - count;
    if (left < HEADROOM_WARN) console.error(`${MANUAL}: ${count}/${MANUAL_CAP} words, only ${left} left under the cap: trim before adding to it`);
    else console.log(`${MANUAL}: ${count}/${MANUAL_CAP} words`);
    return null;
  }
  const sections = md.split(/^## +/m).slice(1).map((p) => {
    const nl = p.indexOf("\n");
    return { title: (nl < 0 ? p : p.slice(0, nl)).trim(), words: words(nl < 0 ? "" : p.slice(nl + 1)) };
  });
  const largest = sections.sort((a, b) => b.words - a.words).slice(0, 5).map((s) => `${s.title} ${s.words}`).join(", ");
  return `${MANUAL}: ${count} words, ${count - MANUAL_CAP} over the ${MANUAL_CAP}-word cap. Largest sections: ${largest}. Trim it in this change.`;
}

const problems = docRefProblems(ROOT, DOCS);
for (const p of problems) console.error(`${p.file}:${p.line}: ${p.kind} \`${p.ref}\` doesn't exist`);
if (problems.length) console.error(`\n${problems.length} broken reference(s). Fix the doc (or the code) in this change; see scripts/doc-refs.ts for what counts.`);
const cap = checkManualCap();
if (cap) console.error(cap);
const log = logProblems(ROOT);
for (const p of log) console.error(p);
if (problems.length || cap || log.length) process.exit(1);
console.log(`doc references ok: ${DOCS.length} docs (${DOCS.map((d) => d.file).join(", ")})`);
