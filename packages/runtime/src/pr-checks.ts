/**
 * `{pr: N}` waits (docs/wakes.md, "Waiting on CI"): a fork that pushed a PR parks on its checks instead of guessing an
 * `{after}` time. Once a minute the runtime reads, for each PR a pending wait names, the PR's head commit and its check
 * suites on GitHub; `world.host.prChecks` answers from that cache, so `waitMet` stays synchronous. A finished commit is
 * cached for good (its checks can't change), so a PR that is done costs one call per poll until the wait clears.
 *
 * Merge when green (grant gr_rlt0ctnhqk): a wait with `merge: true` is not released on passed checks. On the read that
 * sees them pass with no conflict, the poller marks the PR ready (GraphQL), squash-merges it with its title and deletes
 * its branch, and caches it `merged` (core `checkWaits` then closes the parked work as done, no session). A conflict, a
 * branch that is not an agent's, or a merge GitHub refuses is cached `failed` with the reason, so the work wakes as for
 * red checks.
 */
import { queueMainFix, type MainCi, type PrChecks, type RedCommit, type World } from "@muster-town/core";

/** How often pending PR waits (and main's head) are re-read from GitHub. */
const PR_POLL_MS = 60_000;
/** Without a repo token GitHub allows 60 calls/h: main is then read at most this often (gr_7op2v8fjcl step 1). */
const MAIN_ANON_POLL_MS = 5 * 60_000;

/** A check suite or run conclusion that counts as passed; anything else (failure, cancelled, timed_out, …) failed. */
const OK = new Set(["success", "neutral", "skipped"]);
/**
 * ci.yml's jobs that deploy a commit whose `check` passed (`promote`: fast-forward prod and ask for a redeploy; `image`:
 * build the desk image). On main their failure is a failed deploy, not broken code: main stays green and no fix is
 * queued (as_dh0rv1hv0f). The deploy itself shows on /api/health's `commit`.
 */
const DEPLOY_JOBS = new Set(["promote", "image"]);

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

/** The fields of GET /pulls/N the poller reads. */
interface PullRead {
  state: string; merged?: boolean; merged_at?: string | null; merge_commit_sha?: string | null; mergeable?: boolean | null;
  draft?: boolean; title?: string; node_id?: string;
  head: { sha: string; ref?: string; repo?: { full_name: string } | null }; base?: { ref: string; repo?: { full_name: string } | null };
}
interface Suite { status: string; conclusion: string | null; latest_check_runs_count?: number; app?: { slug?: string } }
interface Run { name: string; status: string; conclusion: string | null; html_url?: string }
interface CommitChecks { suites: number; complete: boolean; bad: boolean; done: number; total: number; failed: string[]; failedUrls: string[]; ended: { name: string; conclusion: string; url?: string }[] }

/**
 * Main's state from its head's checks: pending until every check finished; red only when a code check failed (a deploy
 * job's failure is not red, see DEPLOY_JOBS); a cancelled code check (a newer push superseded the run, or a human
 * cancelled it) leaves main pending, never red: nothing failed, so nobody is named or queued to fix it.
 */
function mainStateOf(c: Pick<CommitChecks, "complete" | "ended">): { state: "green" | "red" | "pending"; failedStep: string | null; failedUrls: string[] } {
  if (!c.complete) return { state: "pending", failedStep: null, failedUrls: [] };
  const code = c.ended.filter((r) => !DEPLOY_JOBS.has(r.name));
  const failed = code.filter((r) => !OK.has(r.conclusion) && r.conclusion !== "cancelled");
  if (failed.length) return { state: "red", failedStep: failed.map((r) => r.name).join(", "), failedUrls: failed.flatMap((r) => r.url ? [r.url] : []) };
  if (code.some((r) => r.conclusion === "cancelled")) return { state: "pending", failedStep: null, failedUrls: [] };
  return { state: "green", failedStep: null, failedUrls: [] };
}

