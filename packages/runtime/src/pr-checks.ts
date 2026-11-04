/**
 * `{pr: N}` waits (docs/wakes.md, "Waiting on CI"): a fork that pushed a PR parks on its checks instead of guessing an
 * `{after}` time. Once a minute the runtime reads, for each PR a pending wait names, the PR's head commit and its check
 * suites on GitHub; `world.host.prChecks` answers from that cache, so `waitMet` stays synchronous. A finished commit is
 * cached for good (its checks can't change), so a PR that is done costs one call per poll until the wait clears.
 */
import type { MainCi, PrChecks, World } from "@muster-town/core";

/** How often pending PR waits (and main's head) are re-read from GitHub. */
const PR_POLL_MS = 60_000;
/** Without a repo token GitHub allows 60 calls/h: main is then read at most this often (gr_7op2v8fjcl step 1). */
const MAIN_ANON_POLL_MS = 5 * 60_000;

/** A check suite or run conclusion that counts as passed; anything else (failure, cancelled, timed_out, …) failed. */
const OK = new Set(["success", "neutral", "skipped"]);

/** `owner/repo` of a GitHub clone URL (https, scp-style or ssh), else null. */
export function githubRepoOf(url: string | undefined): { owner: string; repo: string } | null {
  const m = url && /github\.com[/:]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/*$/.exec(url);
  return m ? { owner: m[1], repo: m[2] } : null;
}

export interface PrPollerDeps {
  /** the collective's repo URL (the workspace's `repoUrl`) */
  repoUrl: () => string | undefined;
  /** GitHub token for the repo (`repoToken`); null = anonymous (public repos only, 60 calls/h) */
  token: () => string | null;
  /** tests inject one; default global fetch */
  fetch?: typeof fetch;
  now?: () => Date;
  everyMs?: number;
  log?: (msg: string) => void;
}

interface PrPoller {
  /** the last read of this PR (world.host.prChecks) */
  get(pr: number): PrChecks | undefined;
  /** main's CI as last read (world.host.mainCi); kept in the world, so `since` survives a restart */
  main(): MainCi | undefined;
  /** GitHub calls the last poll made (rate-limit budget: 5,000/h with a token, 60/h without) */
  lastCalls(): number;
  /** re-read every PR a pending wait names, at most once per `everyMs` (the runtime's tick calls it) */
  poll(force?: boolean): Promise<void>;
}

interface Suite { status: string; conclusion: string | null; latest_check_runs_count?: number; app?: { slug?: string } }
interface Run { name: string; status: string; conclusion: string | null }
interface CommitChecks { suites: number; complete: boolean; bad: boolean; done: number; total: number; failed: string[] }

