/** `{pr}` waits (Mitchell, 1:1 mt_3jtclcoxl2): the runtime reads a parked PR's checks from GitHub and the wait releases when they finish. */
import { describe, expect, it } from "vitest";
import { checkWaits, World } from "@muster-town/core";
import { createPrPoller, githubRepoOf } from "../src/pr-checks.ts";

const SHA = "449b6e5aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/** A fake GitHub: one open PR #179 whose checks the test moves along. */
function fakeGitHub() {
  const gh = {
    pr: { state: "open", merged: false, mergeable: null as boolean | null, head: { sha: SHA } },
    // render/vercel-style apps that never report: queued forever with no runs (must be ignored)
    suites: [{ status: "queued", conclusion: null, latest_check_runs_count: 0 }, { status: "in_progress", conclusion: null, latest_check_runs_count: 1 }] as { status: string; conclusion: string | null; latest_check_runs_count: number }[],
    runs: [{ name: "check", status: "in_progress", conclusion: null }] as { name: string; status: string; conclusion: string | null }[],
    calls: [] as string[],
  };
  const fetch = (async (url: string) => {
    // main's head (read every poll since gr_7op2v8fjcl) answers 404 here and is left out of the PR call count
    if (url.endsWith("/git/ref/heads/main")) return new Response("{}", { status: 404 });
    gh.calls.push(url.replace("https://api.github.com/repos/mitchellgordon95/agent-town", ""));
    const body = url.endsWith("/pulls/179") ? gh.pr : url.includes("/check-suites") ? { check_suites: gh.suites } : url.includes("/check-runs") ? { check_runs: gh.runs } : null;
    return body ? new Response(JSON.stringify(body)) : new Response("{}", { status: 404 });
  }) as typeof globalThis.fetch;
  return { gh, fetch };
}

function worldWithWait() {
  const world = World.open(":memory:");
  const seed = world.seedDefaults({ adminName: "T", importDir: new URL("../../../buildings/carbon-cycle", import.meta.url).pathname });
  // a collective with a repo: `{pr}` waits are refused without one (repoMode none)
  world.town.set({ workspace: { path: ".", tools: [], branchPrefix: "agent", base: "main", repoUrl: "https://github.com/mitchellgordon95/agent-town.git" } });
  const agent = world.agents.first("homeBuildingId = ? AND kind = 'resident'", [seed.lab!.id])!;
  const a = world.ops.createWork(world.ops.ensureAvatar(seed.admin.id), agent.id, { title: "Merge #179", waitFor: { pr: 179 } });
  return { world, a };
}

