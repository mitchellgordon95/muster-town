import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { World } from "@agent-town/core";
import { startRuntime, type DeskBackend, type DeskChild, type DeskHandle } from "@agent-town/runtime";
import type { Agent } from "@agent-town/schema";
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
    expect(c1.body).toEqual({ interrupts: [{ id: q.body.interruptId, text: "Focus on 13C", from: world.users.require(world.users.first("1=1")!.id).name }], stop: false });
    const ack = await app.inject({ method: "POST", url: "/api/agents/me/control/ack", headers: as(agent), payload: { ids: [q.body.interruptId] } });
    expect(ack.statusCode).toBe(204);
    expect((await json(app, "GET", `/api/agents/me/control?session=${sessionId}`, { headers: as(agent) })).body).toEqual({ interrupts: [], stop: false });
    expect((await json(app, "POST", `/api/agents/${agent.id}/stop`, { headers: admin })).status).toBe(200);
    expect((await json(app, "GET", `/api/agents/me/control?session=${sessionId}`, { headers: as(agent) })).body.stop).toBe(true);
  });

  it("session-end ends the session, writes the fallback report and charges the budget (idempotent)", async () => {
    const { app, as, world, start } = await setup();
    const { agent, sessionId } = await start("Tomas");
    const body = { session: sessionId, tokens: 1500, costUsd: 0.5, turns: 7, sdkSessionId: "sdk-9", finalText: "Land sink is 3.1 ± 0.6 GtC/yr", error: null, reportSubmitted: false };
    const r = await json(app, "POST", "/api/agents/me/session-end", { headers: as(agent), body });
    expect(r.status).toBe(200);
    expect(r.body.session).toMatchObject({ id: sessionId, status: "done", tokens: 1500, costUsd: 0.5, turns: 7, sdkSessionId: "sdk-9" });
    expect(world.docs.require(r.body.session.reportId).body).toContain("3.1 ± 0.6 GtC/yr");
    expect(world.agents.require(agent.id).spentTokensToday).toBe(1500);
    expect(world.allocations.first("buildingId = ?", ["carbon-cycle"])!.spentTokens).toBe(1500);
    const again = await json(app, "POST", "/api/agents/me/session-end", { headers: as(agent), body });
    expect(again.body.session.status).toBe("done");
    expect(world.agents.require(agent.id).spentTokensToday).toBe(1500);
    expect((await json(app, "GET", `/api/agents/me/brief?session=${sessionId}`, { headers: as(agent) })).status).toBe(403);
    expect((await json(app, "GET", `/api/agents/me/control?session=${sessionId}`, { headers: as(agent) })).body.stop).toBe(true);
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
