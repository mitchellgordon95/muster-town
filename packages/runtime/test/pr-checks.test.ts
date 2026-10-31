/** `{pr}` waits (Mitchell, 1:1 mt_3jtclcoxl2): the runtime reads a parked PR's checks from GitHub and the wait releases when they finish. */
import { describe, expect, it } from "vitest";
import { checkWaits, World } from "@muster-town/core";
import { createPrPoller, githubRepoOf } from "../src/pr-checks.ts";

const SHA = "449b6e5aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/** A fake GitHub: one open PR #179 whose checks the test moves along. */
function fakeGitHub() {
  const gh = {
    pr: { state: "open", merged: false, head: { sha: SHA } },
    // render/vercel-style apps that never report: queued forever with no runs (must be ignored)
    suites: [{ status: "queued", conclusion: null, latest_check_runs_count: 0 }, { status: "in_progress", conclusion: null, latest_check_runs_count: 1 }] as { status: string; conclusion: string | null; latest_check_runs_count: number }[],
    runs: [{ name: "check", status: "in_progress", conclusion: null }] as { name: string; status: string; conclusion: string | null }[],
    calls: [] as string[],
  };
  const fetch = (async (url: string) => {
    gh.calls.push(url.replace("https://api.github.com/repos/mitchellgordon95/agent-town", ""));
    const body = url.endsWith("/pulls/179") ? gh.pr : url.includes("/check-suites") ? { check_suites: gh.suites } : url.includes("/check-runs") ? { check_runs: gh.runs } : null;
    return body ? new Response(JSON.stringify(body)) : new Response("{}", { status: 404 });
  }) as typeof globalThis.fetch;
  return { gh, fetch };
}

function worldWithWait() {
  const world = World.open(":memory:");
  const seed = world.seedDefaults({ adminName: "T", importDir: new URL("../../../buildings/carbon-cycle", import.meta.url).pathname });
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

  it("failed when a check fails; merged or closed PRs release too; no wait = no GitHub calls", async () => {
    const { world, a } = worldWithWait();
    const { gh, fetch } = fakeGitHub();
    let t = 0;
    const p = createPrPoller(world, { repoUrl: () => "git@github.com:mitchellgordon95/agent-town.git", token: () => null, fetch, now: () => new Date(t += 60_000) });
    gh.suites[1] = { status: "completed", conclusion: "failure", latest_check_runs_count: 1 };
    gh.runs = [{ name: "check", status: "completed", conclusion: "failure" }];
    await p.poll();
    expect(p.get(179)).toMatchObject({ state: "failed", failed: ["check"] });

    gh.pr = { state: "closed", merged: true, head: { sha: SHA } };
    await p.poll();
    expect(p.get(179)?.state).toBe("merged");

    world.assignments.upsert({ ...a, waitFor: null });
    gh.calls = [];
    await p.poll();
    expect(gh.calls).toEqual([]);
    expect(p.get(179)).toBeUndefined();
  });
});
