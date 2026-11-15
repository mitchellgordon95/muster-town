/**
 * The one entry point to the human decision queue (Mitchell, 1:1 mt_t65exni4et 2026-11-15 decisions 7-8;
 * docs/invariants/asks.md 18). Every card a human sees is filed through packages/core/src/ask-verb.ts (`ask`,
 * `review` with `ask`, a need's render), so the lint runs on every card. This test is the code lint: it fails any
 * other source file that names `createAsk` or inserts a new ask row, and any test other than the seam in helpers.ts.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const VERB = "packages/core/src/ask-verb.ts";
const SEAM = "packages/core/test/helpers.ts";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) return [];
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|tsx|mts|mjs|js)$/.test(name) ? [p] : [];
  });
}

const packages = readdirSync(join(ROOT, "packages")).filter((p) => statSync(join(ROOT, "packages", p)).isDirectory() && p !== "node_modules");
const under = (sub: "src" | "test") => packages.flatMap((p) => { const d = join(ROOT, "packages", p, sub); try { return files(d); } catch { return []; } });
const rel = (p: string) => relative(ROOT, p).split("\\").join("/");

/** A new row of the asks table: `createAsk` itself, a parsed new Ask, a fresh ak_ id or a raw insert. */
const INSERTS = [/\bcreateAsk\b/, /\bAsk\.parse\(/, /newId\(\s*["']ak["']\s*\)/, /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+asks\b/i];

describe("the ask verb is the one entry point to the decision queue (asks.md 18)", () => {
  it("no source file but ask-verb.ts names createAsk or inserts a new ask row", () => {
    const offenders = under("src").filter((f) => rel(f) !== VERB).flatMap((f) => {
      const text = readFileSync(f, "utf8");
      return INSERTS.filter((re) => re.test(text)).map((re) => `${rel(f)}: ${re.source}`);
    });
    expect(offenders, "File a card through ask-verb.ts (askHumans, passUpWithAsk, renderNeed, askOnOwnNeed): write a need and render it").toEqual([]);
  });

  it("ask-verb.ts holds the insert, and only the seedAsk helper seeds asks in tests", () => {
    expect(readFileSync(join(ROOT, VERB), "utf8")).toMatch(/function createAsk\(/);
    const offenders = under("test").filter((f) => rel(f) !== SEAM && !f.endsWith("ask-entry-point.test.ts")).filter((f) => /\bcreateAsk\b/.test(readFileSync(f, "utf8"))).map(rel);
    expect(offenders, "Seed a test's ask with helpers.ts seedAsk").toEqual([]);
  });
});