export function createPrPoller(world: World, deps: PrPollerDeps): PrPoller {
  const cache = new Map<number, PrChecks>();
  const finished = new Map<string, CommitChecks>();
  const now = deps.now ?? (() => new Date());
  const every = deps.everyMs ?? PR_POLL_MS;
  let last = -Infinity, lastMain = -Infinity, running: Promise<void> | null = null, calls = 0, callsLast = 0;
  let main: MainCi | undefined = world.town.mainCi() ?? undefined;

  async function gh<T>(path: string): Promise<T> {
    calls++;
    const r = githubRepoOf(deps.repoUrl());
    if (!r) throw new Error("the collective's repoUrl is not a GitHub repo");
    const token = deps.token();
    const res = await (deps.fetch ?? fetch)(`https://api.github.com/repos/${r.owner}/${r.repo}${path}`, {
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    if (!res.ok) throw new Error(`GitHub ${path}: HTTP ${res.status}`);
    return await res.json() as T;
  }

  /** A commit's checks; a finished commit is cached for good (its checks can't change). */
  async function checksOf(sha: string): Promise<CommitChecks> {
    const hit = finished.get(sha);
    if (hit) return hit;
    // suites with no runs are apps installed on the repo that never report (render, vercel, …): they stay "queued" forever
    const suites = (await gh<{ check_suites: Suite[] }>(`/commits/${sha}/check-suites?per_page=100`)).check_suites.filter((s) => (s.latest_check_runs_count ?? 0) > 0);
    const runs = (await gh<{ check_runs: Run[] }>(`/commits/${sha}/check-runs?per_page=100`)).check_runs;
    const done = runs.filter((r) => r.status === "completed").length;
    const failed = runs.filter((r) => r.status === "completed" && !OK.has(r.conclusion ?? "")).map((r) => r.name);
    // a suite completes only when its whole workflow did (jobs that `need` another may not have a run yet)
    const complete = suites.length > 0 && suites.every((s) => s.status === "completed") && done === runs.length;
    const bad = failed.length > 0 || suites.some((s) => !OK.has(s.conclusion ?? ""));
    const out = { suites: suites.length, complete, bad, done, total: runs.length, failed };
    if (complete) finished.set(sha, out);
    return out;
  }

  async function read(pr: number): Promise<PrChecks> {
    const checkedAt = now().toISOString();
    const p = await gh<{ state: string; merged?: boolean; merged_at?: string | null; mergeable?: boolean | null; head: { sha: string } }>(`/pulls/${pr}`);
    const sha = p.head.sha;
    if (p.state !== "open") return { state: p.merged || p.merged_at ? "merged" : "closed", sha, done: 0, total: 0, checkedAt };
    const c = await checksOf(sha);
    // a PR that conflicts with its base gets no pull_request run at all (PR #194, 2026-10-31): fail it rather than hold 24 h.
    // `mergeable` is null while GitHub computes it; not cached, since merging main in moves the head anyway
    if (!c.suites && p.mergeable === false) return { state: "failed", sha, done: 0, total: 0, failed: ["merge conflict: CI did not run"], checkedAt };
    if (!c.complete) return { state: "pending", sha, done: c.done, total: c.total, checkedAt };
    return { state: c.bad ? "failed" : "passed", sha, done: c.done, total: c.total, ...(c.bad ? { failed: c.failed } : {}), checkedAt };
  }

  /**
   * Main's head and its checks (gr_7op2v8fjcl, kr_mvj61meiwx): green once every check finished and passed, red once one
   * failed (failedStep names it), pending while they run. `since` is the first poll that saw this state; it is kept in the
   * world (meta `mainCi`) so a restart keeps it. `fixer` stays null until step 2 queues the fix assignment.
   */
  async function readMain(): Promise<void> {
    const checkedAt = now().toISOString();
    const sha = (await gh<{ object: { sha: string } }>("/git/ref/heads/main")).object.sha;
    const c = await checksOf(sha);
    const state = !c.complete ? "pending" as const : c.bad ? "red" as const : "green" as const;
    const failedStep = state === "red" ? (c.failed.join(", ") || "a check suite failed") : null;
    const same = main && main.state === state;
    const next: MainCi = { state, sha, failedStep, since: same ? main!.since : checkedAt, fixer: same ? main!.fixer : null, checkedAt };
    const changed = !main || main.sha !== sha || main.state !== state || main.failedStep !== failedStep;
    main = next;
    if (changed) world.town.setMainCi(next);
  }

  async function pollNow(): Promise<void> {
    calls = 0;
    const t = now().getTime();
    const anon = !deps.token();
    if (t - lastMain >= (anon ? Math.max(every, MAIN_ANON_POLL_MS) : every)) {
      if (anon && lastMain === -Infinity) deps.log?.("main checks: no repo token (GitHub allows 60 calls/h), main is read every 5 min");
      lastMain = t;
      try { await readMain(); } catch (e) { deps.log?.(`main checks: ${e instanceof Error ? e.message : String(e)}`); }
    }
    const prs = new Set<number>();
    for (const a of world.assignments.where("status = 'pending' AND waitFor IS NOT NULL", [], "ORDER BY createdAt")) {
      if (a.waitFor && "pr" in a.waitFor) prs.add(a.waitFor.pr);
    }
    for (const n of [...cache.keys()]) if (!prs.has(n)) cache.delete(n);
    for (const n of prs) {
      try { cache.set(n, await read(n)); } catch (e) { deps.log?.(`PR #${n} checks: ${e instanceof Error ? e.message : String(e)}`); }
    }
    callsLast = calls;
  }

  return {
    get: (pr) => cache.get(pr),
    main: () => main,
    lastCalls: () => callsLast,
    poll(force = false) {
      const t = now().getTime();
      if (running) return running;
      if (!force && t - last < every) return Promise.resolve();
      last = t;
      running = pollNow().finally(() => { running = null; });
      return running;
    },
  };
}
