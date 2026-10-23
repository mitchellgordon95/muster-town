/**
 * v1.3 redeploy (host-executed): pull main (or the deploy branch), reinstall when the lockfile changed, rebuild the web client,
 * optionally rebuild the desk image, drain (hold new work sessions and wait, up to `drainTimeoutMs`, for running ones
 * to end), pull again (the sessions drained are usually the ones about to push) and rebuild if that moved HEAD,
 * recreate idle desks, then exit 75 so `scripts/serve.sh` restarts the server.
 * Every step's start/end is a `system` event (output tail in the payload). Single-flight: a request while one runs joins
 * it (the post-drain pull picks up its commits); past that pull it is carried in the done-file and the restarted server
 * runs once more. Runs in the background.
 */
import { execFile, execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { World } from "@muster-town/core";
import { townEnv, type Event, type RedeployLive, type RedeployResult, type RedeployRun } from "@muster-town/schema";
import { DESK_IMAGE, DESK_LABEL_PREFIXES, OLD_DESK_IMAGE } from "./desk/backend.ts";

export interface CmdResult { code: number; stdout: string; stderr: string }
/** Runs one command (no shell). Injected in tests. */
export type CommandRunner = (cmd: string, args: string[], opts: { cwd: string; timeoutMs?: number; env?: Record<string, string> }) => Promise<CmdResult>;

export const realCommandRunner: CommandRunner = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeoutMs ?? 600_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env } }, (err, stdout, stderr) => {
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
  /** Muster Town repo root (the server's REPO_ROOT) */
  repoRoot: string;
  /** desk container label value (`muster-town.collective`), already docker-safe */
  collective: string;
  /** desk image tag to build */
  image: string;
  /** whether this host can build the desk image (`docker build`); false on a sandbox-desk host (Fly), where the image is built elsewhere. Default true. */
  imageBuild?: boolean;
  /** extra env for the git commands (the collective's repo token as a credential helper); never logged */
  gitEnv?: () => Record<string, string>;
  /** branch to pull from origin (prod follows a CI-moved `prod` branch). Default: MUSTER_TOWN_DEPLOY_BRANCH, else `main`. */
  branch?: string;
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
  /**
   * The drain found `agentId` stuck (idle for more than STUCK_POLLS polls yet still counted as working): end its session
   * as orphaned and forget its live entry so the drain stops waiting for it. Default: the drain just stops counting it.
   */
  drop?(agentId: string): void;
  /** an agent that already filed its report (idle while its session wraps up, e.g. pushing) counts as stuck only after this long idle. Default 5 min. */
  drainWrapUpMs?: number;
  /**
   * Tell a session the drain waits on that the restart comes only after it ends (so it wraps up instead of polling for
   * the new build: the requester's own session otherwise deadlocks the drain). Called once per agent per drain. Default: none.
   */
  nudge?(agentId: string, text: string): void;
  run?: CommandRunner;
  /** called with 75 after `exitDelayMs`; default process.exit (tests always inject one) */
  exit?: (code: number) => void;
  exitDelayMs?: number;
  /** delay before running a request the previous server carried over (it joined past the final pull). Default 10 s. */
  againDelayMs?: number;
}

export interface RedeployRequest { image: boolean; requestedBy: string }

export interface Redeployer {
  redeploy(o: RedeployRequest): RedeployResult;
  running(): boolean;
  /** resolves when the in-flight redeploy (if any) has finished */
  done(): Promise<void>;
  /** live state for `GET /api/admin/redeploy` */
  status(): RedeployLive;
}

/** A drain poll that finds an agent idle more than this many times in a row drops it (stale live state). */
export const STUCK_POLLS = 3;
const TERMINAL_STATES = new Set<RedeployRun["state"]>(["restarting", "done", "failed", "aborted"]);
/** Whether a redeploy event ends its run: `terminal: true`, or (events from before that field) a run state that does. */
export function isTerminalRedeployEvent(e: Pick<Event, "payload">): boolean {
  const p = e.payload as { terminal?: boolean; run?: RedeployRun };
  return p.terminal === true || (!!p.run && TERMINAL_STATES.has(p.run.state));
}

