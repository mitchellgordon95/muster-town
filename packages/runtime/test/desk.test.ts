import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Agent, Building } from "@muster-town/schema";
import { deskAuth, DockerBackend, fundingFor, type DeskBackend, type DeskChild, type DeskHandle, type DockerRunner, type RunResult, type SpawnedChild } from "../src/index.ts";
import { killTreeCommand } from "../src/desk/backend.ts";
import { result, setup } from "./helpers.ts";

// ---------- DockerBackend command lines ----------
function fakeRunner(answers: (args: string[]) => RunResult) {
  const calls: { args: string[]; timeoutMs?: number }[] = [];
  const spawned: { args: string[]; env: Record<string, string>; child: SpawnedChild & EventEmitter; out: PassThrough; err: PassThrough; killed: string[] }[] = [];
  const runner: DockerRunner = {
    async run(args, opts) { calls.push({ args, timeoutMs: opts?.timeoutMs }); return answers(args); },
    spawn(args, opts) {
      const out = new PassThrough(), err = new PassThrough(), killed: string[] = [];
      const child = Object.assign(new EventEmitter(), { stdout: out, stderr: err, kill: (sig?: string) => { killed.push(sig ?? "SIGTERM"); return true; } }) as unknown as SpawnedChild & EventEmitter;
      spawned.push({ args, env: opts.env, child, out, err, killed });
      return child;
    },
  };
  return { runner, calls, spawned };
}
const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const agent = { id: "ag_abc123" } as Agent;
const building = { id: "bl_x" } as Building;

describe("DockerBackend", () => {
  test("available() runs docker info with a 5 s timeout", async () => {
    const yes = fakeRunner(() => ok());
    expect(await new DockerBackend({ collective: "climate", runner: yes.runner }).available()).toBe(true);
    expect(yes.calls).toEqual([{ args: ["info"], timeoutMs: 5000 }]);
    const no = fakeRunner(() => ({ code: 1, stdout: "", stderr: "Cannot connect" }));
    expect(await new DockerBackend({ collective: "climate", runner: no.runner }).available()).toBe(false);
  });

  test("ensure creates a missing desk with volume, host gateway and limits", async () => {
    const f = fakeRunner((a) => (a[0] === "inspect" ? { code: 1, stdout: "", stderr: "No such object" } : ok("cid")));
    const h = await new DockerBackend({ collective: "Workshop Collective", runner: f.runner }).ensure(agent, building);
    expect(h).toEqual({ name: "desk-workshop-collective-ag_abc123", agentId: "ag_abc123", createdMs: expect.any(Number) });
    expect(f.calls.map((c) => c.args.join(" "))).toEqual([
      "inspect -f {{.State.Running}} desk-workshop-collective-ag_abc123",
      "run -d --name desk-workshop-collective-ag_abc123 -v deskhome-ag_abc123:/home/agent --add-host=host.docker.internal:host-gateway --memory 2g --cpus 2"
        + " --label muster-town.desk=1 --label muster-town.agent=ag_abc123 --label muster-town.collective=workshop-collective muster-town-desk sleep infinity",
    ]);
  });

  test("ensure starts a stopped desk and leaves a running one alone", async () => {
    const stopped = fakeRunner((a) => ok(a[0] === "inspect" ? "false\n" : ""));
    await new DockerBackend({ collective: "climate", runner: stopped.runner }).ensure(agent, building);
    expect(stopped.calls.map((c) => c.args.join(" "))).toEqual(["inspect -f {{.State.Running}} desk-climate-ag_abc123", "start desk-climate-ag_abc123"]);
    const running = fakeRunner(() => ok("true\n"));
    await new DockerBackend({ collective: "climate", runner: running.runner }).ensure(agent, building);
    expect(running.calls).toHaveLength(1);
  });

  test("exec passes env by name only, streams lines, reports the exit code; kill stops both ends", async () => {
    const f = fakeRunner(() => ok());
    const backend = new DockerBackend({ collective: "climate", runner: f.runner });
    const lines: string[] = [];
    const child = backend.exec({ name: "desk-climate-ag_abc123", agentId: "ag_abc123" }, ["agent-town-desk", "run", "--session", "se_1"], { AGENT_TOWN_TOKEN: "at_secret", ANTHROPIC_API_KEY: "sk-secret" }, (s, l) => lines.push(`${s}:${l}`));
    const sp = f.spawned[0];
    expect(sp.args).toEqual(["exec", "-e", "AGENT_TOWN_TOKEN", "-e", "ANTHROPIC_API_KEY", "desk-climate-ag_abc123", "agent-town-desk", "run", "--session", "se_1"]);
    expect(sp.args.join(" ")).not.toContain("secret");
    expect(sp.env).toEqual({ AGENT_TOWN_TOKEN: "at_secret", ANTHROPIC_API_KEY: "sk-secret" });
    sp.out.write("hello\nworld\n");
    sp.err.write("oops\n");
    await vi.waitFor(() => expect(lines).toEqual(["stdout:hello", "stdout:world", "stderr:oops"]));
    child.kill();
    expect(sp.killed).toEqual(["SIGTERM"]);
    // the bin is a script that execs node, so the live command line holds only the arguments: match those (first char bracketed so pkill's own shell doesn't match)
    await vi.waitFor(() => expect(f.calls.map((c) => c.args)).toContainEqual(["exec", "desk-climate-ag_abc123", "sh", "-c", killTreeCommand("[r]un --session se_1")]));
    sp.child.emit("exit", 143, null);
    expect(await child.wait()).toBe(143);
  });

  test("killOrphan pkills a previous process's session in the agent's desk", async () => {
    const f = fakeRunner(() => ok());
    await new DockerBackend({ collective: "climate", runner: f.runner }).killOrphan("ag_abc123", "se_9");
    expect(f.calls.map((c) => c.args)).toEqual([["exec", "desk-climate-ag_abc123", "sh", "-c", killTreeCommand("[r]un --session se_9")]]);
  });
});

