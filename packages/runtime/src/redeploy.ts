/**
 * v1.3 redeploy (host-executed): pull main, reinstall when the lockfile changed, rebuild the web client,
 * optionally rebuild the desk image, drain (hold new work sessions and wait, up to `drainTimeoutMs`, for running ones
 * to end), recreate idle desks, then exit 75 so `scripts/serve.sh` restarts the server.
 * Every step's start/end is a `system` event (output tail in the payload). Single-flight; runs in the background.
 */
import { execFile } from "node:child_process";
import { closeSync, openSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { World } from "@agent-town/core";
import type { RedeployResult } from "@agent-town/schema";

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
  /** desk container label value (`agent-town.collective`), already docker-safe */
  collective: string;
  /** desk image tag to build */
  image: string;
  /** whether the agent has a live work session (its desk is left alone) */
  isWorking(agentId: string): boolean;
  /** agent ids with a live work session (drain waits for this to be empty); default: none */
  working?(): string[];
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

  const say = (text: string, payload: Record<string, unknown> = {}) =>
    deps.world.events.append({ type: "system", text, payload: { redeploy: true, ...payload } });

  /** One step: start event, run, end event. Returns the result, or null (after a failure event) on a non-zero exit. */
  async function step(label: string, cmd: string, args: string[], timeoutMs: number, okNote?: () => Promise<string>): Promise<CmdResult | null> {
    say(`Redeploy: ${label} …`, { step: label, phase: "start" });
    const r = await run(cmd, args, { cwd, timeoutMs });
    if (r.code !== 0) {
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
      say(status.code !== 0 ? `Redeploy: aborted, git status failed (exit ${status.code})` : "Redeploy: aborted, the working tree is dirty",
        { step: "git status", phase: "end", ok: false, code: status.code, output: tail(status) });
      return;
    }
    const before = (await run("git", ["rev-parse", "HEAD"], { cwd, timeoutMs: 30_000 })).stdout.trim();
    let lockChanged = false;
    const pulled = await step("git pull --rebase origin main", "git", ["pull", "--rebase", "origin", "main"], 300_000, async () => {
      if (!before) return "";
      const count = Number((await run("git", ["rev-list", "--count", `${before}..HEAD`], { cwd, timeoutMs: 30_000 })).stdout.trim()) || 0;
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
    if (!(await step("build web", "npm", ["run", "build", "--workspace", "@agent-town/web"], 600_000))) return;

    // (d) desk image
    if (o.image && !(await step("docker build desk image", "docker", ["build", "-t", deps.image, "-f", "packages/desk/Dockerfile", "."], 3_600_000))) return;

    // (e) drain: no new work sessions; wait for the running ones to end (a restart would orphan them)
    deps.hold?.(true);
    held = true;
    const working = () => deps.working?.() ?? [];
    const names = (ids: string[]) => ids.map((id) => deps.world.agents.get(id)?.name ?? id).join(", ");
    const timeoutMs = deps.drainTimeoutMs ?? 30 * 60_000;
    let left = working();
    if (left.length) {
      say(`Redeploy: draining, waiting for ${left.length} session(s) to end: ${names(left)} (up to ${Math.round(timeoutMs / 60_000)} min)`, { step: "drain", phase: "start", working: left });
      const until = Date.now() + timeoutMs;
      while (left.length && Date.now() < until) {
        await new Promise<void>((r) => setTimeout(r, Math.min(deps.drainPollMs ?? 5000, Math.max(1, until - Date.now()))));
        left = working();
      }
      say(left.length ? `Redeploy: drain timed out, restarting anyway; still running (stopped and re-queued at startup): ${names(left)}` : "Redeploy: drain … ok (no sessions running)",
        { step: "drain", phase: "end", ok: !left.length, working: left });
    }

    // (f) recreate idle desks (home volumes kept; a desk is recreated from the new image on next use)
    if (o.image) {
      const ps = await run("docker", ["ps", "-a", "--filter", `label=agent-town.collective=${deps.collective}`, "--filter", "label=agent-town.desk=1",
        "--format", '{{.Names}}\t{{.Label "agent-town.agent"}}'], { cwd, timeoutMs: 60_000 });
      const removed: string[] = [], kept: string[] = [];
      for (const line of ps.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
        const [name, agentId] = line.split("\t");
        if (!name) continue;
        if (agentId && deps.isWorking(agentId)) { kept.push(name); continue; }
        const rm = await run("docker", ["rm", "-f", name], { cwd, timeoutMs: 60_000 });
        (rm.code === 0 ? removed : kept).push(name);
      }
      say(`Redeploy: removed ${removed.length} idle desk container(s)${kept.length ? `, kept ${kept.length}` : ""}`, { step: "recreate desks", phase: "end", ok: true, removed, kept });
    }

    // (g) restart: give the HTTP response and the events a moment to flush
    say("Redeploy: restarting server", { step: "restart", phase: "end", ok: true });
    await new Promise<void>((r) => setTimeout(r, deps.exitDelayMs ?? 500));
    try { unlinkSync(lockPath); } catch { /* already gone */ }
    exit(RESTART_EXIT_CODE);
  }

  /**
   * Several collectives share one checkout; two redeploys at once corrupt each other's git state
   * ("Cannot rebase onto multiple branches"). A lock file in the repo root serialises them across processes.
   */
  const lockPath = join(cwd, ".agent-town-redeploy.lock");
  async function withRepoLock<T>(fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    let locked = false;
    for (;;) {
      try { closeSync(openSync(lockPath, "wx")); locked = true; break; } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ENOENT") break; // no such repo dir (tests with a fake root): nothing to lock
        if (code !== "EEXIST") throw e;
        let stale = false;
        try { stale = Date.now() - statSync(lockPath).mtimeMs > (deps.lockStaleMs ?? 20 * 60_000); } catch { stale = true; }
        if (stale) { try { unlinkSync(lockPath); } catch { /* raced */ } continue; }
        if (Date.now() - started > (deps.lockWaitMs ?? 10 * 60_000)) throw new Error(`another redeploy holds ${lockPath}`);
        if (Date.now() - started < 1000) say("Redeploy: waiting for another collective's redeploy to finish", { step: "lock", phase: "wait" });
        await new Promise((r) => setTimeout(r, deps.lockPollMs ?? 3000));
      }
    }
    try { return await fn(); } finally { if (locked) { try { unlinkSync(lockPath); } catch { /* already gone */ } } }
  }

  return {
    redeploy(o) {
      if (flight) return { running: true };
      flight = withRepoLock(() => go(o))
        .catch((e) => { say(`Redeploy: failed (${e instanceof Error ? e.message : String(e)})`, { ok: false }); })
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
