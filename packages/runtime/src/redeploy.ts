/**
 * v1.3 redeploy (host-executed): pull main, reinstall when the lockfile changed, rebuild the web client,
 * optionally rebuild the desk image, drain (hold new work sessions and wait, up to `drainTimeoutMs`, for running ones
 * to end), recreate idle desks, then exit 75 so `scripts/serve.sh` restarts the server.
 * Every step's start/end is a `system` event (output tail in the payload). Single-flight; runs in the background.
 */
import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { World } from "@muster-town/core";
import type { RedeployResult, RedeployRun } from "@muster-town/schema";
import { DESK_IMAGE, DESK_LABEL_PREFIXES, OLD_DESK_IMAGE } from "./desk/backend.ts";

export interface CmdResult { code: number; stdout: string; stderr: string }
/** Runs one command (no shell). Injected in tests. */
export type CommandRunner = (cmd: string, args: string[], opts: { cwd: string; timeoutMs?: number }) => Promise<CmdResult>;

export const realCommandRunner: CommandRunner = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeoutMs ?? 600_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr || (err ? err.message : "")) });
    });
  });

/** Exit code that asks scripts/serve.sh to restart the server. */
export const RESTART_EXIT_CODE = 75;

export interface RedeployDeps {
  /** lock tuning (tests): wait, poll, and stale thresholds in ms */
  lockWaitMs?: number;
  lockPollMs?: number;
  lockStaleMs?: number;
  world: World;
  /** Agent Town repo root (the server's REPO_ROOT) */
  repoRoot: string;
  /** desk container label value (`muster-town.collective`), already docker-safe */
  collective: string;
  /** desk image tag to build */
  image: string;
  /** whether the agent has a live work session (its desk is left alone) */
  isWorking(agentId: string): boolean;
  /** agent ids with a live work session (drain waits for this to be empty); default: none */
  working?(): string[];
  /** agent ids with pending work that the drain's hold keeps from starting (badged in the UI); default: none */
  blocked?(): string[];
  /** hold (true) or release (false) the scheduler's new work sessions while draining */
  hold?(on: boolean): void;
  /** how long the drain waits before restarting anyway (sessions still running are orphaned; at startup they are stopped in their desks and re-queued). Default 30 min. */
  drainTimeoutMs?: number;
  /** drain poll period. Default 5000. */
  drainPollMs?: number;
  run?: CommandRunner;
  /** called with 75 after `exitDelayMs`; default process.exit (tests always inject one) */
  exit?: (code: number) => void;
  exitDelayMs?: number;
}

export interface RedeployRequest { image: boolean; requestedBy: string }

export interface Redeployer {
  redeploy(o: RedeployRequest): RedeployResult;
  running(): boolean;
  /** resolves when the in-flight redeploy (if any) has finished */
  done(): Promise<void>;
}

const TAIL = 2000;
const tail = (r: CmdResult) => (r.stdout + (r.stderr ? `\n${r.stderr}` : "")).trim().slice(-TAIL);