// ---------- desk sessions through the scheduler ----------
class FakeDesk implements DeskBackend {
  readonly kind = "docker" as const;
  ensured: string[] = [];
  execs: { handle: DeskHandle; argv: string[]; env: Record<string, string>; exit(code: number): void; killed: boolean }[] = [];
  async available() { return true; }
  async ensure(a: Agent) { this.ensured.push(a.id); return { name: `desk-test-${a.id}`, agentId: a.id }; }
  exec(handle: DeskHandle, argv: string[], env: Record<string, string>): DeskChild {
    let exit!: (c: number) => void;
    const done = new Promise<number>((r) => { exit = r; });
    const rec = { handle, argv, env, exit, killed: false };
    this.execs.push(rec);
    return { wait: () => done, kill: () => { rec.killed = true; exit(137); } };
  }
}

function deskSetup() {
  const desk = new FakeDesk();
  const s = setup(async function* () { yield result(1, 0); }, { deskBackend: desk, killGraceMs: 0, deskOptions: { ghToken: () => "gho_test" } });
  return { ...s, desk };
}
const REPORT = { title: "Growth rate", verdict: "continue", body: "## Summary\nx\n\n## Proposal for next session\nNext question?\nWhy." } as const;

describe("desk work sessions", () => {
  test("scheduler starts a docker session: Session row, desk ensured, exec argv + env", async () => {
    const { world, runtime, desk, by, lab, sdk } = deskSetup();
    const noor = by("Noor");
    world.agents.where("kind = 'resident' AND id != ?", [noor.id]).forEach((a) => world.agents.patch(a.id, { status: "stopped" }));
    world.setStatus(noor.id, "idle");
    const asg = world.ops.createWork(null, noor.id, { title: "Measure" });
    await runtime.tickOnce();
    await vi.waitFor(() => expect(desk.execs).toHaveLength(1));
    expect(await runtime.backend()).toBe("docker");
    expect(sdk.sessions).toHaveLength(0);
    const s = world.sessions.first("agentId = ? AND purpose = 'work'", [noor.id])!;
    expect(s).toMatchObject({ backend: "docker", status: "running", assignmentId: asg.id });
    expect(desk.ensured).toEqual([noor.id]);
    const ex = desk.execs[0];
    expect(ex.argv).toEqual(["agent-town-desk", "run", "--session", s.id]);
    const tok = world.tokens.getOrCreate("agent", noor.id);
    // both env spellings for one release (rename P3): the desk image may predate the rename
    expect(ex.env).toMatchObject({ MUSTER_TOWN_URL: "http://host.docker.internal:4321", MUSTER_TOWN_TOKEN: tok, AGENT_TOWN_URL: "http://host.docker.internal:4321", AGENT_TOWN_TOKEN: tok, DESK_MODEL: lab.model, DESK_MAX_TURNS: String(lab.maxTurnsPerSession) });
    expect(ex.env.GH_TOKEN).toBeUndefined(); // no workspace
    expect(world.agents.require(noor.id).status).toBe("working");
    expect(runtime.isWorking(noor.id)).toBe(true);
    expect(await runtime.interrupt(noor.id, "queued instead")).toBe(false); // desk sessions use the queue

    // activity → events
    runtime.onDeskActivity(noor.id, { session: s.id, kind: "tool", tool: "WebSearch", input: { query: "co2 growth" } });
    runtime.onDeskActivity(noor.id, { session: s.id, kind: "thought", text: "x".repeat(300) });
    const evs = world.events.list({ agentId: noor.id, types: ["agent.tool", "agent.thought"] });
    expect(evs.map((e) => e.text)[0]).toBe("Searching the web: co2 growth");
    expect(evs[1].text.length).toBeLessThanOrEqual(200);
    expect(evs[0].payload.sessionId).toBe(s.id);
    expect(world.agents.require(noor.id).activity).toBe("Searching the web: co2 growth");
    expect(() => runtime.onDeskActivity(by("Mei").id, { session: s.id, kind: "status", text: "hi" })).toThrow(/Not your session/);

    // normal end: the desk submitted its report then posted session-end; the child exits 0 afterwards
    await world.verbs.submit_report(noor.id, REPORT);
    const ended = await runtime.finishWorkSession(s.id, { tokens: 900, costUsd: 0.3, turns: 5, sdkSessionId: "sdk-1", reportSubmitted: true, finalText: "done" });
    expect(ended).toMatchObject({ status: "done", tokens: 900, sdkSessionId: "sdk-1" });
    expect(ended.reportId).toBeTruthy();
    expect(world.agents.require(noor.id)).toMatchObject({ status: "idle", spentTokensToday: 30 });
    expect(world.allocations.first("buildingId = ?", [lab.id])!.spentTokens).toBe(30);
    ex.exit(0);
    await runtime.whenIdle();
    expect(world.sessions.require(s.id).status).toBe("done"); // not finished twice
    expect(world.events.list({ agentId: noor.id, types: ["session.ended"] })).toHaveLength(1);
    expect(runtime.isWorking(noor.id)).toBe(false);
  });

  test("session-end without a report writes the fallback report", async () => {
    const { world, runtime, desk, by } = deskSetup();
    const tomas = by("Tomas");
    const asg = world.ops.createWork(null, tomas.id, { title: "Land sink" });
    const running = runtime.runWorkSession(tomas.id, asg.id);
    await vi.waitFor(() => expect(desk.execs).toHaveLength(1));
    const sid = desk.execs[0].argv[3];
    await runtime.finishWorkSession(sid, { tokens: 10, costUsd: 0, turns: 1, finalText: "Found 2.4 ppm/yr", reportSubmitted: false });
    desk.execs[0].exit(0);
    const s = await running;
    const report = world.docs.require(s.reportId!);
    expect(report).toMatchObject({ decision: "pending", assignmentId: asg.id });
    expect(report.body).toContain("2.4 ppm/yr");
    expect(world.agents.require(tomas.id).status).toBe("idle");
  });

  test("stop kills the desk; the exit ends the session interrupted with a stop report", async () => {
    const { world, runtime, desk, by } = deskSetup();
    const ravi = by("Ravi");
    world.setStatus(ravi.id, "idle");
    const asg = world.ops.createWork(null, ravi.id, {});
    const running = runtime.runWorkSession(ravi.id, asg.id);
    await vi.waitFor(() => expect(desk.execs).toHaveLength(1));
    world.ops.stopAgent(null, ravi.id);
    const s = await running;
    expect(desk.execs[0].killed).toBe(true);
    expect(s.status).toBe("interrupted");
    expect(world.docs.require(s.reportId!).decision).toBe("stop");
    expect(world.assignments.require(asg.id).status).toBe("cancelled");
    expect(world.agents.require(ravi.id).status).toBe("stopped");
  });

  test("a desk that dies without reporting ends the session with an error", async () => {
    const { world, runtime, desk, by } = deskSetup();
    const mei = by("Mei");
    const asg = world.ops.createWork(null, mei.id, {});
    const running = runtime.runWorkSession(mei.id, asg.id);
    await vi.waitFor(() => expect(desk.execs).toHaveLength(1));
    desk.execs[0].exit(1);
    const s = await running;
    expect(s).toMatchObject({ status: "error", error: "desk exited 1" });
    expect(world.docs.require(s.reportId!)).toMatchObject({ decision: "pending" });
    expect(world.agents.require(mei.id).status).toBe("idle");
  });

  test("buildings with code access get GH_TOKEN; the host backend won't schedule them", async () => {
    const { world, runtime, desk, by, lab } = deskSetup();
    world.town.set({ workspace: { path: ".", repoUrl: "git@github.com:o/agent-town.git", base: "main", branchPrefix: "agent", tools: [] } });
    world.ops.updateBuilding(null, lab.id, { codeAccess: true });
    const noor = by("Noor");
    const asg = world.ops.createWork(null, noor.id, {});
    void runtime.runWorkSession(noor.id, asg.id);
    await vi.waitFor(() => expect(desk.execs).toHaveLength(1));
    expect(desk.execs[0].env.GH_TOKEN).toBe("gho_test");
    desk.execs[0].exit(1);
    await runtime.whenIdle();

    const host = setup(async function* () { yield result(1, 0); });
    host.world.town.set({ workspace: { path: ".", base: "main", branchPrefix: "agent", tools: [] } });
    host.world.ops.updateBuilding(null, host.lab.id, { codeAccess: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    host.world.ops.createWork(null, host.by("Noor").id, {});
    await host.runtime.tickOnce();
    await host.runtime.whenIdle();
    expect(host.sdk.sessions).toHaveLength(0);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("has code access"))).toBe(true);
    warn.mockRestore();
    await expect(host.runtime.runWorkSession(host.by("Noor").id, host.world.assignments.first("agentId = ?", [host.by("Noor").id])!.id)).rejects.toThrow(/need a desk/);
  });
});

