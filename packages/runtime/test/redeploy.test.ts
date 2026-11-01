/** v1.3 redeploy: step order, dirty-tree abort, image branch (idle desks only), single flight, exit via the injected hook. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { townRoleId } from "@muster-town/core";
import { makeRedeployer, type CmdResult, type CommandRunner, type RedeployDeps } from "../src/index.ts";
import { drainNudge, drainNudgeManage, imageTags } from "../src/redeploy.ts";
import { result, setup } from "./helpers.ts";

const ok = (stdout = ""): CmdResult => ({ code: 0, stdout, stderr: "" });

/** A fake runner: records `cmd args`, answers from `answers` (first matching prefix wins), default exit 0. */
function fakeRunner(answers: [string, CmdResult | (() => CmdResult)][] = []) {
  const calls: string[] = [];
  const run: CommandRunner = async (cmd, args) => {
    const line = [cmd, ...args].join(" ");
    calls.push(line);
    const a = answers.find(([p]) => line.startsWith(p))?.[1] ?? ok();
    return typeof a === "function" ? a() : a;
  };
  return { run, calls };
}

/** a clean tree at abc123; the first pull brings 3 commits, any later one (`more`) the next counts in turn (default none) */
function base(more: number[] = []): [string, CmdResult | (() => CmdResult)][] {
  const counts = [3, ...more];
  return [
    ["git status --porcelain", ok("")],
    ["git rev-parse HEAD", ok("abc123\n")],
    ["git rev-list --count", () => ok(`${counts.shift() ?? 0}\n`)],
    ["git diff --name-only", ok("")],
  ];
}

function harness(answers: [string, CmdResult | (() => CmdResult)][], working: string[] = [], drain: Partial<RedeployDeps> = {}) {
  const { world } = setup(async function* () { yield result(1, 0); });
  const runner = fakeRunner(answers);
  const exit = vi.fn();
  const r = makeRedeployer({ world, repoRoot: "/repo", collective: "climate", image: "muster-town-desk", isWorking: (id) => working.includes(id), run: runner.run, exit, exitDelayMs: 1, drainPollMs: 1, ...drain });
  const texts = () => world.events.recent({ limit: 200 }).filter((e) => (e.payload as { redeploy?: boolean }).redeploy).map((e) => e.text);
  return { world, runner, exit, r, texts };
}