export function createPrPoller(world: World, deps: PrPollerDeps): PrPoller {
  const cache = new Map<number, PrChecks>();
  const finished = new Map<string, CommitChecks>();
  const now = deps.now ?? (() => new Date());
  const every = deps.everyMs ?? PR_POLL_MS;
  let last = -Infinity, lastMain = -Infinity, running: Promise<void> | null = null, calls = 0, callsLast = 0;
  let main: MainCi | undefined = world.town.mainCi() ?? undefined;

  /** One GitHub call (REST, GET by default, or GraphQL), answered as the raw response so a caller can read a refusal. */
  async function call(path: string, init: { method?: string; body?: unknown; graphql?: boolean } = {}): Promise<Response> {
    calls++;
    const r = githubRepoOf(deps.repoUrl());
    if (!r) throw new Error("the collective's repoUrl is not a GitHub repo");
    const token = deps.token();
    const url = init.graphql ? "https://api.github.com/graphql" : `https://api.github.com/repos/${r.owner}/${r.repo}${path}`;
    return await (deps.fetch ?? fetch)(url, {
      method: init.method ?? (init.graphql ? "POST" : "GET"),
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  }

  async function gh<T>(path: string): Promise<T> {
    const res = await call(path);
    if (!res.ok) throw new Error(`GitHub ${path}: HTTP ${res.status}`);
    return await res.json() as T;
  }

  /** GitHub's reason for a refused call: its JSON `message`, else the status. */
  async function refusal(res: Response): Promise<string> {
    let msg = "";
    try { msg = String(((await res.json()) as { message?: unknown }).message ?? ""); } catch { /* not JSON */ }
    return `HTTP ${res.status}${msg ? `: ${msg}` : ""}`;
  }

  /**
   * Merge a green PR for a merge-when-green wait: ready (a draft can't merge), squash with its title, delete its branch.
   * Only an agent branch of this repo (`<branchPrefix>/…`, not a fork's) is merged; mergeable null (GitHub still
   * computing) stays pending until the next poll. The result is what the wait reads: merged, failed with why, or pending.
   */
  async function mergeGreen(n: number, p: PullRead, c: CommitChecks, checkedAt: string): Promise<PrChecks> {
    const base = { sha: p.head.sha, done: c.done, total: c.total, checkedAt };
    const no = (why: string): PrChecks => ({ state: "failed", ...base, failed: [why] });
    if (p.mergeable === false) return no(`merge conflict with ${p.base?.ref ?? "the base branch"}: merge it into the branch and push`);
    if (p.mergeable == null) return { state: "pending", ...base };
    const prefix = `${world.town.get().workspace?.branchPrefix ?? "agent"}/`;
    const sameRepo = !p.head.repo || !p.base?.repo || p.head.repo.full_name === p.base.repo.full_name;
    if (!p.head.ref?.startsWith(prefix) || !sameRepo) return no(`not merged by the town: ${p.head.ref ?? "its branch"} is not an ${prefix}… branch of this repo`);
    if (!deps.token()) return no("not merged by the town: it has no GitHub token for the repo");
    if (p.draft) {
      const res = await call("", { graphql: true, body: { query: "mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { isDraft } } }", variables: { id: p.node_id } } });
      const out = res.ok ? await res.json() as { errors?: { message: string }[] } : null;
      if (!res.ok || out?.errors?.length) return no(`merge refused: could not mark it ready for review (${out?.errors?.[0]?.message ?? await refusal(res)})`);
    }
    const title = `${p.title ?? `PR #${n}`} (#${n})`;
    const res = await call(`/pulls/${n}/merge`, { method: "PUT", body: { merge_method: "squash", commit_title: title, sha: p.head.sha } });
    if (!res.ok) {
      const why = await refusal(res);
      // a push landed since this read (409: head moved) or main moved under the merge (405 "Base branch was modified"):
      // not a refusal, the next poll reads the PR again
      if (res.status === 409 || /base branch was modified/i.test(why)) return { state: "pending", ...base };
      return no(`merge refused: ${why}`);
    }
    const merged = await res.json() as { sha?: string };
    const del = await call(`/git/refs/heads/${p.head.ref}`, { method: "DELETE" });
    if (!del.ok && del.status !== 422) deps.log?.(`PR #${n}: merged, but its branch ${p.head.ref} was not deleted (${await refusal(del)})`);
    deps.log?.(`PR #${n}: merged when green as ${merged.sha?.slice(0, 8) ?? "?"}`);
    return { state: "merged", ...base, ...(merged.sha ? { mergeSha: merged.sha } : {}), mergedBy: "town" };
  }

  /** A commit's checks; a finished commit is cached for good (its checks can't change). */
  async function checksOf(sha: string): Promise<CommitChecks> {
    const hit = finished.get(sha);
    if (hit) return hit;
    // suites with no runs are apps installed on the repo that never report (render, vercel, …): they stay "queued" forever
    const suites = (await gh<{ check_suites: Suite[] }>(`/commits/${sha}/check-suites?per_page=100`)).check_suites.filter((s) => (s.latest_check_runs_count ?? 0) > 0);
    const runs = (await gh<{ check_runs: Run[] }>(`/commits/${sha}/check-runs?per_page=100`)).check_runs;
    const done = runs.filter((r) => r.status === "completed").length;
    const bad_ = runs.filter((r) => r.status === "completed" && !OK.has(r.conclusion ?? ""));
    const failed = bad_.map((r) => r.name), failedUrls = bad_.flatMap((r) => r.html_url ? [r.html_url] : []);
    // a suite completes only when its whole workflow did (jobs that `need` another may not have a run yet)
    const complete = suites.length > 0 && suites.every((s) => s.status === "completed") && done === runs.length;
    const bad = failed.length > 0 || suites.some((s) => !OK.has(s.conclusion ?? ""));
    const ended = runs.filter((r) => r.status === "completed").map((r) => ({ name: r.name, conclusion: r.conclusion ?? "", ...(r.html_url ? { url: r.html_url } : {}) }));
    const out = { suites: suites.length, complete, bad, done, total: runs.length, failed, failedUrls, ended };
    if (complete) finished.set(sha, out);
    return out;
  }

  async function read(pr: number, merge: boolean): Promise<PrChecks> {
    const checkedAt = now().toISOString();
    const p = await gh<PullRead>(`/pulls/${pr}`);
    const sha = p.head.sha;
    if (p.state !== "open") {
      const merged = !!(p.merged || p.merged_at);
      // a PR the town merged on an earlier read keeps saying so (the wait may clear on a later tick)
      const prev = cache.get(pr);
      return { state: merged ? "merged" : "closed", sha, done: 0, total: 0, checkedAt, ...(merged && p.merge_commit_sha ? { mergeSha: p.merge_commit_sha } : {}), ...(merged && prev?.mergedBy ? { mergedBy: prev.mergedBy } : {}) };
    }
    const c = await checksOf(sha);
    // a PR that conflicts with its base gets no pull_request run at all (PR #194, 2026-10-31): fail it rather than hold 24 h.
    // `mergeable` is null while GitHub computes it; not cached, since merging main in moves the head anyway
    if (!c.suites && p.mergeable === false) return { state: "failed", sha, done: 0, total: 0, failed: ["merge conflict: CI did not run"], checkedAt };
    if (!c.complete) return { state: "pending", sha, done: c.done, total: c.total, checkedAt };
    if (merge && !c.bad) return await mergeGreen(pr, p, c, checkedAt);
    return { state: c.bad ? "failed" : "passed", sha, done: c.done, total: c.total, ...(c.bad ? { failed: c.failed } : {}), checkedAt };
  }

  /**
   * Who wrote a red commit, as an agent slug (core/main-fix.ts routes its fix to that agent's building): a desk commit's
   * `<slug>@muster-town.local` author, a merge commit's `from <owner>/agent/<slug>/…` branch, else (a squash merge, which
   * GitHub authors as the merger) the branch of the PR that brought it. Read once per red sha; null when none says.
   */
  async function redCommit(sha: string, runUrls: string[]): Promise<RedCommit> {
    const c = await gh<{ commit: { author: { name: string; email: string }; message: string } }>(`/commits/${sha}`);
    const { name, email } = c.commit.author;
    let slug = /^([a-z0-9-]+)@muster-town\.local$/.exec(email)?.[1] ?? /^Merge pull request #\d+ from [\w.-]+\/agent\/([a-z0-9-]+)\//.exec(c.commit.message)?.[1] ?? null;
    let via = "";
    if (!slug) {
      const prs = await gh<{ number: number; head: { ref: string } }[]>(`/commits/${sha}/pulls`);
      const pr = prs.find((p) => /^agent\/[a-z0-9-]+\//.test(p.head.ref));
      if (pr) { slug = /^agent\/([a-z0-9-]+)\//.exec(pr.head.ref)![1]; via = ` (PR #${pr.number} from ${pr.head.ref})`; }
    }
    return { slug, author: `${name} <${email}>${via}`, runUrls };
  }

  /**
   * Main's head and its checks (gr_7op2v8fjcl, kr_mvj61meiwx): green once every check finished and passed, red once a
   * code check failed (failedStep names it), pending while they run or when a run was cancelled (mainStateOf). `since` is the first poll that saw this state; it is kept in the
   * world (meta `mainCi`) so a restart keeps it. A red read queues the one fix assignment for its sha (step 2,
   * core/main-fix.ts); the fix fields last until main is green again, so a pending fix push doesn't drop its fixer.
   */
  async function readMain(): Promise<void> {
    const checkedAt = now().toISOString();
    const sha = (await gh<{ object: { sha: string } }>("/git/ref/heads/main")).object.sha;
    const c = await checksOf(sha);
    const { state, failedStep, failedUrls } = mainStateOf(c);
    const same = main && main.state === state;
    const fix = main && state !== "green" ? { fixer: main.fixer, fixSha: main.fixSha ?? null, fixAssignmentId: main.fixAssignmentId ?? null } : { fixer: null, fixSha: null, fixAssignmentId: null };
    const next: MainCi = { state, sha, failedStep, since: same ? main!.since : checkedAt, ...fix, checkedAt };
    const changed = !main || main.sha !== sha || main.state !== state || main.failedStep !== failedStep || main.fixer !== next.fixer;
    main = next;
    if (changed) world.town.setMainCi(next);
    if (state === "red" && next.fixSha !== sha) {
      let commit: RedCommit;
      try { commit = await redCommit(sha, failedUrls); } catch (e) {
        deps.log?.(`main checks: who wrote ${sha.slice(0, 7)}: ${e instanceof Error ? e.message : String(e)}`);
        commit = { slug: null, author: "author not read", runUrls: failedUrls };
      }
      main = queueMainFix(world, next, commit);
    }
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
    // PR → whether a wait on it asks the town to merge it when green
    const prs = new Map<number, boolean>();
    for (const a of world.assignments.where("status = 'pending' AND waitFor IS NOT NULL", [], "ORDER BY createdAt")) {
      if (a.waitFor && "pr" in a.waitFor) prs.set(a.waitFor.pr, (prs.get(a.waitFor.pr) ?? false) || !!a.waitFor.merge);
    }
    for (const n of [...cache.keys()]) if (!prs.has(n)) cache.delete(n);
    for (const [n, merge] of prs) {
      try { cache.set(n, await read(n, merge)); } catch (e) { deps.log?.(`PR #${n} checks: ${e instanceof Error ? e.message : String(e)}`); }
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
