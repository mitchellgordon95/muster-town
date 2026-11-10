import { VERB_NAMES, LookResult, ServerMessage } from "@muster-town/schema";
import { townRoleId } from "@muster-town/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { seededApp } from "./helpers.ts";

let ctx: Awaited<ReturnType<typeof seededApp>>;
let base = "";
let agentToken = "";

beforeAll(async () => {
  ctx = await seededApp();
  ctx.world.start(10);
  await ctx.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;
  agentToken = ctx.world.ops.registerVisitor(ctx.seed.admin.id, { name: "Test Claude", buildingId: "carbon-cycle" }).token;
});
afterAll(async () => { await ctx.close(); });

async function mcpClient(token: string) {
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

describe("MCP over Streamable HTTP", () => {
  it("lists every verb and `look` returns a LookResult", async () => {
    const client = await mcpClient(agentToken);
    const { tools } = await client.listTools();
    // this test world has no repo (repoMode none, like a hosted collective): no `redeploy` tool (1:1 mt_1vs893enaw);
    // a visitor sees only the verbs its owner's roles allow: an admin's visitor is no Planner or Secretary (gr_uc179zv1xa)
    expect(tools.map((t) => t.name).sort()).toEqual(VERB_NAMES.filter((v) => !["redeploy", "calibrate", "rank"].includes(v)).sort());
    expect(tools.find((t) => t.name === "go")!.inputSchema.properties).toHaveProperty("to");

    const res = await client.callTool({ name: "look", arguments: {} });
    expect(res.isError).toBeFalsy();
    const look = LookResult.parse(JSON.parse((res.content as { text: string }[])[0].text));
    expect(look.me.name).toBe("Test Claude");
    await client.close();
  });

  it("the tool list follows the repo mode: `redeploy` only on this server's repo for whoever holds it; no deploy or PR waits without a repo", async () => {
    let client = await mcpClient(agentToken);
    let { tools } = await client.listTools();
    const report = tools.find((t) => t.name === "submit_report")!;
    expect(report.description).not.toMatch(/redeploy|\{pr/);
    // the wait (resumeWhen) offers no deploy or PR kind; a rollup ask's claim check may still be of kind "pr"
    expect(JSON.stringify((report.inputSchema.properties as Record<string, unknown>).resumeWhen)).not.toMatch(/"deploy"|"pr"/);
    await client.close();
    ctx.world.town.set({ workspace: { path: ".", tools: [], branchPrefix: "agent", base: "main" } });
    try {
      const me = ctx.world.agents.first("name = 'Test Claude'")!;
      ctx.world.permissions.grant(me, townRoleId("deployer"));
      client = await mcpClient(agentToken);
      ({ tools } = await client.listTools());
      expect(ctx.world.permissions.can(me, "town.redeploy")).toBe(true);
      expect(tools.map((t) => t.name)).toContain("redeploy");
      expect(tools.find((t) => t.name === "submit_report")!.description).toMatch(/a redeploy/);
      await client.close();
      ctx.world.host.hosted = true;
      client = await mcpClient(agentToken);
      ({ tools } = await client.listTools());
      expect(tools.map((t) => t.name)).not.toContain("redeploy");
      await client.close();
    } finally {
      ctx.world.host.hosted = false;
      ctx.world.town.set({ workspace: undefined });
    }
  });

  it("verb errors come back as isError tool results; `go` awaits arrival", async () => {
    const client = await mcpClient(agentToken);
    const denied = await client.callTool({ name: "review", arguments: { docId: "dc_nope", decision: "approve" } });
    expect(denied.isError).toBe(true);
    expect((denied.content as { text: string }[])[0].text).toMatch(/not found|Not allowed/i);

    const t0 = Date.now();
    const go = await client.callTool({ name: "go", arguments: { to: "library" } }, undefined, { timeout: 35_000 });
    expect(go.isError).toBeFalsy();
    expect(Date.now() - t0).toBeGreaterThan(100);
    await client.close();
  }, 40_000);

  it("rejects user tokens and missing tokens", async () => {
    const r1 = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r1.status).toBe(401);
    const r2 = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ctx.seed.adminToken}` }, body: "{}" });
    expect(r2.status).toBe(401);
  });
});

describe("WebSocket", () => {
  it("auth → snapshot with avatarAgentId → live messages; human.say emits agent.said", async () => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws`);
    const msgs: any[] = [];
    const waitFor = (pred: (m: any) => boolean, ms = 3000) => new Promise<any>((resolve, reject) => {
      const found = msgs.find(pred);
      if (found) return resolve(found);
      const timer = setTimeout(() => reject(new Error("timeout waiting for ws message")), ms);
      ws.on("message", (d) => { const m = JSON.parse(String(d)); if (pred(m)) { clearTimeout(timer); resolve(m); } });
    });
    ws.on("message", (d) => msgs.push(JSON.parse(String(d))));
    await new Promise((r) => ws.once("open", r));

    ws.send(JSON.stringify({ type: "human.say", text: "too early" }));
    expect((await waitFor((m) => m.type === "error")).message).toMatch(/auth/);

    ws.send(JSON.stringify({ type: "auth", token: ctx.seed.adminToken }));
    const snap = await waitFor((m) => m.type === "snapshot" && m.avatarAgentId);
    expect(ServerMessage.safeParse(snap).success).toBe(true);
    expect(snap.avatarAgentId).toMatch(/^ag_/);

    ws.send(JSON.stringify({ type: "human.say", text: "hello town" }));
    const said = await waitFor((m) => m.type === "event" && m.event.type === "agent.said");
    expect(said.event.agentId).toBe(snap.avatarAgentId);

    const plaza = snap.places.find((p: any) => p.id === "plaza").pos;
    ws.send(JSON.stringify({ type: "human.move", x: plaza.x + 1, y: plaza.y }));
    const pos = await waitFor((m) => m.type === "agents.pos" && m.positions.some((p: any) => p.id === snap.avatarAgentId && p.x === plaza.x + 1));
    expect(pos).toBeTruthy();
    ws.close();
  });

  it("a change reaching N sockets is stringified once, not once per socket (gr_n0p3ast5pp step 4, kr_vc8rkafulk)", async () => {
    const N = 5;
    const sockets = Array.from({ length: N }, () => new WebSocket(`${base.replace("http", "ws")}/ws`));
    const got = sockets.map((ws) => new Promise<void>((resolve) => ws.on("message", (d) => { if (String(d).startsWith('{"type":"snapshot"')) resolve(); })));
    await Promise.all(got);
    const change = { type: "agents.pos" as const, positions: [{ id: "ag_stringify_once", x: 1, y: 2, status: "idle" as const }] };
    const delivered = Promise.all(sockets.map((ws) => new Promise<void>((resolve) => ws.on("message", (d) => { if (String(d).includes("ag_stringify_once")) resolve(); }))));
    const original = JSON.stringify;
    let stringified = 0;
    JSON.stringify = ((value: unknown, ...rest: unknown[]) => { if (value === change) stringified++; return (original as (...a: unknown[]) => string)(value, ...rest); }) as typeof JSON.stringify;
    try {
      ctx.world.changes.emit(change);
      await delivered;
    } finally {
      JSON.stringify = original;
    }
    expect(stringified).toBe(1);
    for (const ws of sockets) ws.close();
  });

  it("GET /api/health says the Bank counts adjusted output tokens (Bank grant step 3, kr_vyrhhiyotb)", async () => {
    expect(await (await fetch(`${base}/api/health`)).json()).toMatchObject({ ok: true, accounting: "adjusted", accountingModel: "claude-opus-5-5" });
  });

  it("GET /api/health carries `load` and counts open /ws clients", async () => {
    const health = async () => (await (await fetch(`${base}/api/health`)).json()) as { load: { lagMs: number; rssMb: number; wsClients: number } };
    // the server counts a socket closed when its close frame lands, a moment after the client sees it: poll
    const clientsSettleAt = async (n: number) => {
      for (let i = 0; i < 40; i++) { if ((await health()).load.wsClients === n) return n; await new Promise((r) => setTimeout(r, 25)); }
      return (await health()).load.wsClients;
    };
    expect(await clientsSettleAt(0)).toBe(0); // the previous test's socket is gone
    const load = (await health()).load;
    expect(load.lagMs).toBeGreaterThanOrEqual(0);
    expect(load.rssMb).toBeGreaterThan(0);
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws`);
    await new Promise((r) => ws.once("open", r));
    expect(await clientsSettleAt(1)).toBe(1);
    ws.close();
    expect(await clientsSettleAt(0)).toBe(0);
  });
});
