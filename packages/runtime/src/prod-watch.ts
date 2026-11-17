/**
 * The server pulls its own deploys (Mitchell, 1:1 mt_vdu3iqhasi, 2026-11-17): every minute it fetches the deploy branch
 * (`prod` on muster.town, which CI fast-forwards to each green main) into the host checkout and, when the tip is ahead of
 * the commit this server runs, starts the usual redeploy (redeploy.ts) as "prod branch". It replaces CI's push (a POST to
 * /api/admin/redeploy with a town token, which broke when the ghost sweep revoked that token, FYI dc_4yrb3979ty) and keeps
 * CI's two guards, now here:
 *  - docs-only: no restart when every file changed between live and the tip is one schema `deployable` says needs none
 *    (docs/ but docs/manual.md, .github/, top-level *.md); the monitor's `deploy` key (server deploy-watch.ts) uses the same filter.
 *  - spacing: no restart within PULL_SPACING_MS of the server's start or of the last one this watcher asked for; a tick while a
 *    redeploy runs (or another collective's holds the repo lock) is skipped. The same tip after a failed run waits PULL_RETRY_MS.
 * Nothing is ahead: nothing is called (the redeploy's own no-op guard is not relied on). A fetch failure is one system event,
 * then quiet until a fetch works again (one more event). On only where MUSTER_TOWN_DEPLOY_BRANCH is set (runtime index.ts).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { deployable } from "@muster-town/schema";
import { realCommandRunner, type CommandRunner, type Redeployer } from "./redeploy.ts";

/** least time between a server start (or a pull this watcher asked for) and the next restart it asks for; CI's promote used 15 min */
export const PULL_SPACING_MS = 10 * 60_000;
/** the same tip again after its redeploy did not take it live (a failed build, a dirty tree) */
export const PULL_RETRY_MS = 60 * 60_000;
/** how often the deploy branch is fetched */
const PULL_POLL_MS = 60_000;

type ProdWatchResult = "busy" | "no-live" | "fetch-failed" | "current" | "not-ahead" | "docs-only" | "spacing" | "redeploy";

interface ProdWatchDeps {
  repoRoot: string;
  /** the deploy branch (MUSTER_TOWN_DEPLOY_BRANCH) */
  branch: string;
  /** the commit this server runs (world.host.commit) */
  live: () => string | null;
  /** when this server started (world.host.startedAt) */
  startedAt: () => string | null;
  redeployer: Pick<Redeployer, "redeploy" | "running">;
  /** writes a system event */
  event: (text: string, payload: Record<string, unknown>) => void;
  gitEnv?: () => Record<string, string>;
  run?: CommandRunner;
  now?: () => number;
}

interface ProdWatch {
  /** one fetch and compare; starts a redeploy when the tip is ahead with a deployable change. Single-flight; never throws. */
  tick(): Promise<ProdWatchResult>;
  start(everyMs?: number): void;
  /** stops the timer and waits for a running tick (it may write an event) */
  stop(): Promise<void>;
}

export function makeProdWatch(d: ProdWatchDeps): ProdWatch {
  const run = d.run ?? realCommandRunner, now = d.now ?? Date.now, cwd = d.repoRoot;
  const ref = `refs/remotes/origin/${d.branch}`;
  let failing = false, stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let flight: Promise<ProdWatchResult> | null = null;
  /** `${live}..${tip}` → whether it carries a deployable change (one diff per pair) */
  const pairs = new Map<string, boolean>();
  let lastTry: { tip: string; at: number } | null = null;
  const say = (text: string, payload: Record<string, unknown>) => { if (!stopped) d.event(text, { prodWatch: true, branch: d.branch, ...payload }); };
  const git = (args: string[], timeoutMs = 30_000) => run("git", args, { cwd, timeoutMs, env: d.gitEnv?.() ?? {} });

  async function once(): Promise<ProdWatchResult> {
    // a redeploy (this server's, or another collective's on the same checkout) owns the repo's git now
    if (d.redeployer.running() || existsSync(join(cwd, ".muster-town-redeploy.lock"))) return "busy";
    const live = d.live();
    if (!live) return "no-live";
    // --no-write-fetch-head: the redeploy's `git pull` reads FETCH_HEAD (code.ts has the story)
    const f = await git(["fetch", "-q", "--no-write-fetch-head", "--no-tags", "origin", `+refs/heads/${d.branch}:${ref}`], 120_000);
    if (f.code !== 0) {
      if (!failing) say(`Prod watch: git fetch origin ${d.branch} failed (exit ${f.code}); retrying every minute, quiet until it works`, { ok: false, code: f.code, output: (f.stderr || f.stdout).trim().slice(-500) });
      failing = true;
      return "fetch-failed";
    }
    if (failing) { failing = false; say(`Prod watch: git fetch origin ${d.branch} works again`, { ok: true }); }
    const tip = (await git(["rev-parse", "--verify", "-q", `${ref}^{commit}`])).stdout.trim();
    if (!tip || tip === live) return "current";
    const key = `${live}..${tip}`;
    let deploy = pairs.get(key);
    if (deploy === undefined) {
      // only a fast-forward: live already has the tip (prod reset back) or has diverged from it → leave it to a human
      if ((await git(["merge-base", "--is-ancestor", live, tip])).code !== 0) return "not-ahead";
      const diff = await git(["diff", "--name-only", live, tip]);
      if (diff.code !== 0) return "not-ahead";
      deploy = diff.stdout.split("\n").map((l) => l.trim()).filter(Boolean).some(deployable);
      pairs.clear();
      pairs.set(key, deploy);
    }
    if (!deploy) return "docs-only";
    const t = now();
    const started = Date.parse(d.startedAt() ?? "");
    if (Number.isFinite(started) && t - started < PULL_SPACING_MS) return "spacing";
    if (lastTry && t - lastTry.at < (lastTry.tip === tip ? PULL_RETRY_MS : PULL_SPACING_MS)) return "spacing";
    if (stopped) return "busy";
    lastTry = { tip, at: t };
    d.redeployer.redeploy({ image: false, requestedBy: `${d.branch} branch` });
    return "redeploy";
  }

  const self: ProdWatch = {
    tick: () => (flight ??= once().catch((e) => { console.log("[runtime] prod watch:", e instanceof Error ? e.message : e); return "busy" as const; }).finally(() => { flight = null; })),
    start(everyMs = PULL_POLL_MS) {
      timer = setInterval(() => { void self.tick(); }, everyMs);
      timer.unref?.();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      await (flight ?? Promise.resolve());
    },
  };
  return self;
}