describe("PR checks poller", () => {
  it("githubRepoOf reads https, scp and ssh URLs", () => {
    expect(githubRepoOf("https://github.com/mitchellgordon95/agent-town.git")).toEqual({ owner: "mitchellgordon95", repo: "agent-town" });
    expect(githubRepoOf("git@github.com:mitchellgordon95/agent-town.git")).toEqual({ owner: "mitchellgordon95", repo: "agent-town" });
    expect(githubRepoOf("https://gitlab.com/x/y")).toBeNull();
  });

  it("pending while a suite runs (ignoring apps with no runs); passed when all finish; the wait then clears; finished commits are cached", async () => {
    const { world, a } = worldWithWait();
    const { gh, fetch } = fakeGitHub();
    let t = Date.parse("2026-10-31T20:40:00Z");
    const p = createPrPoller(world, { repoUrl: () => "https://github.com/mitchellgordon95/agent-town.git", token: () => "ghs_x", fetch, now: () => new Date(t) });
    world.host.prChecks = (n) => p.get(n);
    await p.poll();
    expect(p.get(179)).toMatchObject({ state: "pending", sha: SHA, done: 0, total: 1 });
    expect(checkWaits(world).unblocked).toEqual([]);

    // the first job finished but the workflow (suite) has not: a job that `needs` it may not have a run yet
    gh.runs = [{ name: "check", status: "completed", conclusion: "success" }];
    t += 30_000;
    await p.poll();
    expect(gh.calls.length).toBe(3); // throttled: not re-read within a minute
    t += 31_000;
    await p.poll();
    expect(p.get(179)).toMatchObject({ state: "pending", done: 1, total: 1 });

    gh.suites[1] = { status: "completed", conclusion: "success", latest_check_runs_count: 2 };
    gh.runs.push({ name: "promote", status: "completed", conclusion: "skipped" });
    t += 60_000;
    await p.poll();
    expect(p.get(179)).toMatchObject({ state: "passed", done: 2, total: 2 });
    expect(checkWaits(world).unblocked.map((x) => x.id)).toEqual([a.id]);
  });

  it("failed when a check fails; merged or closed PRs release too; no wait = no PR calls", async () => {
    const { world, a } = worldWithWait();
    const { gh, fetch } = fakeGitHub();
    let t = 0;
    const p = createPrPoller(world, { repoUrl: () => "git@github.com:mitchellgordon95/agent-town.git", token: () => null, fetch, now: () => new Date(t += 60_000) });
    gh.suites[1] = { status: "completed", conclusion: "failure", latest_check_runs_count: 1 };
    gh.runs = [{ name: "check", status: "completed", conclusion: "failure" }];
    await p.poll();
    expect(p.get(179)).toMatchObject({ state: "failed", failed: ["check"] });

    gh.pr = { state: "closed", merged: true, mergeable: null, head: { sha: SHA } };
    await p.poll();
    expect(p.get(179)?.state).toBe("merged");

    world.assignments.upsert({ ...a, waitFor: null });
    gh.calls = [];
    await p.poll();
    expect(gh.calls).toEqual([]);
    expect(p.get(179)).toBeUndefined();
  });

  it("a PR that conflicts with its base never gets CI: no suite with runs + mergeable false = failed, not a 24 h hold", async () => {
    const { world, a } = worldWithWait();
    const { gh, fetch } = fakeGitHub();
    let t = 0;
    const p = createPrPoller(world, { repoUrl: () => "https://github.com/mitchellgordon95/agent-town", token: () => null, fetch, now: () => new Date(t += 60_000) });
    world.host.prChecks = (n) => p.get(n);
    gh.suites = [gh.suites[0]];
    gh.runs = [];
    await p.poll();
    expect(p.get(179)?.state).toBe("pending"); // mergeable still being computed
    gh.pr.mergeable = false;
    await p.poll();
    expect(p.get(179)).toMatchObject({ state: "failed", failed: ["merge conflict: CI did not run"] });
    expect(checkWaits(world).unblocked.map((x) => x.id)).toEqual([a.id]);
  });
});

/** A fake GitHub for main (gr_7op2v8fjcl, kr_mvj61meiwx): main's head moves; each sha has its own suites and runs. */
function fakeMain() {
  const gh = {
    head: "aaaa111",
    checks: {} as Record<string, { suites: { status: string; conclusion: string | null; latest_check_runs_count: number }[]; runs: { name: string; status: string; conclusion: string | null }[] }>,
    calls: [] as string[],
  };
  const fetch = (async (url: string) => {
    const path = url.replace("https://api.github.com/repos/mitchellgordon95/agent-town", "");
    gh.calls.push(path);
    const sha = /\/commits\/(\w+)\//.exec(path)?.[1] ?? "";
    const body = path === "/git/ref/heads/main" ? { object: { sha: gh.head } } : path.includes("/check-suites") ? { check_suites: gh.checks[sha]?.suites ?? [] } : path.includes("/check-runs") ? { check_runs: gh.checks[sha]?.runs ?? [] } : null;
    return body ? new Response(JSON.stringify(body)) : new Response("{}", { status: 404 });
  }) as typeof globalThis.fetch;
  const set = (sha: string, run: { name: string; status: string; conclusion: string | null }[]) => {
    const done = run.every((r) => r.status === "completed");
    const bad = run.some((r) => r.status === "completed" && !["success", "skipped", "neutral"].includes(r.conclusion ?? ""));
    gh.checks[sha] = { suites: [{ status: done ? "completed" : "in_progress", conclusion: done ? (bad ? "failure" : "success") : null, latest_check_runs_count: run.length }], runs: run };
  };
  return { gh, fetch, set };
}