export function makeRedeployer(deps: RedeployDeps): Redeployer {
  const run = deps.run ?? realCommandRunner;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const cwd = deps.repoRoot;
  let flight: Promise<void> | null = null;
  let held = false;
  let run_: RedeployRun = { state: "running", requestedBy: "", commits: null, working: [], blocked: [] };

  const say = (text: string, payload: Record<string, unknown> = {}) =>
    deps.world.events.append({ type: "system", text, payload: { redeploy: true, run: { ...run_ }, ...payload } });
  const fail = () => { run_ = { ...run_, state: "failed", working: [], blocked: [] }; };

  // The restart's marker (written just before exit 75): the new server announces the redeploy finished.
  // Per collective, since several share one checkout.
  const donePath = join(cwd, `.muster-town-redeploy-done-${deps.collective}.json`);
  // the first restart after the rename was written by the old code under the old name (drop in rename P6)
  const oldDonePath = join(cwd, `.agent-town-redeploy-done-${deps.collective}.json`);
  try {
    const path = existsSync(donePath) ? donePath : oldDonePath;
    const prev = JSON.parse(readFileSync(path, "utf8")) as Partial<RedeployRun>;
    unlinkSync(path);
    run_ = { state: "done", requestedBy: String(prev.requestedBy ?? ""), commits: typeof prev.commits === "number" ? prev.commits : null, working: [], blocked: [] };
    const n = run_.commits;
    say(`Redeploy finished: the server is back up${n === null ? "" : ` with ${n} new change${n === 1 ? "" : "s"}`}`, { phase: "done" });
  } catch { /* no restart pending */ }

  /** One step: start event, run, end event. Returns the result, or null (after a failure event) on a non-zero exit. */
  async function step(label: string, cmd: string, args: string[], timeoutMs: number, okNote?: () => Promise<string>): Promise<CmdResult | null> {
    say(`Redeploy: ${label} …`, { step: label, phase: "start" });
    const r = await run(cmd, args, { cwd, timeoutMs });
    if (r.code !== 0) {
      fail();
      say(`Redeploy: ${label} … failed (exit ${r.code})`, { step: label, phase: "end", ok: false, code: r.code, output: tail(r) });
      return null;
    }
    const note = okNote ? await okNote() : "";
    say(`Redeploy: ${label} … ok${note ? ` (${note})` : ""}`, { step: label, phase: "end", ok: true, code: 0, output: tail(r) });
    return r;
  }

  async function go(o: RedeployRequest): Promise<void> {
    say(`Redeploy requested by ${o.requestedBy}${o.image ? " (with the desk image)" : ""}`, { phase: "requested", requestedBy: o.requestedBy, image: o.image });

    // (a) pull main; a dirty tree aborts
    const status = await run("git", ["status", "--porcelain"], { cwd, timeoutMs: 30_000 });
    if (status.code !== 0 || status.stdout.trim()) {
      fail();
      say(status.code !== 0 ? `Redeploy: aborted, git status failed (exit ${status.code})` : "Redeploy: aborted, the working tree is dirty",
        { step: "git status", phase: "end", ok: false, code: status.code, output: tail(status) });
      return;
    }
    const before = (await run("git", ["rev-parse", "HEAD"], { cwd, timeoutMs: 30_000 })).stdout.trim();
    let lockChanged = false;
    const pulled = await step("git pull --rebase origin main", "git", ["pull", "--rebase", "origin", "main"], 300_000, async () => {
      if (!before) return "";
      const count = Number((await run("git", ["rev-list", "--count", `${before}..HEAD`], { cwd, timeoutMs: 30_000 })).stdout.trim()) || 0;
      run_ = { ...run_, commits: count };
      lockChanged = !!(await run("git", ["diff", "--name-only", before, "HEAD", "--", "package-lock.json"], { cwd, timeoutMs: 30_000 })).stdout.trim();
      return `${count} commit${count === 1 ? "" : "s"}`;
    });
    if (!pulled) return;

    // (b) reinstall only when the lockfile changed
    if (lockChanged) {
      if (!(await step("npm install", "npm", ["install", "--no-audit", "--no-fund"], 900_000))) return;
    } else {
      say("Redeploy: npm install … skipped (package-lock.json unchanged)", { step: "npm install", phase: "end", ok: true, skipped: true });
    }

    // (c) web client
    if (!(await step("build web", "npm", ["run", "build", "--workspace", "@muster-town/web"], 600_000))) return;

    // (d) desk image
    if (o.image && !(await step("docker build desk image", "docker", ["build", ...imageTags(deps.image).flatMap((t) => ["-t", t]), "-f", "packages/desk/Dockerfile", "."], 3_600_000))) return;

    // (e) drain: no new work sessions; wait for the running ones to end (a restart would orphan them)
    deps.hold?.(true);
    held = true;
    const working = () => deps.working?.() ?? [];
    const names = (ids: string[]) => ids.map((id) => deps.world.agents.get(id)?.name ?? id).join(", ");
    const timeoutMs = deps.drainTimeoutMs ?? 30 * 60_000;
    const blocked = () => deps.blocked?.() ?? [];
    let left = working();
    if (left.length) {
      run_ = { ...run_, state: "scheduled", working: left, blocked: blocked() };
      say(`Redeploy: draining, waiting for ${left.length} session(s) to end: ${names(left)} (up to ${Math.round(timeoutMs / 60_000)} min)`, { step: "drain", phase: "start", working: left });
      const until = Date.now() + timeoutMs;
      while (left.length && Date.now() < until) {
        await new Promise<void>((r) => setTimeout(r, Math.min(deps.drainPollMs ?? 5000, Math.max(1, until - Date.now()))));
        left = working();
        // tell the UI when the set of sessions waited on, or of agents held, changes
        const now = blocked();
        if (left.length && (left.join() !== run_.working.join() || now.join() !== run_.blocked.join())) {
          run_ = { ...run_, working: left, blocked: now };
          say(`Redeploy: still waiting for ${left.length} session(s): ${names(left)}${now.length ? `; holding work for ${names(now)}` : ""}`, { step: "drain", phase: "wait" });
        }
      }
      say(left.length ? `Redeploy: drain timed out, restarting anyway; still running (stopped and re-queued at startup): ${names(left)}` : "Redeploy: drain … ok (no sessions running)",
        { step: "drain", phase: "end", ok: !left.length, working: left });
    }

    // (f) recreate idle desks (home volumes kept; a desk is recreated from the new image on next use)
    if (o.image) {
      // desks made before the rename carry agent-town.* labels, newer ones muster-town.*: list both (drop the old in P6)
      const lines: string[] = [];
      for (const args of deskListArgs(deps.collective)) lines.push(...(await run("docker", args, { cwd, timeoutMs: 60_000 })).stdout.split("\n"));
      const removed: string[] = [], kept: string[] = [], seen = new Set<string>();
      for (const line of lines.map((l) => l.trim()).filter(Boolean)) {
        const [name, agentId] = line.split("\t");
        if (!name || seen.has(name)) continue;
        seen.add(name);
        if (agentId && deps.isWorking(agentId)) { kept.push(name); continue; }
        const rm = await run("docker", ["rm", "-f", name], { cwd, timeoutMs: 60_000 });
        (rm.code === 0 ? removed : kept).push(name);
      }
      say(`Redeploy: removed ${removed.length} idle desk container(s)${kept.length ? `, kept ${kept.length}` : ""}`, { step: "recreate desks", phase: "end", ok: true, removed, kept });
    }

    // (g) restart: give the HTTP response and the events a moment to flush
    run_ = { ...run_, state: "restarting", working: [], blocked: [] };
    try { writeFileSync(donePath, JSON.stringify(run_)); } catch { /* no repo dir (tests): the UI just won't hear "done" */ }
    say("Redeploy: restarting server", { step: "restart", phase: "end", ok: true });
    await new Promise<void>((r) => setTimeout(r, deps.exitDelayMs ?? 500));
    try { unlinkSync(lockPath); } catch { /* already gone */ }
    exit(RESTART_EXIT_CODE);
  }

  /**
   * Several collectives share one checkout; two redeploys at once corrupt each other's git state
   * ("Cannot rebase onto multiple branches"). A lock file in the repo root serialises them across processes.
   */
  const lockPath = join(cwd, ".muster-town-redeploy.lock");
  /** a collective still on pre-rename code locks under the old name: wait for it too (drop in rename P6) */
  const oldLockPath = join(cwd, ".agent-town-redeploy.lock");
  async function withRepoLock<T>(fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    let locked = false;
    const isStale = (p: string) => { try { return Date.now() - statSync(p).mtimeMs > (deps.lockStaleMs ?? 20 * 60_000); } catch { return true; } };
    for (;;) {
      if (!existsSync(oldLockPath) || isStale(oldLockPath)) {
        try { closeSync(openSync(lockPath, "wx")); locked = true; break; } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === "ENOENT") break; // no such repo dir (tests with a fake root): nothing to lock
          if (code !== "EEXIST") throw e;
          if (isStale(lockPath)) { try { unlinkSync(lockPath); } catch { /* raced */ } continue; }
        }
      }
      if (Date.now() - started > (deps.lockWaitMs ?? 10 * 60_000)) throw new Error(`another redeploy holds ${lockPath}`);
      if (Date.now() - started < 1000) say("Redeploy: waiting for another collective's redeploy to finish", { step: "lock", phase: "wait" });
      await new Promise((r) => setTimeout(r, deps.lockPollMs ?? 3000));
    }
    try { return await fn(); } finally { if (locked) { try { unlinkSync(lockPath); } catch { /* already gone */ } } }
  }

  return {
    redeploy(o) {
      if (flight) return { running: true };
      run_ = { state: "running", requestedBy: o.requestedBy, commits: null, working: [], blocked: [] };
      flight = withRepoLock(() => go(o))
        .catch((e) => { fail(); say(`Redeploy: failed (${e instanceof Error ? e.message : String(e)})`, { ok: false }); })
        .finally(() => {
          flight = null;
          // only reached without a real exit (failure, or tests): let the scheduler start sessions again
          if (held) { held = false; deps.hold?.(false); }
        });
      return { started: true };
    },
    running: () => !!flight,
    done: () => flight ?? Promise.resolve(),
  };
}

/** `docker build` tags: the default desk image is also tagged with its pre-rename name, so either name in desks.image works (drop in P6). */
export function imageTags(image: string): string[] {
  return image === DESK_IMAGE || image === OLD_DESK_IMAGE ? [image, image === DESK_IMAGE ? OLD_DESK_IMAGE : DESK_IMAGE] : [image];
}

/** `docker ps` argv listing a collective's desks as `<name>\t<agentId>`, once per label prefix (docker ANDs label filters, so one query can't OR them). */
export function deskListArgs(collective: string): string[][] {
  return DESK_LABEL_PREFIXES.map((p) => ["ps", "-a", "--filter", `label=${p}.collective=${collective}`, "--filter", `label=${p}.desk=1`,
    "--format", `{{.Names}}\t{{.Label "${p}.agent"}}`]);
}