describe("redeploy", () => {
  test("on a sandbox-desk host (no docker) an image request is noted and skipped; the rest runs", async () => {
    const h = harness(base(), [], { imageBuild: false });
    h.r.redeploy({ image: true, requestedBy: "Pix" });
    await h.r.done();
    expect(h.runner.calls.some((c) => c.startsWith("docker"))).toBe(false);
    expect(h.texts()).toContain("Redeploy: desk image … skipped (this host runs sandbox desks and has no desk-app deploy token, FLY_DESKS_ACCESS_TOKEN, in its env or Town Hall → Secrets; push it from outside, see fly.desk.toml)");
    expect(h.exit).toHaveBeenCalledWith(75);
  });

  test("on a sandbox-desk host with a deploy token the image is pushed (token in the env, not the argv) and idle desks recreated", async () => {
    const { world } = setup(async function* () { yield result(1, 0); });
    const seen: [string, Record<string, string> | undefined][] = [];
    const run: CommandRunner = async (cmd, args, opts) => {
      seen.push([[cmd, ...args].join(" "), opts.env]);
      return ok(cmd === "git" && args[0] === "rev-parse" ? "abc\n" : cmd === "git" && args[0] === "rev-list" ? "0\n" : "");
    };
    const recreateDesks = vi.fn(async () => ({ removed: ["desk-a"], kept: [] }));
    const exit = vi.fn();
    const r = makeRedeployer({ world, repoRoot: "/repo", collective: "c", image: "x", imageBuild: false, isWorking: () => false, run, exit, exitDelayMs: 1,
      imagePushEnv: () => ({ FLY_ACCESS_TOKEN: "tok" }), recreateDesks });
    r.redeploy({ image: true, requestedBy: "Root" });
    await r.done();
    const push = seen.filter(([c]) => c === "bash scripts/fly-desk-image.sh");
    expect(push).toHaveLength(1);
    expect(push[0]![1]).toEqual({ FLY_ACCESS_TOKEN: "tok" });
    expect(seen.some(([c]) => c.includes("tok"))).toBe(false);
    expect(recreateDesks).toHaveBeenCalledTimes(1);
    const texts = world.events.recent({ limit: 200 }).map((e) => e.text);
    expect(texts).toContain("Redeploy: push desk image … ok");
    expect(texts).toContain("Redeploy: removed the desk Machines of 1 idle resident(s), home volumes kept; each is recreated from the new image on next use");
    expect(exit).toHaveBeenCalledWith(75);
  });

  test("a failed desk image push doesn't stop the code deploy, and the desks are left alone", async () => {
    const recreateDesks = vi.fn(async () => ({ removed: [], kept: [] }));
    const h = harness([...base(), ["bash scripts/fly-desk-image.sh", { code: 1, stdout: "", stderr: "builder down" }]], [],
      { imageBuild: false, imagePushEnv: () => ({ FLY_ACCESS_TOKEN: "tok" }), recreateDesks });
    h.r.redeploy({ image: true, requestedBy: "Root" });
    await h.r.done();
    expect(h.texts()).toContain("Redeploy: push desk image … failed (exit 1); the desks keep their image");
    expect(recreateDesks).not.toHaveBeenCalled();
    expect(h.exit).toHaveBeenCalledWith(75);
  });

  test("git commands run with the repo token env from gitEnv; npm doesn't see it", async () => {
    const { world } = setup(async function* () { yield result(1, 0); });
    const seen: [string, Record<string, string> | undefined][] = [];
    const run: CommandRunner = async (cmd, args, opts) => {
      seen.push([[cmd, ...args].join(" "), opts.env]);
      return ok(cmd === "git" && args[0] === "rev-parse" ? "abc\n" : cmd === "git" && args[0] === "rev-list" ? "0\n" : "");
    };
    const r = makeRedeployer({ world, repoRoot: "/repo", collective: "c", image: "x", isWorking: () => false, run, exit: vi.fn(), exitDelayMs: 1, drainPollMs: 1, gitEnv: () => ({ GH_TOKEN: "tok" }) });
    r.redeploy({ image: false, requestedBy: "Pix" });
    await r.done();
    const pulls = seen.filter(([c]) => c.startsWith("git pull"));
    expect(pulls.length).toBe(2);
    expect(pulls.every(([, e]) => e?.GH_TOKEN === "tok")).toBe(true);
    expect(seen.find(([c]) => c.startsWith("npm"))?.[1]).toBeUndefined();
  });

  test("runs the steps in order, skips npm install when the lockfile didn't change, then requests exit 75", async () => {
    const h = harness(base());
    expect(h.r.redeploy({ image: false, requestedBy: "Pix" })).toEqual({ started: true });
    expect(h.r.redeploy({ image: false, requestedBy: "Root" })).toEqual({ queued: true });
    await h.r.done();
    expect(h.runner.calls).toEqual([
      "git status --porcelain",
      "git rev-parse HEAD",
      "git pull --rebase origin main",
      "git rev-list --count abc123..HEAD",
      "git diff --name-only abc123 HEAD -- package-lock.json",
      "npm run build --workspace packages/web",
      "npm run build --workspace packages/server",
      // pulls again after the drain: nothing new, so no rebuild
      "git rev-parse HEAD",
      "git pull --rebase origin main",
      "git rev-list --count abc123..HEAD",
      "git diff --name-only abc123 HEAD -- package-lock.json",
      "git rev-parse HEAD",
    ]);
    expect(h.texts()).toEqual(expect.arrayContaining([
      "Redeploy requested by Pix",
      "Redeploy: git pull --rebase origin main … ok (3 commits)",
      "Redeploy: npm install … skipped (package-lock.json unchanged)",
      "Redeploy: build web … ok",
      "Redeploy: build server … ok",
      "Redeploy: restarting server",
    ]));
    expect(h.exit).toHaveBeenCalledWith(75);
    expect(h.r.running()).toBe(false);
  });

  test("pulls the configured deploy branch (prod follows a CI-moved `prod` branch)", async () => {
    const h = harness(base(), [], { branch: "prod" });
    h.r.redeploy({ image: false, requestedBy: "Pix" });
    await h.r.done();
    expect(h.runner.calls.filter((c) => c.startsWith("git pull"))).toEqual(["git pull --rebase origin prod", "git pull --rebase origin prod"]);
    expect(h.texts()).toContain("Redeploy: git pull --rebase origin prod … ok (3 commits)");
    expect(h.exit).toHaveBeenCalledWith(75);
  });

  test("reinstalls when package-lock.json changed in the pull", async () => {
    const h = harness([["git diff --name-only", ok("package-lock.json\n")], ...base()]);
    h.r.redeploy({ image: false, requestedBy: "Pix" });
    await h.r.done();
    const i = h.runner.calls.indexOf("npm install --include=dev --no-audit --no-fund");
    expect(i).toBeGreaterThan(h.runner.calls.indexOf("git pull --rebase origin main"));
    expect(i).toBeLessThan(h.runner.calls.indexOf("npm run build --workspace packages/web"));
  });

  test("a dirty working tree aborts before pulling; no exit", async () => {
    const h = harness([["git status --porcelain", ok(" M packages/web/src/app.tsx\n")], ...base()]);
    h.r.redeploy({ image: true, requestedBy: "Pix" });
    await h.r.done();
    expect(h.runner.calls).toEqual(["git status --porcelain"]);
    expect(h.texts()).toContain("Redeploy: aborted, the working tree is dirty");
    expect(h.exit).not.toHaveBeenCalled();
    // the flight is released: a new request starts
    expect(h.r.redeploy({ image: false, requestedBy: "Pix" })).toEqual({ started: true });
    await h.r.done();
  });

  test("a failing step stops the redeploy without restarting", async () => {
    const h = harness([["npm run build", { code: 2, stdout: "", stderr: "vite: error" }], ...base()]);
    h.r.redeploy({ image: true, requestedBy: "Pix" });
    await h.r.done();
    expect(h.texts()).toContain("Redeploy: build web … failed (exit 2)");
    expect(h.runner.calls.some((c) => c.startsWith("docker"))).toBe(false);
    expect(h.exit).not.toHaveBeenCalled();
  });

  test("image=true builds the desk image (both tags) and removes only idle desk containers, old and new labels (volumes kept)", async () => {
    // desks from before the rename carry agent-town.* labels; ag_1 shows up under both to check de-duplication
    const psNew: [string, CmdResult] = ["docker ps -a --filter label=muster-town.", ok("desk-climate-ag_3\tag_3\ndesk-climate-ag_1\tag_1\n")];
    const psOld: [string, CmdResult] = ["docker ps -a --filter label=agent-town.", ok("desk-climate-ag_1\tag_1\ndesk-climate-ag_2\tag_2\n")];
    const h = harness([psNew, psOld, ...base()], ["ag_2"]);
    h.r.redeploy({ image: true, requestedBy: "Pix" });
    await h.r.done();
    const docker = h.runner.calls.filter((c) => c.startsWith("docker"));
    const build = "docker build -t muster-town-desk -t agent-town-desk -f packages/desk/Dockerfile .";
    expect(docker[0]).toBe(build);
    expect(docker[1]).toBe('docker ps -a --filter label=muster-town.collective=climate --filter label=muster-town.desk=1 --format {{.Names}}\t{{.Label "muster-town.agent"}}');
    expect(docker[2]).toBe('docker ps -a --filter label=agent-town.collective=climate --filter label=agent-town.desk=1 --format {{.Names}}\t{{.Label "agent-town.agent"}}');
    expect(docker.slice(3)).toEqual(["docker rm -f desk-climate-ag_3", "docker rm -f desk-climate-ag_1"]);
    expect(docker.some((c) => c.includes("volume"))).toBe(false);
    expect(h.runner.calls.indexOf(build)).toBeGreaterThan(h.runner.calls.indexOf("npm run build --workspace packages/web"));
    expect(h.exit).toHaveBeenCalledWith(75);
  });

  test("imageTags: the default image is tagged under both names; a custom image only under its own", () => {
    expect(imageTags("muster-town-desk")).toEqual(["muster-town-desk", "agent-town-desk"]);
    expect(imageTags("agent-town-desk")).toEqual(["agent-town-desk", "muster-town-desk"]);
    expect(imageTags("my-desk")).toEqual(["my-desk"]);
  });

  test("drain: holds new sessions and waits for running ones to end before restarting", async () => {
    let live = ["ag_1", "ag_2"];
    const holds: boolean[] = [];
    const h = harness(base(), [], { working: () => live, hold: (on) => holds.push(on), drainTimeoutMs: 60_000 });
    h.r.redeploy({ image: false, requestedBy: "Pix" });
    await vi.waitFor(() => expect(h.texts().some((t) => t.startsWith("Redeploy: draining, waiting for 2 session(s)"))).toBe(true));
    expect(holds).toEqual([true]);
    expect(h.exit).not.toHaveBeenCalled();
    live = ["ag_2"];
    await new Promise((r) => setTimeout(r, 10));
    expect(h.exit).not.toHaveBeenCalled();
    live = [];
    await h.r.done();
    expect(h.texts()).toContain("Redeploy: drain … ok (no sessions running)");
    expect(h.exit).toHaveBeenCalledWith(75);
  });

  test("drain: restarts anyway after the timeout, naming the sessions left running", async () => {
    const h = harness(base(), [], { working: () => ["ag_9"], drainTimeoutMs: 20 });
    h.r.redeploy({ image: false, requestedBy: "Pix" });
    await h.r.done();
    expect(h.texts()).toContain("Redeploy: drain timed out, restarting anyway; still running (stopped and re-queued at startup): ag_9");
    expect(h.exit).toHaveBeenCalledWith(75);
  });

  test("drain: a team-lead session gets drainManageMs (and the wrap-up nudge); other sessions only drainTimeoutMs", async () => {
    let live = ["ag_lead", "ag_9"];
    const nudges: [string, string][] = [];
    const h = harness(base(), [], { working: () => live, isManage: (id) => id === "ag_lead", nudge: (id, t) => nudges.push([id, t]), drainTimeoutMs: 20, drainManageMs: 60_000 });
    h.r.redeploy({ image: false, requestedBy: "Pix" });
    await vi.waitFor(() => expect(h.texts().some((t) => t.startsWith("Redeploy: not waiting longer for ag_9; still waiting for team-lead session(s): ag_lead"))).toBe(true));
    expect(h.texts().some((t) => t.startsWith("Redeploy: draining, waiting for 2 session(s) to end: ag_lead, ag_9 (up to 1 min)"))).toBe(true);
    expect(nudges).toEqual([["ag_lead", drainNudgeManage()], ["ag_9", drainNudge(false)]]);
    expect(drainNudgeManage()).toContain("finish the step you are on, write your pages");
    // past drainTimeoutMs the team-lead session still holds the restart
    await new Promise((r) => setTimeout(r, 40));
    expect(h.exit).not.toHaveBeenCalled();
    live = ["ag_9"]; // it ended; ag_9 (cut already) doesn't hold the restart again
    await h.r.done();
    expect(h.texts()).toContain("Redeploy: drain timed out, restarting anyway; still running (stopped and re-queued at startup): ag_9");
    expect(h.exit).toHaveBeenCalledWith(75);
  });

  test("drain: a team-lead session still running at drainManageMs is cut by the restart (it resumes after it)", async () => {
    const h = harness(base(), [], { working: () => ["ag_lead"], isManage: () => true, drainTimeoutMs: 5, drainManageMs: 30 });
    const t0 = Date.now();
    h.r.redeploy({ image: false, requestedBy: "Pix" });
    await h.r.done();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    expect(h.texts()).toContain("Redeploy: drain timed out, restarting anyway; still running (stopped and re-queued at startup): ag_lead");
    expect(h.exit).toHaveBeenCalledWith(75);
  });

  test("stop() ends an in-flight drain without exiting and writes no event after it", async () => {
    const holds: boolean[] = [];
    const h = harness(base(), [], { working: () => ["ag_9"], hold: (on) => holds.push(on), drainTimeoutMs: 60_000 });
    h.r.redeploy({ image: false, requestedBy: "Pix" });
    await vi.waitFor(() => expect(h.texts().some((t) => t.startsWith("Redeploy: draining"))).toBe(true));
    const before = h.texts().length;
    await h.r.stop();
    expect(h.r.running()).toBe(false);
    expect(h.exit).not.toHaveBeenCalled();
    expect(h.texts()).toHaveLength(before);
    expect(holds).toEqual([true]);
    expect(h.r.redeploy({ image: false, requestedBy: "Pix" })).toEqual({ started: false });
  });

  test("runtime.stop() resolves only after an in-flight redeploy step has finished, and nothing touches the world after it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const inner = fakeRunner(base());
    const run: CommandRunner = async (cmd, args, opts) => { if (args[0] === "pull") await gate; return inner.run(cmd, args, opts); };
    const exit = vi.fn();
    const { world, runtime } = setup(async function* () { yield result(1, 0); }, { redeploy: { run, exit, exitDelayMs: 1, drainPollMs: 1 }, repoRoot: "/repo" });
    expect(runtime.redeploy({ image: false, requestedBy: "Pix" })).toEqual({ started: true });
    await vi.waitFor(() => expect(world.events.recent({ limit: 50 }).some((e) => e.text.startsWith("Redeploy: git pull"))).toBe(true));
    let stopped = false;
    const stopping = runtime.stop().then(() => { stopped = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(stopped).toBe(false);
    const before = world.events.recent({ limit: 500 }).length;
    release();
    await stopping;
    expect(world.events.recent({ limit: 500 })).toHaveLength(before);
    expect(exit).not.toHaveBeenCalled();
  });

  test("drain: image=true recreates desks after the drain, so no desk is kept for a session", async () => {
    let live = ["ag_2"];
    const ps: [string, CmdResult] = ["docker ps -a", ok("desk-climate-ag_1\tag_1\ndesk-climate-ag_2\tag_2\n")];
    const h = harness([ps, ...base()], [], { working: () => live, drainTimeoutMs: 60_000 });
    h.r.redeploy({ image: true, requestedBy: "Pix" });
    await vi.waitFor(() => expect(h.texts().some((t) => t.startsWith("Redeploy: draining"))).toBe(true));
    expect(h.runner.calls.some((c) => c.startsWith("docker ps"))).toBe(false);
    live = [];
    await h.r.done();
    expect(h.runner.calls.filter((c) => c.startsWith("docker rm"))).toEqual(["docker rm -f desk-climate-ag_1", "docker rm -f desk-climate-ag_2"]);
  });

  test("drain: the hold is released when the redeploy doesn't exit", async () => {
    const holds: boolean[] = [];
    const h = harness(base(), [], { working: () => [], hold: (on) => holds.push(on), exit: () => undefined });
    h.r.redeploy({ image: false, requestedBy: "Pix" });
    await h.r.done();
    expect(holds).toEqual([true, false]);
  });

  test("startRuntime registers the host hook; the verb needs town.redeploy (deployer role)", async () => {
    const runner = fakeRunner(base());
    const exit = vi.fn();
    const { world, runtime, by } = setup(async function* () { yield result(1, 0); }, { redeploy: { run: runner.run, exit, exitDelayMs: 1 }, repoRoot: "/repo" });
    const noor = by("Noor");
    await expect(world.verbs.redeploy(noor.id, {})).rejects.toThrow(/town\.redeploy/);
    world.permissions.grant(noor, townRoleId("deployer"));
    expect(await world.verbs.redeploy(noor.id, {})).toEqual({ started: true });
    expect(runtime.redeploy({ image: false, requestedBy: "x" })).toEqual({ queued: true });
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(75));
    await runtime.stop();
    expect(world.host.redeploy).toBeUndefined();
  });
});

