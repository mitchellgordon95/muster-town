// Prebuild the server for production boots (docs/postmortem-2026-10-31-cpu-throttle-503.md suggestion 6): one esbuild pass
// bundles packages/server, core, runtime and schema into packages/server/dist, so the Fly entrypoint starts plain `node` on
// JS instead of compiling the TypeScript with tsx at every start (measured on a 2-vCPU desk, CPU seconds to the first
// /api/health: tsx 2.3 s warm, 3.3 s cold cache; this bundle 1.8 s). Dev, tests and scripts/serve.sh keep running the
// sources with tsx. Third-party packages stay external (node_modules, native better-sqlite3).
//
// Entry points: main.js (the server), runtime.js (loaded by main.ts through a variable specifier, see loadRuntime),
// backup/worker.js (the backup worker_threads file), export-worker.js (the hourly export's worker, core/src/export.ts). `splitting` puts code they share (core, schema) in common chunks, so a
// module like core's World exists once, not once per entry. Every chunk sits at packages/server/dist, the same depth as a
// package's src/, so `import.meta.url`-relative paths (web/dist, skills/, the repo root) resolve as they do from the sources;
// core's migrations directory is found from either place (core/src/db.ts).
//
// dist/BUILD_HEAD, written last, holds the commit built: deploy/fly/entrypoint.sh starts the bundle only when it matches
// HEAD, so a checkout moved without a build (a failed build, a hand pull) never runs stale code: it rebuilds or uses tsx.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgs = join(here, "..");
const out = join(here, "dist");

const external = new Set();
for (const p of ["server", "core", "runtime", "schema"]) {
  const j = JSON.parse(readFileSync(join(pkgs, p, "package.json"), "utf8"));
  for (const d of Object.keys(j.dependencies ?? {})) if (!d.startsWith("@muster-town/")) external.add(d);
}

let head = "";
try { head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: here, encoding: "utf8" }).trim(); } catch { /* no git: no stamp, never used by the entrypoint */ }

// Every external must resolve from packages/server/dist, where the bundle runs: a dependency npm left nested under another
// workspace (packages/runtime/node_modules) resolves from that package's sources but not from here. On 2026-11-13 the SDK
// did, and every host session failed with "Cannot find package" until it was hoisted. Fail the build instead, so
// deploy/fly/start-server.sh falls back to tsx and the town keeps running.
const unresolved = [...external].filter((d) => {
  for (let dir = out; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "node_modules", d, "package.json"))) return false;
    if (dirname(dir) === dir) return true;
  }
});
if (unresolved.length) {
  console.error(`[build] not resolvable from packages/server/dist: ${unresolved.join(", ")}; declare them in packages/server/package.json so npm hoists them`);
  process.exit(1);
}

const started = Date.now();
// write: false: a failed build throws here and leaves the previous dist untouched
const result = await build({
  entryPoints: {
    main: join(here, "src/main.ts"),
    runtime: join(pkgs, "runtime/src/index.ts"),
    "backup/worker": join(here, "src/backup/worker.ts"),
    "export-worker": join(pkgs, "core/src/export-worker.ts"),
  },
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node22",
  external: [...external],
  outdir: out,
  write: false,
  logLevel: "warning",
});
rmSync(out, { recursive: true, force: true });
for (const f of result.outputFiles) {
  mkdirSync(dirname(f.path), { recursive: true });
  writeFileSync(f.path, f.contents);
}
if (head) writeFileSync(join(out, "BUILD_HEAD"), head + "\n");
console.log(`[build] server bundle: ${result.outputFiles.length} files in packages/server/dist (${Date.now() - started} ms)${head ? ` at ${head.slice(0, 7)}` : ""}`);
