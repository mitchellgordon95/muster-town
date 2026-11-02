/**
 * Aggregates in SQL, by rule (post-mortem 2026-10-31 "CPU throttle → 503", suggestion 3). `Bank.debited` loaded every
 * matching debit through `Table.where` (SELECT * + a zod parse per row) and summed in JS, in nested loops on the 5 s
 * tick; its garbage was 15 % GC and most of the "slow before". When the answer is a number or a boolean, ask SQL:
 * `Table.count`, `Table.sum`, `Table.exists`.
 *
 * This test fails on a row load whose result is only reduced to a number or a boolean: `.where(…)`, `.query(…)` or
 * `.all(…)` followed by `.length`, `.reduce(`, `.some(`, `.every(` or `.filter(…).length`, across packages/core,
 * server and runtime (tests excluded). It reads one expression, not a variable that holds rows (`const rows = …where(…);
 * rows.length` passes): keep the load and the aggregate in one chain, or think twice.
 *
 * A row load is right when the per-row value needs JS (a computed spend, a permission check): add the call to ALLOWED
 * with its reason. An entry is the file and the load call's first 60 characters (up to its closing paren), so moving the line keeps it allowed.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { World } from "../src/index.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const SCANNED = ["packages/core/src", "packages/server/src", "packages/runtime/src"];

/** file → call prefixes (first 60 chars, whitespace collapsed) allowed to load rows, with why. */
const ALLOWED: Record<string, Record<string, string>> = {
  "packages/core/src/grants.ts": {
    [`.where("fundedWith = ? AND status IN ('funded', 'checkpoint') AND id`]: "each grant's unspent rest needs grantDesk.spent (its sessions); an input funds a handful of grants",
  },
  "packages/core/src/lanes.ts": {
    [`.where("buildingId = ? AND status IN ('funded', 'checkpoint')", [buil`]: "each grant's unspent rest needs grantDesk.spent; a building has a handful of live grants",
  },
  "packages/core/src/retainers.ts": {
    [`.where("assignmentId IN (SELECT id FROM assignments WHERE lane = 'retainer' AND sourceId = ?)", [scheduleId])`]: "adjusted tokens are priced per session's bank model in JS (sessionTokens); a schedule has a run's few sessions per fire",
    [`.where("assignmentId = ?", [assignmentId])`]: "adjusted tokens are priced per model in JS (sessionTokens); a run has a few sessions",
  },
  "packages/core/src/explore.ts": {
    [`.where("assignmentId = ?", [assignmentId])`]: "adjusted tokens are priced per model in JS (sessionView); an assignment has a few sessions",
  },
  "packages/core/src/verbs/docs.ts": {
    [`.all()`]: "a permission check per building, not a column; a town has a few buildings",
  },
};

const AGG = /^\s*\.(length\b|reduce\(|some\(|every\()/;
const FILTER_LENGTH = /^\s*\.filter\(/;

interface Hit { line: number; call: string; tail: string }

/** Index just past the `)` that closes the `(` at `open - 1`, or -1. Skips strings, template literals and comments well enough for this repo. */
function closeParen(s: string, open: number): number {
  let depth = 1;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < s.length && s[i] !== c; i++) if (s[i] === "\\") i++;
      continue;
    }
    if (c === "/" && s[i + 1] === "/") { while (i < s.length && s[i] !== "\n") i++; continue; }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i + 1;
  }
  return -1;
}

/** Row loads in `src` reduced straight to a number or a boolean. */
function rowAggregates(src: string): Hit[] {
  const hits: Hit[] = [];
  for (const m of src.matchAll(/\.(where|query|all)\(/g)) {
    const end = closeParen(src, m.index + m[0].length);
    if (end < 0) continue;
    let rest = src.slice(end);
    let tail = AGG.exec(rest)?.[1];
    if (!tail && FILTER_LENGTH.test(rest)) {
      const f = rest.indexOf("(");
      const fEnd = closeParen(rest, f + 1);
      if (fEnd > 0 && /^\s*\.length\b/.test(rest.slice(fEnd))) tail = "filter(…).length";
    }
    if (!tail) continue;
    rest = src.slice(m.index, end).replace(/\s+/g, " ");
    hits.push({ line: src.slice(0, m.index).split("\n").length, call: rest.slice(0, 60), tail: tail.replace(/\($/, "") });
  }
  return hits;
}

function* sources(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* sources(p);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !e.name.endsWith(".d.ts")) yield p;
  }
}

describe("aggregates in SQL (post-mortem 2026-10-31 suggestion 3)", () => {
  it("catches the pre-01220ca Bank.debited and the other shapes", () => {
    const debited = `return this.repos.bankDebits.where(where, params).reduce((s, d) => s + d.tokens, 0);`;
    expect(rowAggregates(debited).map((h) => h.tail)).toEqual(["reduce"]);
    expect(rowAggregates(`const n = world.agents.where("kind = ?", ["resident"]).length;`).map((h) => h.tail)).toEqual(["length"]);
    expect(rowAggregates(`x.goals.where("status = 'active'")\n  .some((g) => g.ownerId === id)`).map((h) => h.tail)).toEqual(["some"]);
    expect(rowAggregates(`t.where("a = ?", [a]).filter((k) => k.id !== b).length`).map((h) => h.tail)).toEqual(["filter(…).length"]);
    expect(rowAggregates(`t.query("SELECT * FROM t WHERE (a = ')')", []).every((r) => r.ok)`).map((h) => h.tail)).toEqual(["every"]);
    // a row load that keeps its rows is fine
    expect(rowAggregates(`t.where("a = ?", [a]).map((r) => r.id)`)).toEqual([]);
    expect(rowAggregates(`t.where("a = ?", [a]).filter((r) => r.ok).map((r) => r.id)`)).toEqual([]);
    expect(rowAggregates(`t.count("a = ?", [a]) > 0`)).toEqual([]);
  });

  it("core, server and runtime reduce no row load to a number or a boolean outside the allowlist", () => {
    const bad: string[] = [];
    const used = new Set<string>();
    for (const dir of SCANNED) {
      for (const file of sources(join(ROOT, dir))) {
        const rel = relative(ROOT, file);
        for (const h of rowAggregates(readFileSync(file, "utf8"))) {
          const allowed = Object.keys(ALLOWED[rel] ?? {}).find((k) => h.call.startsWith(k.slice(0, 60)));
          if (allowed !== undefined) { used.add(`${rel} ${allowed}`); continue; }
          bad.push(`${rel}:${h.line} ${h.call}… .${h.tail}: use Table.count / sum / exists (or allowlist it with a reason)`);
        }
      }
    }
    expect(bad).toEqual([]);
    // an allowlist entry nothing matches any more is stale: drop it
    const stale = Object.entries(ALLOWED).flatMap(([f, calls]) => Object.keys(calls).map((c) => `${f} ${c}`)).filter((k) => !used.has(k));
    expect(stale).toEqual([]);
  });

  it("Table.exists, count and sum answer in SQL", () => {
    const world = World.open(":memory:");
    world.seedDefaults({ adminName: "T", importDir: new URL("../../../buildings/carbon-cycle", import.meta.url).pathname });
    expect(world.agents.exists("kind = 'resident'")).toBe(true);
    expect(world.agents.exists("kind = ?", ["nobody"])).toBe(false);
    expect(world.agents.count("kind = 'resident'")).toBe(world.agents.where("kind = 'resident'").length);
    expect(world.sessions.sum("costUsd", "agentId = ?", ["ag_none"])).toBe(0);
    world.close();
  });
});