describe("redeploy status for the UI", () => {
  const runs = (world: ReturnType<typeof setup>["world"]) => world.events.recent({ limit: 200 })
    .map((e) => (e.payload as { run?: { state: string; commits: number | null; working: string[]; blocked: string[] } }).run).filter(Boolean);

  test("every event carries the run: scheduled while draining (commits pulled, sessions waited on, agents held), then restarting", async () => {
    let live = ["ag_1"];
    const h = harness(base(), [], { working: () => live, blocked: () => ["ag_7"], drainTimeoutMs: 60_000 });
    h.r.redeploy({ image: false, requestedBy: "Pix" });
    await vi.waitFor(() => expect(runs(h.world).some((r) => r!.state === "scheduled")).toBe(true));
    expect(runs(h.world).find((r) => r!.state === "scheduled")).toMatchObject({ commits: 3, working: ["ag_1"], blocked: ["ag_7"] });
    live = [];
    await h.r.done();
    expect(runs(h.world).at(-1)).toMatchObject({ state: "restarting", commits: 3, blocked: [] });
  });

  test("pull again after the drain: commits pushed while draining are built and shipped", async () => {
    let live = ["ag_1"];
    const h = harness(base([2]), [], { working: () => live, drainTimeoutMs: 60_000 });
    h.r.redeploy({ image: false, requestedBy: "Pix" });
    await vi.waitFor(() => expect(h.texts().some((t) => t.startsWith("Redeploy: draining"))).toBe(true));
    // a request during the drain joins this run instead of being refused
    expect(h.r.redeploy({ image: false, requestedBy: "Root" })).toEqual({ queued: true });
    live = [];
    await h.r.done();
    expect(h.texts()).toEqual(expect.arrayContaining([
      "Redeploy: Root's request joins the running one",
      "Redeploy: pull again after the drain … ok (2 more commits)",
      "Redeploy: build web (again) … ok",
    ]));
    expect(h.runner.calls.filter((c) => c === "git pull --rebase origin main")).toHaveLength(2);
    expect(runs(h.world).at(-1)).toMatchObject({ state: "restarting", commits: 5 });
    expect(h.exit).toHaveBeenCalledWith(75);
  });

  test("pull again: a joining image request builds the image after the drain; a failed pull keeps the preflight build", async () => {
    let live = ["ag_1"];
    const h = harness([["git pull --rebase origin main", ok()], ...base()], [], { working: () => live, drainTimeoutMs: 60_000 });
    h.r.redeploy({ image: false, requestedBy: "Pix" });
    await vi.waitFor(() => expect(h.texts().some((t) => t.startsWith("Redeploy: draining"))).toBe(true));
    h.r.redeploy({ image: true, requestedBy: "Root" });
    live = [];
    await h.r.done();
    expect(h.texts()).toContain("Redeploy: docker build desk image (again) … ok");

    let calls = 0;
    const f = harness([["git pull --rebase origin main", () => (++calls === 1 ? ok() : { code: 1, stdout: "", stderr: "network" })], ...base()]);
    f.r.redeploy({ image: false, requestedBy: "Pix" });
    await f.r.done();
    expect(f.texts()).toContain("Redeploy: pull again after the drain … failed (exit 1); restarting with what was pulled before");
    expect(f.exit).toHaveBeenCalledWith(75);
  });

  test("a request after the final pull is carried in the done-file and runs once the server is back", async () => {
    const h = harness(base());
    // Lena asks right as the post-drain pull runs: too late for it to take her commits
    const root2 = mkdtempSync(join(tmpdir(), "redeploy-"));
    let joined = false;
    const runner = fakeRunner(base());
    const run: CommandRunner = async (cmd, args, o) => {
      const r = await runner.run(cmd, args, o);
      if (!joined && runner.calls.filter((c) => c === "git pull --rebase origin main").length === 2) { joined = true; g.redeploy({ image: true, requestedBy: "Lena" }); }
      return r;
    };
    const g = makeRedeployer({ world: h.world, repoRoot: root2, collective: "climate", image: "x", isWorking: () => false, run, exit: vi.fn(), exitDelayMs: 1 });
    g.redeploy({ image: false, requestedBy: "Pix" });
    await g.done();
    expect(h.texts()).toContain("Redeploy: Lena's request will run again after this restart");
    const runner2 = fakeRunner(base());
    const next = makeRedeployer({ world: h.world, repoRoot: root2, collective: "climate", image: "x", isWorking: () => false, run: runner2.run, exit: vi.fn(), exitDelayMs: 1, againDelayMs: 1 });
    await vi.waitFor(() => expect(h.texts()).toContain("Redeploy requested by Lena (with the desk image)"));
    await next.done();
  });

  test("a failed step marks the run failed", async () => {
    const h = harness([["npm run build", { code: 2, stdout: "", stderr: "x" }], ...base()]);
    h.r.redeploy({ image: false, requestedBy: "Pix" });
    await h.r.done();
    expect(runs(h.world).at(-1)!.state).toBe("failed");
  });

  test("the restarted server announces the redeploy finished, once", async () => {
    const root = mkdtempSync(join(tmpdir(), "redeploy-"));
    const h = harness(base(), [], { repoRoot: root });
    h.r.redeploy({ image: false, requestedBy: "Pix" });
    await h.r.done();
    const mk = () => makeRedeployer({ world: h.world, repoRoot: root, collective: "climate", image: "x", isWorking: () => false, run: h.runner.run, exit: vi.fn() });
    mk();
    expect(h.texts().at(-1)).toBe("Redeploy finished: the server is back up with 3 new changes at abc123");
    expect(runs(h.world).at(-1)).toMatchObject({ state: "done", commits: 3, head: "abc123" });
    mk();
    expect(h.texts().filter((t) => t.startsWith("Redeploy finished"))).toHaveLength(1);
  });
});
