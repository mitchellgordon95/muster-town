import { VERB_NAMES, LookResult, ServerMessage } from "@muster-town/schema";
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
    expect(tools.map((t) => t.name).sort()).toEqual([...VERB_NAMES].sort());
    expect(tools.find((t) => t.name === "go")!.inputSchema.properties).toHaveProperty("to");

    const res = await client.callTool({ name: "look", arguments: {} });
    expect(res.isError).toBeFalsy();
    const look = LookResult.parse(JSON.parse((res.content as { text: string }[])[0].text));
    expect(look.me.name).toBe("Test Claude");
    await client.close();
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
});