describe("deskAuth (funding: subscription first, API-key failover)", () => {
  const env = { CLAUDE_CODE_OAUTH_TOKEN: "oat", ANTHROPIC_API_KEY: "envkey" } as NodeJS.ProcessEnv;
  test("never both a key and the token; the fallback key rides along with the subscription only", () => {
    expect(deskAuth({ auth: "donor-key", apiKey: "donor" }, env)).toEqual({ mode: "donor-key", env: { ANTHROPIC_API_KEY: "donor" } });
    expect(deskAuth({ auth: "subscription", apiKey: null }, env)).toEqual({ mode: "subscription", env: { CLAUDE_CODE_OAUTH_TOKEN: "oat" } });
    expect(deskAuth({ auth: "subscription", apiKey: null, fallback: { allocationId: "al_1", apiKey: "envkey" } }, env))
      .toEqual({ mode: "subscription", env: { CLAUDE_CODE_OAUTH_TOKEN: "oat", AGENT_TOWN_FALLBACK_API_KEY: "envkey" } });
    expect(deskAuth({ auth: "api-key", apiKey: "envkey" }, env)).toEqual({ mode: "api-key", env: { ANTHROPIC_API_KEY: "envkey" } });
    expect(deskAuth({ auth: "api-key", apiKey: null }, env)).toEqual({ mode: "api-key", env: { ANTHROPIC_API_KEY: "envkey" } });
    // a subscription allocation with no token in the env can only run on the key
    expect(deskAuth({ auth: "subscription", apiKey: null }, { ANTHROPIC_API_KEY: "envkey" } as NodeJS.ProcessEnv)).toEqual({ mode: "api-key", env: { ANTHROPIC_API_KEY: "envkey" } });
    // unfunded: the token, else the env key
    expect(deskAuth({ auth: null, apiKey: null }, env)).toEqual({ mode: "subscription", env: { CLAUDE_CODE_OAUTH_TOKEN: "oat" } });
    expect(deskAuth({ auth: null, apiKey: null }, { ANTHROPIC_API_KEY: "envkey" } as NodeJS.ProcessEnv)).toEqual({ mode: "api-key", env: { ANTHROPIC_API_KEY: "envkey" } });
    expect(deskAuth({ auth: null, apiKey: null }, {} as NodeJS.ProcessEnv)).toEqual({ mode: "none", env: {} });
  });
});

