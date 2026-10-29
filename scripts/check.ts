// `npm run check`: the full check CI runs (docs, dead code, typecheck, tests), in order, stopping at the first failure,
// then one timing line: `check: docs 1s | deadcode 6s | typecheck 28s | tests 2m19s | total 2m54s`.
//   npm run check                 full set (what CI runs)
//   npm run check --fast          repeat run after a small change: skips knip, runs only the tests whose module graph
//                                 touches a file changed since the merge-base with origin/main (vitest --changed);
//                                 typecheck is incremental either way (tsbuildinfo in node_modules/.cache/tsc)
//   npm run check -- typecheck    only the named steps (docs, deadcode, typecheck, tests); `npm run typecheck` is this
import { spawnSync } from "node:child_process";
import { availableParallelism } from "node:os";

const STEPS = ["docs", "deadcode", "typecheck", "tests"] as const;
type Step = (typeof STEPS)[number];
// workspaces with tests, in dependency order (schema has none)
const TESTED = ["core", "runtime", "server", "cli", "desk", "web"];

const args = process.argv.slice(2);
// `npm run check --fast` (without `--`) reaches us as npm_config_fast
const fast = args.includes("--fast") || process.env.CHECK_FAST === "1" || process.env.npm_config_fast === "true";
const named = args.filter((a) => !a.startsWith("-")) as Step[];
for (const s of named) if (!STEPS.includes(s)) fail(`unknown step "${s}" (steps: ${STEPS.join(", ")})`);
const steps = STEPS.filter((s) => (named.length ? named.includes(s) : !(fast && s === "deadcode")));

// vitest defaults to cpus - 1 workers: one worker on a 2-vCPU desk, which runs the test files one after another
const workers = String(Math.max(2, availableParallelism() - 1));

function run(cmd: string, argv: string[]): boolean {
  return spawnSync(cmd, argv, { stdio: "inherit" }).status === 0;
}

function git(argv: string[]): string | null {
  const r = spawnSync("git", argv, { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

const RUN: Record<Step, () => boolean> = {
  docs: () => run("npm", ["run", "--silent", "check:docs"]),
  deadcode: () => run("npm", ["run", "--silent", "check:deadcode"]),
  typecheck: () => run("node_modules/.bin/tsc", ["-p", "."]) && run("node_modules/.bin/tsc", ["-p", "packages/web"]),
  tests: () => {
    const extra = ["--maxWorkers", workers];
    if (fast) {
      const base = git(["merge-base", "HEAD", "origin/main"]) ?? "HEAD";
      console.log(`check: --fast runs only the tests affected by changes since ${base.slice(0, 7)}`);
      extra.push("--changed", base);
    }
    return TESTED.every((ws) => run("npm", ["run", "--silent", "test", "--workspace", `packages/${ws}`, "--", ...extra]));
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
  console.log(`\ncheck: ${step}${fast ? " (fast)" : ""}`);
  const t = Date.now();
  const ok = RUN[step]();
  timings.push(`${step} ${fmt(Date.now() - t)}`);
  if (!ok) {
    failed = step;
    break;
  }
}
timings.push(`total ${fmt(Date.now() - t0)}`);
console.log(`\ncheck${fast ? " --fast" : ""}: ${timings.join(" | ")}${failed ? ` | FAILED at ${failed}` : ""}`);
process.exit(failed ? 1 : 0);
