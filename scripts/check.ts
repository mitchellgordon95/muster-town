// `npm run check`: the full check CI runs (docs, dead code, typecheck, tests), in order, stopping at the first failure,
// then one timing line: `check: docs 1s | deadcode 6s | typecheck 28s | tests 2m19s | total 2m54s`.
//   npm run check                 full set (what CI runs)
//   npm run check --fast          repeat run after a small change: every step, but tests are only those whose module
//                                 graph touches a file changed since the merge-base with origin/main (vitest --changed)
//                                 plus those that read a changed non-code file (scripts/fast-tests.ts: docs/manual.md,
//                                 fly.town.toml, ...); typecheck is incremental either way (tsbuildinfo in node_modules/.cache/tsc)
//   npm run check --push          what the pre-push hook (.githooks/pre-push) runs: --fast without the module-graph tests
//                                 (they can be most of the suite after a core change; CI runs them), so a push waits
//                                 seconds, not minutes, and still stops the docs, knip, typecheck and file-read failures
//   npm run check -- typecheck    only the named steps (docs, deadcode, typecheck, tests); `npm run typecheck` is this
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { TESTED, testSources, testsReading } from "./fast-tests.ts";

const STEPS = ["docs", "deadcode", "typecheck", "tests"] as const;
type Step = (typeof STEPS)[number];

const args = process.argv.slice(2);
// `npm run check --fast` (without `--`) reaches us as npm_config_fast
const push = args.includes("--push") || process.env.npm_config_push === "true";
const fast = push || args.includes("--fast") || process.env.CHECK_FAST === "1" || process.env.npm_config_fast === "true";
const mode = push ? " --push" : fast ? " --fast" : "";
const named = args.filter((a) => !a.startsWith("-")) as Step[];
for (const s of named) if (!STEPS.includes(s)) fail(`unknown step "${s}" (steps: ${STEPS.join(", ")})`);
const steps = STEPS.filter((s) => !named.length || named.includes(s));

// vitest defaults to cpus - 1 workers: one worker on a 2-vCPU desk, which runs the test files one after another
const workers = String(Math.max(2, availableParallelism() - 1));

function run(cmd: string, argv: string[]): boolean {
  return spawnSync(cmd, argv, { stdio: "inherit" }).status === 0;
}

function git(argv: string[]): string | null {
  const r = spawnSync("git", argv, { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

// the tracked pre-push hook: `npm install` sets it (root `prepare`), and so does any check, which reaches desks whose
// node_modules predate the hook (setupWorkspace runs npm install only on a fresh checkout)
if (existsSync(".githooks/pre-push") && !process.env.CI && git(["config", "core.hooksPath"]) === null) {
  if (git(["config", "core.hooksPath", ".githooks"]) !== null) console.log("check: installed the pre-push hook (git config core.hooksPath .githooks)");
}

/** Files changed since the merge-base with origin/main: committed, staged, unstaged and untracked. */
function changedFiles(base: string): string[] {
  const diff = git(["diff", "--name-only", base]) ?? "";
  const untracked = git(["ls-files", "--others", "--exclude-standard"]) ?? "";
  return [...new Set([...diff.split("\n"), ...untracked.split("\n")].filter(Boolean))];
}

function vitest(ws: string, extra: string[]): boolean {
  return run("npm", ["run", "--silent", "test", "--workspace", `packages/${ws}`, "--", "--maxWorkers", workers, ...extra]);
}

const RUN: Record<Step, () => boolean> = {
  docs: () => run("npm", ["run", "--silent", "check:docs"]),
  deadcode: () => run("npm", ["run", "--silent", "check:deadcode"]),
  typecheck: () => run("node_modules/.bin/tsc", ["-p", "."]) && run("node_modules/.bin/tsc", ["-p", "packages/web"]),
  tests: () => {
    if (!fast) return TESTED.every((ws) => vitest(ws, []));
    const base = git(["merge-base", "HEAD", "origin/main"]) ?? "HEAD";
    const reading = testsReading(changedFiles(base), testSources(".", TESTED));
    console.log(`check:${mode} runs ${push ? "" : "the tests whose module graph changed since " + base.slice(0, 7) + " and "}${reading.length} test file(s) reading a changed non-code file${reading.length ? `: ${reading.join(", ")}` : ""}`);
    return TESTED.every((ws) => {
      const own = reading.filter((t) => t.startsWith(`packages/${ws}/`)).map((t) => t.slice(`packages/${ws}/`.length));
      return (push || vitest(ws, ["--changed", base])) && (!own.length || vitest(ws, own));
    });
  },
};

function fmt(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

function fail(msg: string): never {
  console.error(`check: ${msg}`);
  process.exit(2);
}

const timings: string[] = [];
const t0 = Date.now();
let failed: Step | null = null;
for (const step of steps) {
  console.log(`\ncheck: ${step}${fast ? ` (${mode.trim().slice(2)})` : ""}`);
  const t = Date.now();
  const ok = RUN[step]();
  timings.push(`${step} ${fmt(Date.now() - t)}`);
  if (!ok) {
    failed = step;
    break;
  }
}
timings.push(`total ${fmt(Date.now() - t0)}`);
console.log(`\ncheck${mode}: ${timings.join(" | ")}${failed ? ` | FAILED at ${failed}` : ""}`);
process.exit(failed ? 1 : 0);
