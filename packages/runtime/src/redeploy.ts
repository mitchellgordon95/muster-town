/**
 * v1.3 redeploy (host-executed): pull main, reinstall when the lockfile changed, rebuild the web client,
 * optionally rebuild the desk image and recreate idle desks, then exit 75 so `scripts/serve.sh` restarts the server.
 * Every step's start/end is a `system` event (output tail in the payload). Single-flight; runs in the background.
 */
import { execFile } from "node:child_process";
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
  world: World;
  /** Agent Town repo root (the server's REPO_ROOT) */
  repoRoot: string;
  /** desk container label value (`agent-town.collective`), already docker-safe */
  collective: string;
  /** desk image tag to build */
  image: string;
  /** whether the agent has a live work session (its desk is left alone) */
  isWorking(agentId: string): boolean;
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

    // (d) desk image, then recreate idle desks (home volumes kept; a desk is recreated from the new image on next use)
    if (o.image) {
      if (!(await step("docker build desk image", "docker", ["build", "-t", deps.image, "-f", "packages/desk/Dockerfile", "."], 3_600_000))) return;
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

    // (e) restart: give the HTTP response and the events a moment to flush
    say("Redeploy: restarting server", { step: "restart", phase: "end", ok: true });
    await new Promise<void>((r) => setTimeout(r, deps.exitDelayMs ?? 500));
    exit(RESTART_EXIT_CODE);
  }

  return {
    redeploy(o) {
      if (flight) return { running: true };
      flight = go(o)
        .catch((e) => { say(`Redeploy: failed (${e instanceof Error ? e.message : String(e)})`, { ok: false }); })
        .finally(() => { flight = null; });
      return { started: true };
    },
    running: () => !!flight,
    done: () => flight ?? Promise.resolve(),
  };
}
