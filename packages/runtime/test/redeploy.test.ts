/** v1.3 redeploy: step order, dirty-tree abort, image branch (idle desks only), single flight, exit via the injected hook. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { townRoleId } from "@muster-town/core";
import { makeRedeployer, type CmdResult, type CommandRunner, type RedeployDeps } from "../src/index.ts";
import { imageTags } from "../src/redeploy.ts";
import { result, setup } from "./helpers.ts";

const ok = (stdout = ""): CmdResult => ({ code: 0, stdout, stderr: "" });

/** A fake runner: records `cmd args`, answers from `answers` (first matching prefix wins), default exit 0. */
function fakeRunner(answers: [string, CmdResult][] = []) {
  const calls: string[] = [];
  const run: CommandRunner = async (cmd, args) => {
    const line = [cmd, ...args].join(" ");
    calls.push(line);
    return answers.find(([p]) => line.startsWith(p))?.[1] ?? ok();
  };
  return { run, calls };
}

const BASE: [string, CmdResult][] = [
  ["git status --porcelain", ok("")],
  ["git rev-parse HEAD", ok("abc123\n")],
  ["git rev-list --count", ok("3\n")],
  ["git diff --name-only", ok("")],
];

function harness(answers: [string, CmdResult][], working: string[] = [], drain: Partial<RedeployDeps> = {}) {
  const { world } = setup(async function* () { yield result(1, 0); });
  const runner = fakeRunner(answers);
  const exit = vi.fn();
  const r = makeRedeployer({ world, repoRoot: "/repo", collective: "climate", image: "muster-town-desk", isWorking: (id) => working.includes(id), run: runner.run, exit, exitDelayMs: 1, drainPollMs: 1, ...drain });
  const texts = () => world.events.recent({ limit: 200 }).filter((e) => (e.payload as { redeploy?: boolean }).redeploy).map((e) => e.text);
  return { world, runner, exit, r, texts };
}

