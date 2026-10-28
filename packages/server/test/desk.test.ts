import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { World } from "@muster-town/core";
import { startRuntime, type DeskBackend, type DeskChild, type DeskHandle } from "@muster-town/runtime";
import type { Agent } from "@muster-town/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { loadEnvFile } from "../src/env.ts";
import { json, REPO_ROOT } from "./helpers.ts";

class FakeDesk implements DeskBackend {
  readonly kind = "docker" as const;
  execs: { argv: string[]; env: Record<string, string>; exit(code: number): void }[] = [];
  async available() { return true; }
  async ensure(a: Agent) { return { name: `desk-test-${a.id}`, agentId: a.id }; }
  exec(_h: DeskHandle, argv: string[], env: Record<string, string>): DeskChild {
    let exit!: (c: number) => void;
    const done = new Promise<number>((r) => { exit = r; });
    this.execs.push({ argv, env, exit });
    return { wait: () => done, kill: () => exit(137) };
  }
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function setup() {
  const world = World.open(":memory:");
  const seed = world.seedDefaults({ importDir: join(REPO_ROOT, "buildings/carbon-cycle"), townJsonPath: join(REPO_ROOT, "town.json") });
  const desk = new FakeDesk();
  const runtime = startRuntime({ world, mcpUrl: "http://127.0.0.1:4321/mcp", intervalMs: 0, exportDir: false, deskBackend: desk, killGraceMs: 0 });
  const app = await buildApp({ world, dev: true, runtime, webDist: false });
  cleanups.push(async () => { for (const e of desk.execs) e.exit(0); await app.close(); world.close(); });
  const by = (name: string) => world.agents.first("name = ?", [name])!;
  const admin = { authorization: `Bearer ${seed.adminToken}` };
  const as = (a: Agent) => ({ authorization: `Bearer ${world.tokens.getOrCreate("agent", a.id)}` });
  /** start a desk work session for `name`; returns its session id */
  const start = async (name: string) => {
    const a = by(name);
    const asg = world.ops.createWork(null, a.id, { title: "Measure the growth rate" });
    void runtime.runWorkSession(a.id, asg.id).catch(() => undefined);
    await vi.waitFor(() => expect(desk.execs.some((e) => world.sessions.get(e.argv[3])?.agentId === a.id)).toBe(true));
    return { agent: a, sessionId: desk.execs.find((e) => world.sessions.get(e.argv[3])?.agentId === a.id)!.argv[3], assignmentId: asg.id };
  };
  return { world, seed, app, runtime, desk, by, admin, as, start };
}

describe("agent-scoped desk API", () => {
  it("once the server quiesces for a restart, desk and MCP calls get 503 restarting with Retry-After; other routes don't", async () => {
    const { app, world, as, start } = await setup();
    const { agent, sessionId } = await start("Noor");
    expect((await json(app, "GET", `/api/agents/me/control?session=${sessionId}`, { headers: as(agent) })).status).toBe(200);
    await world.host.quiesce!(1000);
    const r = await app.inject({ method: "GET", url: `/api/agents/me/control?session=${sessionId}`, headers: as(agent) });
    expect(r.statusCode).toBe(503);
    expect(r.headers["retry-after"]).toBe("5");
    expect(JSON.parse(r.body)).toMatchObject({ restarting: true });
    expect((await app.inject({ method: "POST", url: "/mcp", headers: { ...as(agent), "content-type": "application/json" }, payload: "{}" })).statusCode).toBe(503);
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
  });

  it("brief for the caller's running session; 403 for another agent's or a user token; 401 without one", async () => {
    const { app, as, by, admin, start } = await setup();
    const { agent, sessionId, assignmentId } = await start("Noor");
    const ok = await json(app, "GET", `/api/agents/me/brief?session=${sessionId}`, { headers: as(agent) });
    expect(ok.status).toBe(200);
    expect(ok.body.session).toMatchObject({ id: sessionId, backend: "docker", status: "running" });
    expect(ok.body.agent.id).toBe(agent.id);
    expect(ok.body.assignment.id).toBe(assignmentId);
    expect(ok.body.building.id).toBe("carbon-cycle");
    expect(ok.body.town.name).toBeTruthy();
    expect(ok.body.system).toContain(agent.name);
    expect(ok.body.prompt).toContain("Measure the growth rate");
    expect(ok.body.workspace).toBeUndefined();

    expect((await json(app, "GET", `/api/agents/me/brief?session=${sessionId}`, { headers: as(by("Mei")) })).status).toBe(403);
    expect((await json(app, "GET", `/api/agents/me/brief?session=${sessionId}`, { headers: admin })).status).toBe(403);
    expect((await json(app, "GET", `/api/agents/me/brief?session=${sessionId}`)).status).toBe(401);
    expect((await json(app, "GET", "/api/agents/me/brief?session=se_nope", { headers: as(agent) })).status).toBe(403);
    expect((await json(app, "GET", "/api/agents/me/brief", { headers: as(agent) })).status).toBe(400);
  });

  it("the Settings Code access checkbox (PATCH codeAccess) gives an existing building the collective repo on its next session, and takes it away", async () => {
    const { app, as, admin, world, desk, runtime, by } = await setup();
    world.town.set({ workspace: { path: "/tmp/repo", repoUrl: "git@github.com:o/r.git", base: "main", branchPrefix: "agent", tools: [] } });
    world.buildings.upsert({ ...world.buildings.require("carbon-cycle"), codeAccess: false }); // an existing building from before 022
    const brief = async () => {
      const agent = by("Noor"), n = desk.execs.length;
      void runtime.runWorkSession(agent.id, world.ops.createWork(null, agent.id, { title: "Measure the growth rate" }).id).catch(() => undefined);
      await vi.waitFor(() => expect(desk.execs.length).toBe(n + 1));
      const sessionId = desk.execs[n].argv[3];
      const res = await json(app, "GET", `/api/agents/me/brief?session=${sessionId}`, { headers: as(agent) });
      desk.execs[n].exit(0);
      await vi.waitFor(() => expect(world.sessions.require(sessionId).status).not.toBe("running"));
      await vi.waitFor(() => expect(world.agents.require(agent.id).status).not.toBe("working"));
      return res.body;
    };
    expect((await brief()).workspace).toBeUndefined();
    const on = await json(app, "PATCH", "/api/buildings/carbon-cycle", { headers: admin, body: { codeAccess: true } });
    expect(on.status).toBe(200);
    expect(on.body.building.codeAccess).toBe(true);
    expect((await json(app, "GET", "/api/town")).body.buildings.find((b: { id: string }) => b.id === "carbon-cycle").codeAccess).toBe(true);
    expect((await brief()).workspace).toMatchObject({ repoUrl: "https://github.com/o/r.git", base: "main" });
    expect((await json(app, "PATCH", "/api/buildings/carbon-cycle", { headers: admin, body: { codeAccess: false } })).body.building.codeAccess).toBe(false);
    expect((await brief()).workspace).toBeUndefined();
  });

  it("activity becomes agent.tool / agent.thought events with the session id", async () => {
    const { app, as, world, by, start } = await setup();
    const { agent, sessionId } = await start("Noor");
    const t = await app.inject({ method: "POST", url: "/api/agents/me/activity", headers: as(agent), payload: { session: sessionId, kind: "tool", tool: "mcp__town__search", input: { query: "growth" } } });
    expect(t.statusCode).toBe(204);
    await app.inject({ method: "POST", url: "/api/agents/me/activity", headers: as(agent), payload: { session: sessionId, kind: "thought", text: "Checking the board first." } });
    const evs = world.events.list({ agentId: agent.id, types: ["agent.tool", "agent.thought"] });
    expect(evs.map((e) => [e.type, e.text])).toEqual([["agent.tool", "Searching the library: growth"], ["agent.thought", "Checking the board first."]]);
    expect(evs.every((e) => e.payload.sessionId === sessionId)).toBe(true);
    expect(world.agents.require(agent.id).activity).toBe("Searching the library: growth");
    const other = await app.inject({ method: "POST", url: "/api/agents/me/activity", headers: as(by("Mei")), payload: { session: sessionId, kind: "thought", text: "x" } });
    expect(other.statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/agents/me/activity", headers: as(agent), payload: { session: sessionId, kind: "nope" } })).statusCode).toBe(400);
  });

  it("interrupts queue for desk sessions; control returns them until acked; stop shows up after /stop", async () => {
    const { app, as, admin, start, world } = await setup();
    const { agent, sessionId } = await start("Noor");
    const q = await json(app, "POST", `/api/agents/${agent.id}/interrupt`, { headers: admin, body: { text: "Focus on 13C" } });
    expect(q.status).toBe(200);
    expect(q.body).toMatchObject({ ok: true, queued: true });
    const c1 = await json(app, "GET", `/api/agents/me/control?session=${sessionId}`, { headers: as(agent) });
    expect(c1.body).toEqual({ interrupts: [{ id: q.body.interruptId, text: "Focus on 13C", from: world.users.require(world.users.first("1=1")!.id).name, now: false }], stop: false });
    const ack = await app.inject({ method: "POST", url: "/api/agents/me/control/ack", headers: as(agent), payload: { ids: [q.body.interruptId] } });
    expect(ack.statusCode).toBe(204);
    expect((await json(app, "GET", `/api/agents/me/control?session=${sessionId}`, { headers: as(agent) })).body).toEqual({ interrupts: [], stop: false });
    // "send now" rides along so the desk stops the current turn before delivering it
    const n = await json(app, "POST", `/api/agents/${agent.id}/interrupt`, { headers: admin, body: { text: "Drop that", now: true } });
    const c2 = await json(app, "GET", `/api/agents/me/control?session=${sessionId}`, { headers: as(agent) });
    expect(c2.body.interrupts).toEqual([expect.objectContaining({ id: n.body.interruptId, text: "Drop that", now: true })]);
    await app.inject({ method: "POST", url: "/api/agents/me/control/ack", headers: as(agent), payload: { ids: [n.body.interruptId] } });
    expect((await json(app, "POST", `/api/agents/${agent.id}/stop`, { headers: admin })).status).toBe(200);
    expect((await json(app, "GET", `/api/agents/me/control?session=${sessionId}`, { headers: as(agent) })).body.stop).toBe(true);
    // resume: back to idle, no new assignment
    const asgs = world.assignments.where("agentId = ?", [agent.id]).length;
    expect((await json(app, "POST", `/api/agents/${agent.id}/resume`, { headers: admin })).body.agent.status).toBe("idle");
    expect(world.assignments.where("agentId = ?", [agent.id]).length).toBe(asgs);
  });

  it("session-end ends the session, writes the fallback report and charges the budget (idempotent)", async () => {
    const { app, as, world, start } = await setup();
    const { agent, sessionId } = await start("Tomas");
    const body = { session: sessionId, tokens: 1500, costUsd: 0.5, turns: 7, sdkSessionId: "sdk-9", finalText: "Land sink is 3.1 ± 0.6 GtC/yr", error: null, reportSubmitted: false };
    const r = await json(app, "POST", "/api/agents/me/session-end", { headers: as(agent), body });
    expect(r.status).toBe(200);
    expect(r.body.session).toMatchObject({ id: sessionId, status: "done", tokens: 1500, costUsd: 0.5, turns: 7, sdkSessionId: "sdk-9" });
    expect(world.docs.require(r.body.session.reportId).body).toContain("3.1 ± 0.6 GtC/yr");
    expect(world.agents.require(agent.id).spentTokensToday).toBe(50);
    expect(world.allocations.first("buildingId = ?", ["carbon-cycle"])!.spentTokens).toBe(50); // 1500 raw with no counters, back-filled: 1500 / 30 adjusted
    const again = await json(app, "POST", "/api/agents/me/session-end", { headers: as(agent), body });
    expect(again.body.session.status).toBe("done");
    expect(world.agents.require(agent.id).spentTokensToday).toBe(50);
    expect((await json(app, "GET", `/api/agents/me/brief?session=${sessionId}`, { headers: as(agent) })).status).toBe(403);
    expect((await json(app, "GET", `/api/agents/me/control?session=${sessionId}`, { headers: as(agent) })).body.stop).toBe(true);
  });

  it("session-end with the five counters books them on the session, the usage ledger and the allocation; session.ended carries them", async () => {
    const { app, as, world, start } = await setup();
    const { agent, sessionId } = await start("Tomas");
    const counts = { input: 20, output: 180, cacheRead: 1200, cacheWrite5m: 80, cacheWrite1h: 20 };
    const body = { session: sessionId, tokens: 1500, counts, byModel: { "claude-opus-5-5": counts }, costUsd: 0.5, turns: 7, reportSubmitted: false };
    const r = await json(app, "POST", "/api/agents/me/session-end", { headers: as(agent), body });
    expect(r.body.session).toMatchObject({ ...counts, tokens: 1500 });
    const ended = world.events.list({ types: ["session.ended"] }).find((e) => e.payload?.sessionId === sessionId)!;
    expect(ended.payload).toMatchObject({ ...counts, tokens: 1500, byModel: { "claude-opus-5-5": counts } });
    expect(world.db.prepare("SELECT input, output, cacheRead, cacheWrite5m, cacheWrite1h, tokens FROM usage WHERE agentId = ?").get(agent.id)).toEqual({ ...counts, tokens: 224 }); // booked adjusted on Opus 5.5: 180 + 0.2 × 20 + 0.01 × 1200 + 0.25 × 80 + 0.4 × 20
    expect(world.allocations.first("buildingId = ?", ["carbon-cycle"])).toMatchObject({ spentTokens: 224, spentRawTokens: 1500, spentInput: 20, spentOutput: 180, spentCacheRead: 1200, spentCacheWrite5m: 80, spentCacheWrite1h: 20 });
  });

  it("interrupt still goes straight to an in-process session's runtime when it takes it", async () => {
    const { app, admin, by, runtime } = await setup();
    const spy = vi.spyOn(runtime, "interrupt").mockResolvedValue(true);
    const r = await json(app, "POST", `/api/agents/${by("Mei").id}/interrupt`, { headers: admin, body: { text: "hi" } });
    expect(r.body).toEqual({ ok: true, result: true });
    expect(spy).toHaveBeenCalled();
  });
});

describe(".env loader", () => {
  it("parses KEY=VALUE lines without overriding set vars", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-town-env-"));
    cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, ".env"), "# comment\nANTHROPIC_API_KEY=sk-ant-x\n export GH_TOKEN = 'gho_y' \nSET=new\nbad line\n");
    const env: NodeJS.ProcessEnv = { SET: "old" };
    expect(loadEnvFile(join(dir, ".env"), env)).toEqual(["ANTHROPIC_API_KEY", "GH_TOKEN", "SET"]);
    expect(env).toEqual({ ANTHROPIC_API_KEY: "sk-ant-x", GH_TOKEN: "gho_y", SET: "old" });
    expect(loadEnvFile(join(dir, "missing"), env)).toEqual([]);
  });
});