describe("desk funding and failover charging", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  function funded() {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "oat-secret");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-town");
    const s = deskSetup();
    const { world, lab, seed } = s;
    const house = world.allocations.first("buildingId = ?", [lab.id])!;
    world.budget.retire(house.id);
    const sub = world.budget.donate(seed.admin.id, { tokens: 100_000, buildingId: lab.id, auth: "subscription", label: "Mitchell's Claude subscription" });
    const buffer = world.budget.donate(seed.admin.id, { tokens: 50_000, buildingId: lab.id, auth: "api-key", label: "API-key buffer" });
    return { ...s, sub, buffer };
  }

  test("fundingFor: subscription first with the api-key allocation as fallback; retired allocations are skipped", () => {
    const { world, by, sub, buffer } = funded();
    expect(fundingFor(world, by("Noor").id)).toEqual({ allocationId: sub.id, auth: "subscription", apiKey: null, fallback: { allocationId: buffer.id, apiKey: "sk-town" } });
    world.budget.retire(sub.id);
    expect(fundingFor(world, by("Noor").id)).toEqual({ allocationId: buffer.id, auth: "api-key", apiKey: "sk-town" });
  });

  test("the desk env carries the token and the fallback key; session row and status say how it's funded", async () => {
    const { world, runtime, desk, by } = funded();
    const noor = by("Noor");
    const asg = world.ops.createWork(null, noor.id, {});
    void runtime.runWorkSession(noor.id, asg.id);
    await vi.waitFor(() => expect(desk.execs).toHaveLength(1));
    const env = desk.execs[0].env;
    expect(env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: "oat-secret", AGENT_TOWN_FALLBACK_API_KEY: "sk-town", DESK_AUTH: "subscription" });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    const sid = desk.execs[0].argv[3];
    expect(world.sessions.require(sid).funding).toBe("subscription");
    expect(world.events.list({ agentId: noor.id, types: ["session.started"] }).at(-1)!.text).toContain("(funded by subscription)");
    expect(world.events.list({ agentId: noor.id, types: ["agent.activity"] }).map((e) => e.text)).toContain("Starting work (funded by subscription)");
    desk.execs[0].exit(1);
    await runtime.whenIdle();
  });

  test("session-end with fallback charges the fallback allocation and marks the session api-key", async () => {
    const { world, runtime, desk, by, sub, buffer } = funded();
    const noor = by("Noor");
    const asg = world.ops.createWork(null, noor.id, {});
    const running = runtime.runWorkSession(noor.id, asg.id);
    await vi.waitFor(() => expect(desk.execs).toHaveLength(1));
    const sid = desk.execs[0].argv[3];
    const ended = await runtime.finishWorkSession(sid, { tokens: 700, costUsd: 0.2, turns: 2, reportSubmitted: false, finalText: "x", fundingUsed: "api-key", fallback: true });
    expect(ended.funding).toBe("api-key");
    expect(world.allocations.require(buffer.id).spentTokens).toBe(23);
    expect(world.allocations.require(sub.id).spentTokens).toBe(0);
    desk.execs[0].exit(0);
    await running;
  });

  test("without a fallback the subscription allocation is charged", async () => {
    const { world, runtime, desk, by, sub, buffer } = funded();
    const noor = by("Noor");
    const asg = world.ops.createWork(null, noor.id, {});
    const running = runtime.runWorkSession(noor.id, asg.id);
    await vi.waitFor(() => expect(desk.execs).toHaveLength(1));
    const ended = await runtime.finishWorkSession(desk.execs[0].argv[3], { tokens: 300, costUsd: 0, turns: 1, reportSubmitted: false, fundingUsed: "subscription" });
    expect(ended.funding).toBe("subscription");
    expect(world.allocations.require(sub.id).spentTokens).toBe(10);
    expect(world.allocations.require(buffer.id).spentTokens).toBe(0);
    desk.execs[0].exit(0);
    await running;
  });
});