describe("main's CI (gr_7op2v8fjcl)", () => {
  const repoUrl = () => "https://github.com/mitchellgordon95/agent-town.git";

  it("main green: every check on main's head passed, read once a minute with a token, a finished sha is not re-read", async () => {
    const world = World.open(":memory:");
    const { gh, fetch, set } = fakeMain();
    set("aaaa111", [{ name: "check", status: "completed", conclusion: "success" }, { name: "promote", status: "completed", conclusion: "success" }]);
    let t = Date.parse("2026-11-04T18:00:00Z");
    const p = createPrPoller(world, { repoUrl, token: () => "ghs_x", fetch, now: () => new Date(t) });
    await p.poll();
    expect(p.main()).toMatchObject({ state: "green", sha: "aaaa111", failedStep: null, since: "2026-11-04T18:00:00.000Z", fixer: null });
    expect(p.lastCalls()).toBe(3); // head ref, check suites, check runs
    gh.calls = [];
    t += 60_000;
    await p.poll();
    expect(gh.calls).toEqual(["/git/ref/heads/main"]); // finished: only the head is re-read
    expect(p.main()).toMatchObject({ state: "green", since: "2026-11-04T18:00:00.000Z", checkedAt: "2026-11-04T18:01:00.000Z" });
  });

  it("main red names the failed step; pending while the fix runs; a restart keeps since", async () => {
    const world = World.open(":memory:");
    const { gh, fetch, set } = fakeMain();
    set("aaaa111", [{ name: "check", status: "completed", conclusion: "failure" }, { name: "promote", status: "completed", conclusion: "skipped" }]);
    let t = Date.parse("2026-11-04T18:00:00Z");
    const deps = { repoUrl, token: () => "ghs_x", fetch, now: () => new Date(t) };
    const p = createPrPoller(world, deps);
    await p.poll();
    expect(p.main()).toMatchObject({ state: "red", sha: "aaaa111", failedStep: "check", since: "2026-11-04T18:00:00.000Z" });

    // a restart: a new poller on the same world starts from the kept record and keeps `since` while main stays red
    t += 120_000;
    gh.head = "bbbb222";
    set("bbbb222", [{ name: "check", status: "completed", conclusion: "failure" }]);
    const q = createPrPoller(world, deps);
    expect(q.main()).toMatchObject({ state: "red", since: "2026-11-04T18:00:00.000Z" });
    await q.poll();
    expect(q.main()).toMatchObject({ state: "red", sha: "bbbb222", since: "2026-11-04T18:00:00.000Z" });

    gh.head = "cccc333";
    set("cccc333", [{ name: "check", status: "in_progress", conclusion: null }]);
    t += 60_000;
    await q.poll();
    expect(q.main()).toMatchObject({ state: "pending", sha: "cccc333", failedStep: null, since: "2026-11-04T18:03:00.000Z" });
    set("cccc333", [{ name: "check", status: "completed", conclusion: "success" }]);
    t += 60_000;
    await q.poll();
    expect(q.main()).toMatchObject({ state: "green", since: "2026-11-04T18:04:00.000Z" });
    expect(world.town.mainCi()).toMatchObject({ state: "green", sha: "cccc333" });
  });

  it("without a repo token main is read at most every 5 minutes (GitHub allows 60 anonymous calls/h)", async () => {
    const world = World.open(":memory:");
    const { gh, fetch, set } = fakeMain();
    set("aaaa111", [{ name: "check", status: "completed", conclusion: "success" }]);
    let t = 0;
    const p = createPrPoller(world, { repoUrl, token: () => null, fetch, now: () => new Date(t) });
    for (let i = 0; i < 5; i++) { await p.poll(); t += 60_000; }
    expect(gh.calls.filter((c) => c === "/git/ref/heads/main").length).toBe(1);
    await p.poll();
    expect(gh.calls.filter((c) => c === "/git/ref/heads/main").length).toBe(2);
  });
});