/** What the drain tells a session it waits on. */
export function drainNudge(requester: boolean): string {
  return `${requester ? "The redeploy you requested" : "A redeploy"} is waiting for your work session to end before it restarts the server. The new build cannot go live while you are running, so do not wait or poll for it: finish the step you are on, push, say in your report which commit should be live, submit the report, and stop. Verify on your next session.`;
}

const TAIL = 2000;
const tail = (r: CmdResult) => (r.stdout + (r.stderr ? `\n${r.stderr}` : "")).trim().slice(-TAIL);

export function makeRedeployer(deps: RedeployDeps): Redeployer {
  const run = deps.run ?? realCommandRunner;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const cwd = deps.repoRoot;
  const buildImage = deps.imageBuild !== false;
  const gitEnv = () => deps.gitEnv?.() ?? {};
  const branch = deps.branch ?? townEnv("DEPLOY_BRANCH")?.trim() ?? "main";
  let flight: Promise<void> | null = null;
  let held = false;
  let run_: RedeployRun = { state: "running", requestedBy: "", commits: null, working: [], blocked: [] };
  /** the in-flight request (a joining request may turn on its image) */
  let cur: RedeployRequest | null = null;
  /** set once the run is past its final pull: a request then needs another run after the restart */
  let finalPulled = false;
  let again: RedeployRequest | null = null;
  /** a request the previous server carried over in its done-file: started shortly after this one is up */
  let carried: RedeployRequest | null = null;

  /** every event carries the run; the last one of a run (restarting, failed, done, aborted) also says `terminal: true` */
  const say = (text: string, payload: Record<string, unknown> = {}) =>
    deps.world.events.append({ type: "system", text, payload: { redeploy: true, run: { ...run_ }, ...(TERMINAL_STATES.has(run_.state) ? { terminal: true } : {}), ...payload } });
  let phase = "idle";
  let since: string | null = null;
  const setPhase = (p: string) => { phase = p; since = p === "idle" ? null : new Date().toISOString(); };
  const fail = () => { run_ = { ...run_, state: "failed", working: [], blocked: [] }; };

  // The restart's marker (written just before exit 75): the new server announces the redeploy finished.
  // Per collective, since several share one checkout.
  const donePath = join(cwd, `.muster-town-redeploy-done-${deps.collective}.json`);
  // the first restart after the rename was written by the old code under the old name (drop in rename P6)
  const oldDonePath = join(cwd, `.agent-town-redeploy-done-${deps.collective}.json`);
  try {
    const path = existsSync(donePath) ? donePath : oldDonePath;
    const prev = JSON.parse(readFileSync(path, "utf8")) as Partial<RedeployRun> & { again?: RedeployRequest };
    unlinkSync(path);
    const head = typeof prev.head === "string" ? prev.head : undefined;
    run_ = { state: "done", requestedBy: String(prev.requestedBy ?? ""), commits: typeof prev.commits === "number" ? prev.commits : null, working: [], blocked: [], ...(head ? { head } : {}) };
    const n = run_.commits;
    say(`Redeploy finished: the server is back up${n === null ? "" : ` with ${n} new change${n === 1 ? "" : "s"}`}${head ? ` at ${head.slice(0, 7)}` : ""}`, { phase: "done", head: head ?? null });
    if (prev.again) carried = { image: !!prev.again.image, requestedBy: String(prev.again.requestedBy ?? "") };
  } catch { /* no restart pending */ }

  // A server restarted directly (not by the redeploy's exit 75) mid-run leaves its last event non-terminal, so the
  // event-derived banner would wait forever: close the run.
  try {
    const last = deps.world.events.latestWith("system", "redeploy");
    if (last && !isTerminalRedeployEvent(last)) {
      const prevRun = (last.payload as { run?: RedeployRun }).run;
      run_ = { state: "aborted", requestedBy: prevRun?.requestedBy ?? "", commits: prevRun?.commits ?? null, working: [], blocked: [] };
      say("Redeploy: ended by a server restart (the run was interrupted)", { phase: "end", terminal: true, ok: false, aborted: true });
    }
  } catch (e) { console.log("[runtime] redeploy startup check:", e instanceof Error ? e.message : e); }

  /** One step: start event, run, end event. Returns the result, or null (after a failure event) on a non-zero exit. */
  async function step(label: string, cmd: string, args: string[], timeoutMs: number, okNote?: () => Promise<string>): Promise<CmdResult | null> {
    setPhase(label);
    say(`Redeploy: ${label} …`, { step: label, phase: "start" });
    const r = await run(cmd, args, { cwd, timeoutMs, ...(cmd === "git" ? { env: gitEnv() } : {}) });
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

    // (a) pull the deploy branch; a dirty tree aborts
    setPhase("git status");
    const status = await run("git", ["status", "--porcelain"], { cwd, timeoutMs: 30_000 });
    if (status.code !== 0 || status.stdout.trim()) {
      fail();
      say(status.code !== 0 ? `Redeploy: aborted, git status failed (exit ${status.code})` : "Redeploy: aborted, the working tree is dirty",
        { step: "git status", phase: "end", ok: false, code: status.code, output: tail(status) });
      return;
    }
    const head = async () => (await run("git", ["rev-parse", "HEAD"], { cwd, timeoutMs: 30_000 })).stdout.trim();
    const before = await head();
    /** commits since `from`, and whether package-lock.json changed */
    const since = async (from: string) => ({
      count: Number((await run("git", ["rev-list", "--count", `${from}..HEAD`], { cwd, timeoutMs: 30_000 })).stdout.trim()) || 0,
      lock: !!(await run("git", ["diff", "--name-only", from, "HEAD", "--", "package-lock.json"], { cwd, timeoutMs: 30_000 })).stdout.trim(),
    });
    let lockChanged = false;
    const pulled = await step(`git pull --rebase origin ${branch}`, "git", ["pull", "--rebase", "origin", branch], 300_000, async () => {
      if (!before) return "";
      const d = await since(before);
      run_ = { ...run_, commits: d.count };
      lockChanged = d.lock;
      return `${d.count} commit${d.count === 1 ? "" : "s"}`;
    });
    if (!pulled) return;

    /** (b) reinstall only when the lockfile changed, (c) the web client, (d) the desk image when asked (and not built yet) */
    let imageBuilt = false;
    async function rebuild(lock: boolean, label = ""): Promise<boolean> {
      if (lock) {
        // --include=dev: the server (tsx) and the web build (vite) run on devDependencies, whatever NODE_ENV says
        if (!(await step(`npm install${label}`, "npm", ["install", "--include=dev", "--no-audit", "--no-fund"], 900_000))) return false;
      } else {
        say(`Redeploy: npm install${label} … skipped (package-lock.json unchanged)`, { step: "npm install", phase: "end", ok: true, skipped: true });
      }
      if (!(await step(`build web${label}`, "npm", ["run", "build", "--workspace", "packages/web"], 600_000))) return false;
      if (o.image && buildImage) {
        if (!(await step(`docker build desk image${label}`, "docker", ["build", ...imageTags(deps.image).flatMap((t) => ["-t", t]), "-f", "packages/desk/Dockerfile", "."], 3_600_000))) return false;
        imageBuilt = true;
      }
      return true;
    }
    if (o.image && !buildImage) {
      say("Redeploy: desk image … skipped (this host runs sandbox desks; the image is built and pushed from outside the town, see fly.desk.toml)", { step: "docker build desk image", phase: "end", ok: true, skipped: true });
    }
    if (!(await rebuild(lockChanged))) return;

    // (e) drain: no new work sessions; wait for the running ones to end (a restart would orphan them)
    setPhase("drain");
    deps.hold?.(true);
    held = true;
    const working = () => deps.working?.() ?? [];
    const names = (ids: string[]) => ids.map((id) => deps.world.agents.get(id)?.name ?? id).join(", ");
    const timeoutMs = deps.drainTimeoutMs ?? 30 * 60_000;
    const blocked = () => deps.blocked?.() ?? [];
    let left = working();
    if (left.length) {
      run_ = { ...run_, state: "scheduled", working: left, blocked: blocked() };
      const requester = left.find((id) => deps.world.agents.get(id)?.name === o.requestedBy);
      say(`Redeploy: draining, waiting for ${left.length} session(s) to end: ${names(left)} (up to ${Math.round(timeoutMs / 60_000)} min)${requester ? `; ${o.requestedBy} requested it and is still running, so it waits for them too` : ""}`, { step: "drain", phase: "start", working: left, ...(requester ? { requester } : {}) });
      // each session waited on is told once, so nobody sits polling for a restart that waits on them
      const nudged = new Set<string>();
      const nudge = (ids: string[]) => {
        for (const id of ids) {
          if (nudged.has(id)) continue;
          nudged.add(id);
          try { deps.nudge?.(id, drainNudge(id === requester)); } catch (e) { console.log("[runtime] drain nudge:", e instanceof Error ? e.message : e); }
        }
      };
      nudge(left);
      const until = Date.now() + timeoutMs;
      /** consecutive polls each agent was seen not `working`, and since when */
      const idle = new Map<string, { polls: number; since: number }>();
      const dropped = new Set<string>();
      while (left.length && Date.now() < until) {
        await new Promise<void>((r) => setTimeout(r, Math.min(deps.drainPollMs ?? 5000, Math.max(1, until - Date.now()))));
        left = working().filter((id) => !dropped.has(id));
        // stale live state: an agent that is idle poll after poll isn't really working (its desk died, its session
        // was orphaned). One that filed its report may still be wrapping up (pushing), so it gets a grace period.
        for (const id of left) {
          const a = deps.world.agents.get(id);
          if (!a || a.status === "working") { idle.delete(id); continue; }
          const seen = idle.get(id) ?? { polls: 0, since: Date.now() };
          seen.polls++;
          idle.set(id, seen);
          const reported = !!deps.world.sessions.first("agentId = ? AND status = 'running' AND purpose = 'work'", [id], "ORDER BY startedAt DESC")?.reportId;
          if (seen.polls <= STUCK_POLLS || (reported && Date.now() - seen.since < (deps.drainWrapUpMs ?? 5 * 60_000))) continue;
          dropped.add(id);
          say(`Redeploy: drain stuck on ${a.name} (idle but still counted); dropping`, { step: "drain", phase: "drain", stuck: true, agentId: id });
          try { deps.drop?.(id); } catch (e) { console.log("[runtime] drain drop:", e instanceof Error ? e.message : e); }
        }
        left = left.filter((id) => !dropped.has(id));
        nudge(left);
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

    // (e2) pull again: the sessions just drained usually pushed on their way out. A failed pull keeps the preflight's
    // build; a failed rebuild of what it pulled fails the run (the tree is past the build).
    setPhase("git pull again");
    const mid = await head();
    finalPulled = true;
    const again2 = await run("git", ["pull", "--rebase", "origin", branch], { cwd, timeoutMs: 300_000, env: gitEnv() });
    if (again2.code !== 0) {
      say(`Redeploy: pull again after the drain … failed (exit ${again2.code}); restarting with what was pulled before`, { step: "git pull again", phase: "end", ok: false, code: again2.code, output: tail(again2) });
    } else {
      const d = mid ? await since(mid) : { count: 0, lock: false };
      if (d.count) {
        run_ = { ...run_, commits: (run_.commits ?? 0) + d.count };
        say(`Redeploy: pull again after the drain … ok (${d.count} more commit${d.count === 1 ? "" : "s"})`, { step: "git pull again", phase: "end", ok: true, code: 0, output: tail(again2) });
        if (!(await rebuild(d.lock, " (again)"))) return;
      } else {
        say("Redeploy: pull again after the drain … ok (no new commits)", { step: "git pull again", phase: "end", ok: true, code: 0 });
        // a request that joined during the drain may have asked for the image
        if (o.image && buildImage && !imageBuilt && !(await rebuild(false, " (again)"))) return;
      }
    }

    // (f) recreate idle desks (home volumes kept; a desk is recreated from the new image on next use)
    if (o.image && buildImage) {
      setPhase("recreate desks");
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
    setPhase("restarting");
    const live = await head();
    run_ = { ...run_, state: "restarting", working: [], blocked: [], ...(live ? { head: live } : {}) };
    try { writeFileSync(donePath, JSON.stringify({ ...run_, ...(again ? { again } : {}) })); } catch { /* no repo dir (tests): the UI just won't hear "done" */ }
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

  const self: Redeployer = {
    redeploy(o) {
      if (flight && cur) {
        // join the running one: its post-drain pull picks up anything pushed by now. Past that pull, run again after the restart.
        if (!finalPulled) {
          if (o.image) cur.image = true;
          say(`Redeploy: ${o.requestedBy}'s request joins the running one`, { phase: "joined", requestedBy: o.requestedBy, image: o.image });
        } else {
          again = { image: !!(again?.image || o.image), requestedBy: o.requestedBy };
          say(`Redeploy: ${o.requestedBy}'s request will run again after this restart`, { phase: "joined", requestedBy: o.requestedBy, image: o.image, again: true });
        }
        return { queued: true };
      }
      cur = { ...o };
      finalPulled = false;
      setPhase("requested");
      run_ = { state: "running", requestedBy: o.requestedBy, commits: null, working: [], blocked: [] };
      const req = cur;
      flight = withRepoLock(() => go(req))
        .catch((e) => { fail(); say(`Redeploy: failed (${e instanceof Error ? e.message : String(e)})`, { ok: false }); })
        .finally(() => {
          flight = null;
          cur = null;
          setPhase("idle");
          // a failed run drops the requests that joined it (they saw the failure event)
          again = null;
          // only reached without a real exit (failure, or tests): let the scheduler start sessions again
          if (held) { held = false; deps.hold?.(false); }
        });
      return { started: true };
    },
    running: () => !!flight,
    done: () => flight ?? Promise.resolve(),
    status: () => ({
      running: !!flight, phase: flight ? phase : "idle", since: flight ? since : null,
      waitingFor: flight && phase === "drain" ? run_.working.map((id) => deps.world.agents.get(id)?.name ?? id) : [],
    }),
  };
  if (carried) {
    const o = carried;
    setTimeout(() => { if (!flight) self.redeploy(o); }, deps.againDelayMs ?? 10_000).unref?.();
  }
  return self;
}

/** HEAD of the checkout at `repoRoot` (the code this server started from), or null when it isn't a git checkout. */
export function gitHead(repoRoot: string): string | null {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || null; } catch { return null; }
}

/** Whether `sha` is in the history of `head` (`git merge-base --is-ancestor`); false when unknown here (not pulled yet). The checkout only changes on a pull, which precedes a restart, so a result holds for this server's life. */
export function isAncestor(repoRoot: string, sha: string, head: string): boolean {
  try { execFileSync("git", ["merge-base", "--is-ancestor", sha, head], { cwd: repoRoot, timeout: 10_000, stdio: "ignore" }); return true; } catch { return false; }
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