describe("redeploy", () => {
  test("runs the steps in order, skips npm install when the lockfile didn't change, then requests exit 75", async () => {
    const h = harness(BASE);
    expect(h.r.redeploy({ image: false, requestedBy: "Pix" })).toEqual({ started: true });
    expect(h.r.redeploy({ image: false, requestedBy: "Root" })).toEqual({ running: true });
    await h.r.done();
    expect(h.runner.calls).toEqual([
      "git status --porcelain",
      "git rev-parse HEAD",
      "git pull --rebase origin main",
      "git rev-list --count abc123..HEAD",
      "git diff --name-only abc123 HEAD -- package-lock.json",
      "npm run build --workspace @muster-town/web",
    ]);
    expect(h.texts()).toEqual(expect.arrayContaining([
      "Redeploy requested by Pix",
      "Redeploy: git pull --rebase origin main … ok (3 commits)",
      "Redeploy: npm install … skipped (package-lock.json unchanged)",
      "Redeploy: build web … ok",
      "Redeploy: restarting server",
    ]));
    expect(h.exit).toHaveBeenCalledWith(75);
    expect(h.r.running()).toBe(false);
  });

  test("reinstalls when package-lock.json changed in the pull", async () => {
    const h = harness([["git diff --name-only", ok("package-lock.json\n")], ...BASE]);
    h.r.redeploy({ image: false, requestedBy: "Pix" });
    await h.r.done();
    const i = h.runner.calls.indexOf("npm install --no-audit --no-fund");
    expect(i).toBeGreaterThan(h.runner.calls.indexOf("git pull --rebase origin main"));
    expect(i).toBeLessThan(h.runner.calls.indexOf("npm run build --workspace @muster-town/web"));
  });

  test("a dirty working tree aborts before pulling; no exit", async () => {
    const h = harness([["git status --porcelain", ok(" M packages/web/src/app.tsx\n")], ...BASE]);
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
    const h = harness([["npm run build", { code: 2, stdout: "", stderr: "vite: error" }], ...BASE]);
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
    const h = harness([psNew, psOld, ...BASE], ["ag_2"]);
    h.r.redeploy({ image: true, requestedBy: "Pix" });
    await h.r.done();
    const docker = h.runner.calls.filter((c) => c.startsWith("docker"));
    const build = "docker build -t muster-town-desk -t agent-town-desk -f packages/desk/Dockerfile .";
    expect(docker[0]).toBe(build);
    expect(docker[1]).toBe('docker ps -a --filter label=muster-town.collective=climate --filter label=muster-town.desk=1 --format {{.Names}}\t{{.Label "muster-town.agent"}}');
    expect(docker[2]).toBe('docker ps -a --filter label=agent-town.collective=climate --filter label=agent-town.desk=1 --format {{.Names}}\t{{.Label "agent-town.agent"}}');
    expect(docker.slice(3)).toEqual(["docker rm -f desk-climate-ag_3", "docker rm -f desk-climate-ag_1"]);
    expect(docker.some((c) => c.includes("volume"))).toBe(false);
    expect(h.runner.calls.indexOf(build)).toBeGreaterThan(h.runner.calls.indexOf("npm run build --workspace @muster-town/web"));
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
    const h = harness(BASE, [], { working: () => live, hold: (on) => holds.push(on), drainTimeoutMs: 60_000 });
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
    const h = harness(BASE, [], { working: () => ["ag_9"], drainTimeoutMs: 20 });
    h.r.redeploy({ image: false, requestedBy: "Pix" });
    await h.r.done();
    expect(h.texts()).toContain("Redeploy: drain timed out, restarting anyway; still running (stopped and re-queued at startup): ag_9");
    expect(h.exit).toHaveBeenCalledWith(75);
  });

  test("drain: image=true recreates desks after the drain, so no desk is kept for a session", async () => {
    let live = ["ag_2"];
    const ps: [string, CmdResult] = ["docker ps -a", ok("desk-climate-ag_1\tag_1\ndesk-climate-ag_2\tag_2\n")];
    const h = harness([ps, ...BASE], [], { working: () => live, drainTimeoutMs: 60_000 });
    h.r.redeploy({ image: true, requestedBy: "Pix" });
    await vi.waitFor(() => expect(h.texts().some((t) => t.startsWith("Redeploy: draining"))).toBe(true));
    expect(h.runner.calls.some((c) => c.startsWith("docker ps"))).toBe(false);
    live = [];
    await h.r.done();
    expect(h.runner.calls.filter((c) => c.startsWith("docker rm"))).toEqual(["docker rm -f desk-climate-ag_1", "docker rm -f desk-climate-ag_2"]);
  });

  test("drain: the hold is released when the redeploy doesn't exit", async () => {
    const holds: boolean[] = [];
    const h = harness(BASE, [], { working: () => [], hold: (on) => holds.push(on), exit: () => undefined });
    h.r.redeploy({ image: false, requestedBy: "Pix" });
    await h.r.done();
    expect(holds).toEqual([true, false]);
  });

  test("startRuntime registers the host hook; the verb needs town.redeploy (deployer role)", async () => {
    const runner = fakeRunner(BASE);
    const exit = vi.fn();
    const { world, runtime, by } = setup(async function* () { yield result(1, 0); }, { redeploy: { run: runner.run, exit, exitDelayMs: 1 }, repoRoot: "/repo" });
    const noor = by("Noor");
    await expect(world.verbs.redeploy(noor.id, {})).rejects.toThrow(/town\.redeploy/);
    world.permissions.grant(noor, townRoleId("deployer"));
    expect(await world.verbs.redeploy(noor.id, {})).toEqual({ started: true });
    expect(runtime.redeploy({ image: false, requestedBy: "x" })).toEqual({ running: true });
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
    const h = harness(BASE, [], { working: () => live, blocked: () => ["ag_7"], drainTimeoutMs: 60_000 });
    h.r.redeploy({ image: false, requestedBy: "Pix" });
    await vi.waitFor(() => expect(runs(h.world).some((r) => r!.state === "scheduled")).toBe(true));
    expect(runs(h.world).find((r) => r!.state === "scheduled")).toMatchObject({ commits: 3, working: ["ag_1"], blocked: ["ag_7"] });
    live = [];
    await h.r.done();
    expect(runs(h.world).at(-1)).toMatchObject({ state: "restarting", commits: 3, blocked: [] });
  });

  test("a failed step marks the run failed", async () => {
    const h = harness([["npm run build", { code: 2, stdout: "", stderr: "x" }], ...BASE]);
    h.r.redeploy({ image: false, requestedBy: "Pix" });
    await h.r.done();
    expect(runs(h.world).at(-1)!.state).toBe("failed");
  });

  test("the restarted server announces the redeploy finished, once", async () => {
    const root = mkdtempSync(join(tmpdir(), "redeploy-"));
    const h = harness(BASE, [], { repoRoot: root });
    h.r.redeploy({ image: false, requestedBy: "Pix" });
    await h.r.done();
    const mk = () => makeRedeployer({ world: h.world, repoRoot: root, collective: "climate", image: "x", isWorking: () => false, run: h.runner.run, exit: vi.fn() });
    mk();
    expect(h.texts().at(-1)).toBe("Redeploy finished: the server is back up with 3 new changes");
    expect(runs(h.world).at(-1)).toMatchObject({ state: "done", commits: 3 });
    mk();
    expect(h.texts().filter((t) => t.startsWith("Redeploy finished"))).toHaveLength(1);
  });
});
