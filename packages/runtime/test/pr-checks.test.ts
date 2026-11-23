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
    /** `/commits/<sha>` and `/commits/<sha>/pulls` answers (who wrote a red commit) */
    commits: {} as Record<string, unknown>,
  };
  const fetch = (async (url: string) => {
    const path = url.replace("https://api.github.com/repos/mitchellgordon95/agent-town", "");
    gh.calls.push(path);
    const sha = /\/commits\/(\w+)\//.exec(path)?.[1] ?? "";
    const body = path === "/git/ref/heads/main" ? { object: { sha: gh.head } } : gh.commits[path] ? gh.commits[path] : path.includes("/check-suites") ? { check_suites: gh.checks[sha]?.suites ?? [] } : path.includes("/check-runs") ? { check_runs: gh.checks[sha]?.runs ?? [] } : null;
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

  it("a failed or cancelled deploy job (promote, image) after a passed check is not red: no fixer, nothing queued (as_dh0rv1hv0f)", async () => {
    const world = World.open(":memory:");
    const { gh, fetch, set } = fakeMain();
    set("aaaa111", [{ name: "check", status: "completed", conclusion: "success" }, { name: "promote", status: "completed", conclusion: "failure" }, { name: "image", status: "completed", conclusion: "cancelled" }]);
    let t = Date.parse("2026-11-04T18:00:00Z");
    const p = createPrPoller(world, { repoUrl, token: () => "ghs_x", fetch, now: () => new Date(t) });
    await p.poll();
    expect(p.main()).toMatchObject({ state: "green", sha: "aaaa111", failedStep: null, fixer: null });
    expect(world.assignments.where("createdBy = 'main-ci'")).toHaveLength(0);
    expect(world.town.mainCi()?.state).not.toBe("red"); // mainRedLine (core main-fix.ts) is null unless red
    // a code check failing next to a failed deploy job is red, and names only the code check
    gh.head = "bbbb222";
    set("bbbb222", [{ name: "check", status: "completed", conclusion: "failure" }, { name: "promote", status: "completed", conclusion: "failure" }]);
    t += 60_000;
    await p.poll();
    expect(p.main()).toMatchObject({ state: "red", failedStep: "check" });
  });

  it("a busy main stays pending (running, or its run cancelled by the next push): never red, no fixer, nothing queued (as_dh0rv1hv0f)", async () => {
    const world = World.open(":memory:");
    const { gh, fetch, set } = fakeMain();
    let t = Date.parse("2026-11-04T18:00:00Z");
    const p = createPrPoller(world, { repoUrl, token: () => "ghs_x", fetch, now: () => new Date(t) });
    // five merges in a row, each read while running and then read again after the next push cancelled it
    for (const sha of ["aaaa111", "bbbb222", "cccc333", "dddd444", "eeee555"]) {
      gh.head = sha;
      set(sha, [{ name: "check", status: "in_progress", conclusion: null }]);
      await p.poll(); t += 60_000;
      expect(p.main()).toMatchObject({ state: "pending", sha, fixer: null });
      set(sha, [{ name: "check", status: "completed", conclusion: "cancelled" }, { name: "promote", status: "completed", conclusion: "skipped" }]);
      await p.poll(); t += 60_000;
      expect(p.main()).toMatchObject({ state: "pending", sha, failedStep: null, fixer: null });
      expect(world.town.mainCi()?.state).not.toBe("red"); // mainRedLine (core main-fix.ts) is null unless red
    }
    expect(p.main()!.since).toBe("2026-11-04T18:00:00.000Z"); // one pending stretch, never a red episode
    expect(world.assignments.where("createdBy = 'main-ci'")).toHaveLength(0);
    expect(gh.calls.some((c) => /^\/commits\/\w+$/.test(c))).toBe(false); // no author read: nothing was red
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

  it("a red main queues one fix to the author's building: the author is read once per red sha, a restart doesn't re-queue (step 2)", async () => {
    const world = World.open(":memory:");
    const seed = world.seedDefaults({ adminName: "T", importDir: new URL("../../../buildings/carbon-cycle", import.meta.url).pathname });
    const lab = seed.lab!;
    const mei = world.agents.first("homeBuildingId = ? AND kind = 'resident'", [lab.id])!;
    world.buildings.upsert({ ...world.buildings.require(lab.id), managerAgentId: mei.id });
    const slug = mei.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const { gh, fetch, set } = fakeMain();
    // a squash merge: GitHub authors it as the merger, the PR's branch names the agent
    gh.commits["/commits/aaaa111"] = { commit: { author: { name: "Mitchell Gordon", email: "m@example.com" }, message: "Fix x (#315)" } };
    gh.commits["/commits/aaaa111/pulls"] = [{ number: 315, head: { ref: `agent/${slug}/fix-x` } }];
    set("aaaa111", [{ name: "check", status: "completed", conclusion: "failure" }]);
    let t = Date.parse("2026-11-04T18:00:00Z");
    const deps = { repoUrl, token: () => "ghs_x", fetch, now: () => new Date(t) };
    const p = createPrPoller(world, deps);
    await p.poll();
    const fixes = () => world.assignments.where("createdBy = 'main-ci'");
    expect(fixes()).toHaveLength(1);
    expect(fixes()[0]).toMatchObject({ buildingId: lab.id, queue: "building" });
    expect(fixes()[0].description).toContain("PR #315");
    expect(p.main()).toMatchObject({ state: "red", fixSha: "aaaa111", fixer: mei.id, fixAssignmentId: fixes()[0].id });
    gh.calls = [];
    t += 60_000;
    await p.poll();
    expect(gh.calls).toEqual(["/git/ref/heads/main"]); // red and fixed already: no author read
    const q = createPrPoller(world, deps);
    t += 60_000;
    await q.poll();
    expect(fixes()).toHaveLength(1);

    // the fix's push runs (pending keeps the fixer), then main goes green and the fix fields clear
    gh.head = "bbbb222";
    set("bbbb222", [{ name: "check", status: "in_progress", conclusion: null }]);
    t += 60_000;
    await q.poll();
    expect(q.main()).toMatchObject({ state: "pending", fixAssignmentId: fixes()[0].id });
    set("bbbb222", [{ name: "check", status: "completed", conclusion: "success" }]);
    t += 60_000;
    await q.poll();
    expect(q.main()).toMatchObject({ state: "green", fixer: null, fixSha: null, fixAssignmentId: null });
  });
});

/** Merge when green (gr_rlt0ctnhqk, kr_lse9k08ixi): a fake GitHub that also answers GraphQL, the merge and the branch delete. */
function fakeMergeGitHub() {
  const gh = {
    pr: { state: "open", merged: false, merge_commit_sha: null as string | null, mergeable: true as boolean | null, draft: true, title: "Merge when green", node_id: "PR_node179",
      head: { sha: SHA, ref: "agent/mara-1/merge-when-green", repo: { full_name: "mitchellgordon95/agent-town" } }, base: { ref: "main", repo: { full_name: "mitchellgordon95/agent-town" } } },
    suites: [{ status: "completed", conclusion: "success", latest_check_runs_count: 1 }],
    runs: [{ name: "check", status: "completed", conclusion: "success" }] as { name: string; status: string; conclusion: string | null }[],
    merge: { status: 200, body: { sha: "beefcafe1234567890", merged: true } as unknown, lands: false } as { status: number; body: unknown; lands?: boolean },
    calls: [] as { method: string; path: string; body?: unknown }[],
  };
  const fetch = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/git/ref/heads/main")) return new Response("{}", { status: 404 });
    const method = init?.method ?? "GET";
    const path = url.replace("https://api.github.com/repos/mitchellgordon95/agent-town", "").replace("https://api.github.com", "");
    gh.calls.push({ method, path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (path === "/graphql") { gh.pr.draft = false; return new Response(JSON.stringify({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } })); }
    if (method === "PUT" && path === "/pulls/179/merge") {
      if (gh.merge.status === 200 || gh.merge.lands) Object.assign(gh.pr, { state: "closed", merged: true, merge_commit_sha: "beefcafe1234567890" });
      return new Response(JSON.stringify(gh.merge.body), { status: gh.merge.status });
    }
    if (method === "DELETE") return new Response(null, { status: 204 });
    const body = path === "/pulls/179" ? gh.pr : path.includes("/check-suites") ? { check_suites: gh.suites } : path.includes("/check-runs") ? { check_runs: gh.runs } : null;
    return body ? new Response(JSON.stringify(body)) : new Response("{}", { status: 404 });
  }) as typeof globalThis.fetch;
  return { gh, fetch };
}

function worldWithMergeWait() {
  const world = World.open(":memory:");
  const seed = world.seedDefaults({ adminName: "T", importDir: new URL("../../../buildings/carbon-cycle", import.meta.url).pathname });
  world.town.set({ workspace: { path: ".", tools: [], branchPrefix: "agent", base: "main", repoUrl: "https://github.com/mitchellgordon95/agent-town.git" } });
  const agent = world.agents.first("homeBuildingId = ? AND kind = 'resident'", [seed.lab!.id])!;
  const a = world.ops.createWork(world.ops.ensureAvatar(seed.admin.id), agent.id, { title: "Merge #179", waitFor: { pr: 179, merge: true } });
  return { world, a };
}

describe("merge when green (gr_rlt0ctnhqk)", () => {
  const repoUrl = () => "https://github.com/mitchellgordon95/agent-town.git";
  const setup = () => {
    const { world, a } = worldWithMergeWait();
    const { gh, fetch } = fakeMergeGitHub();
    let t = Date.parse("2026-11-19T15:00:00Z");
    const p = createPrPoller(world, { repoUrl, token: () => "ghs_x", fetch, now: () => new Date(t += 60_000) });
    world.host.prChecks = (n) => p.get(n);
    return { world, a, gh, p };
  };

  it("green and mergeable: marks the draft ready, squash-merges with its title, deletes the branch; the parked work closes as done with no session", async () => {
    const { world, a, gh, p } = setup();
    await p.poll();
    expect(gh.calls.filter((c) => c.method !== "GET")).toEqual([
      { method: "POST", path: "/graphql", body: { query: expect.stringContaining("markPullRequestReadyForReview"), variables: { id: "PR_node179" } } },
      { method: "PUT", path: "/pulls/179/merge", body: { merge_method: "squash", commit_title: "Merge when green (#179)", sha: SHA } },
      { method: "DELETE", path: "/git/refs/heads/agent/mara-1/merge-when-green" },
    ]);
    expect(p.get(179)).toMatchObject({ state: "merged", mergeSha: "beefcafe1234567890", mergedBy: "town" });
    const { merged, unblocked } = checkWaits(world);
    expect(unblocked).toEqual([]);
    expect(merged.map((x) => x.id)).toEqual([a.id]);
    expect(world.assignments.require(a.id).status).toBe("done");
    // a later read (the PR now closed and merged) keeps saying the town merged it, and does not merge again
    await p.poll();
    expect(gh.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  it("red checks: no merge call; the work wakes with the failed check named", async () => {
    const { world, a, gh, p } = setup();
    gh.suites = [{ status: "completed", conclusion: "failure", latest_check_runs_count: 1 }];
    gh.runs = [{ name: "check", status: "completed", conclusion: "failure" }];
    await p.poll();
    expect(gh.calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(checkWaits(world).unblocked.map((x) => x.id)).toEqual([a.id]);
    expect(world.assignments.require(a.id).description).toContain("PR #179 when this resumed: failed (check)");
  });

  it("a conflict: green checks but mergeable false wakes the work with the conflict, no merge; mergeable null waits a poll", async () => {
    const { world, a, gh, p } = setup();
    gh.pr.mergeable = null;
    await p.poll();
    expect(p.get(179)?.state).toBe("pending");
    expect(checkWaits(world).unblocked).toEqual([]);
    gh.pr.mergeable = false;
    await p.poll();
    expect(gh.calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(p.get(179)).toMatchObject({ state: "failed", failed: ["merge conflict with main: merge it into the branch and push"] });
    expect(checkWaits(world).unblocked.map((x) => x.id)).toEqual([a.id]);
  });

  it("a merge GitHub refuses wakes the work with GitHub's reason; main moving under it retries next poll", async () => {
    const { world, a, gh, p } = setup();
    gh.merge = { status: 405, body: { message: "Base branch was modified. Review and try the merge again." } };
    await p.poll();
    expect(p.get(179)?.state).toBe("pending");
    gh.merge = { status: 405, body: { message: "At least 1 approving review is required by reviewers with write access." } };
    await p.poll();
    expect(p.get(179)).toMatchObject({ state: "failed", failed: ["merge refused: HTTP 405: At least 1 approving review is required by reviewers with write access."] });
    expect(checkWaits(world).unblocked.map((x) => x.id)).toEqual([a.id]);
    expect(world.assignments.require(a.id).status).toBe("pending");
  });

  it("a 5xx on an open PR retries next poll with no wake; a 5xx on a merge GitHub made anyway counts as merged", async () => {
    const { world, a, gh, p } = setup();
    gh.merge = { status: 500, body: { message: "Server Error" } };
    await p.poll();
    expect(p.get(179)?.state).toBe("pending");
    expect(checkWaits(world).unblocked).toEqual([]);
    gh.merge = { status: 500, body: { message: "Server Error" }, lands: true };
    await p.poll();
    expect(p.get(179)).toMatchObject({ state: "merged", mergeSha: "beefcafe1234567890", mergedBy: "town" });
    expect(checkWaits(world).merged.map((x) => x.id)).toEqual([a.id]);
    expect(gh.calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
  });

  it("only an agent branch of this repo is merged: a human's branch or a fork's PR wakes the work instead", async () => {
    const { gh, p } = setup();
    gh.pr.head.ref = "mitchell/hotfix";
    await p.poll();
    expect(p.get(179)).toMatchObject({ state: "failed", failed: [expect.stringContaining("not merged by the town: mitchell/hotfix is not an agent/")] });
    expect(gh.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("a plain {pr} wait still only reads: passed releases it, nothing is merged", async () => {
    const { world, a, gh, p } = setup();
    world.assignments.upsert({ ...a, waitFor: { pr: 179 } });
    await p.poll();
    expect(p.get(179)?.state).toBe("passed");
    expect(gh.calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(checkWaits(world).unblocked.map((x) => x.id)).toEqual([a.id]);
  });
});
