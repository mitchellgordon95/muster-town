import { LookResult, MailboxDigest, VERB_NAMES } from "@agent-town/schema";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { json, seededApp } from "./helpers.ts";

let ctx: Awaited<ReturnType<typeof seededApp>>;
let base = "";
let token = "";
let agentId = "";

beforeAll(async () => {
  ctx = await seededApp();
  await ctx.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;
  const r = ctx.world.ops.registerVisitor(ctx.seed.admin.id, { name: "Verb Claude", inheritsOwner: false });
  token = r.token; agentId = r.agent.id;
});
afterAll(async () => { await ctx.close(); });

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe("v1.4 generic verbs endpoint", () => {
  it("GET /api/verbs lists every verb with its description and a JSON schema", async () => {
    const r = await json<{ verbs: { name: string; description: string; inputSchema: { type: string; properties: Record<string, { type?: string; default?: unknown }>; required?: string[] } }[] }>(ctx.app, "GET", "/api/verbs");
    expect(r.status).toBe(200);
    expect(r.body.verbs.map((v) => v.name)).toEqual(VERB_NAMES);
    const go = r.body.verbs.find((v) => v.name === "go")!;
    expect(go.description).toMatch(/Walk/);
    expect(go.inputSchema).toMatchObject({ type: "object", properties: { to: { type: "string" } }, required: ["to"] });
    const inbox = r.body.verbs.find((v) => v.name === "inbox")!;
    expect(inbox.inputSchema.properties.markRead).toMatchObject({ type: "boolean", default: true });
    expect(inbox.inputSchema.required).toBeUndefined();
    expect(r.body.verbs.find((v) => v.name === "look")!.description).toMatch(/digest/);
  });

  it("`look` via /api/verbs/look equals the MCP tool result", async () => {
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const viaMcp = JSON.parse(((await client.callTool({ name: "look", arguments: {} })).content as { text: string }[])[0].text);
    await client.close();
    const res = await fetch(`${base}/api/verbs/look`, { method: "POST", headers: { ...bearer(token), "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(200);
    const viaHttp = (await res.json()) as { result: unknown };
    expect(viaHttp.result).toEqual(viaMcp);
    expect(LookResult.parse(viaHttp.result).me.name).toBe("Verb Claude");
  });

  it("an empty body is the empty input; verbs run as the caller", async () => {
    const r = await json(ctx.app, "POST", "/api/verbs/inbox", { headers: bearer(token) });
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty("result.messages");
  });

  it("auth: no token → 401, user token → 403; unknown verb → 404; invalid input → 400; verb errors keep their status", async () => {
    expect((await json(ctx.app, "POST", "/api/verbs/look", { body: {} })).status).toBe(401);
    const user = await json(ctx.app, "POST", "/api/verbs/look", { headers: ctx.auth, body: {} });
    expect(user.status).toBe(403);
    expect(user.body).toMatchObject({ code: "forbidden" });
    const unknown = await json(ctx.app, "POST", "/api/verbs/fly", { headers: bearer(token), body: {} });
    expect(unknown).toMatchObject({ status: 404, body: { code: "not_found" } });
    const bad = await json(ctx.app, "POST", "/api/verbs/go", { headers: bearer(token), body: { to: 42 } });
    expect(bad).toMatchObject({ status: 400, body: { code: "bad_request" } });
    expect(bad.body.error).toMatch(/to/);
    const missing = await json(ctx.app, "POST", "/api/verbs/read", { headers: bearer(token), body: { id: "dc_nope" } });
    expect(missing).toMatchObject({ status: 404, body: { code: "not_found" } });
    const denied = await json(ctx.app, "POST", "/api/verbs/ban", { headers: bearer(token), body: { agentId, reason: "x" } });
    expect(denied).toMatchObject({ status: 403, body: { code: "forbidden" } });
  });

  it("calls stamp lastSeenAt; an offline visitor's call brings it back; /api/agents/me/digest", async () => {
    const before = ctx.world.agents.require(agentId).lastSeenAt;
    expect(before).toBeTruthy();
    ctx.world.presence.sweep(new Date(Date.now() + 120_000));
    expect(ctx.world.agents.require(agentId).status).toBe("offline");
    // the snapshot carries status and lastSeenAt
    const town = await json<{ agents: { id: string; status: string; lastSeenAt: string | null }[] }>(ctx.app, "GET", "/api/town");
    expect(town.body.agents.find((a) => a.id === agentId)).toMatchObject({ status: "offline", lastSeenAt: before });
    // a human's message waits in the mailbox
    const sent = await json(ctx.app, "POST", `/api/agents/${agentId}/message`, { headers: ctx.auth, body: { text: "ping" } });
    expect(sent.body).toMatchObject({ mode: "queued" });
    const detail = await json(ctx.app, "GET", `/api/agents/${agentId}`, { headers: ctx.auth });
    expect(detail.body.mailbox).toEqual({ unread: 1, mentions: 0, offered: 0 });

    const look = await json<{ result: { notices: { digest?: unknown } } }>(ctx.app, "POST", "/api/verbs/look", { headers: bearer(token), body: {} });
    expect(ctx.world.agents.require(agentId).status).toBe("idle");
    const d = MailboxDigest.parse(look.body.result.notices.digest);
    expect(d).toMatchObject({ offlineSince: before, messages: 1, mentions: 0, assignmentsOffered: 0, meetingsMissed: [] });
    const viaGet = await json(ctx.app, "GET", "/api/agents/me/digest", { headers: bearer(token) });
    expect(viaGet).toMatchObject({ status: 200, body: d });
    expect((await json(ctx.app, "GET", "/api/agents/me/digest", { headers: ctx.auth })).status).toBe(403);
    const since = await json(ctx.app, "GET", `/api/agents/me/digest?since=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`, { headers: bearer(token) });
    expect(since.body).toMatchObject({ messages: 0 });
  });

  it("digest is null for an agent that was never offline", async () => {
    const t = ctx.world.ops.registerVisitor(ctx.seed.admin.id, { name: "Fresh" }).token;
    const r = await json(ctx.app, "GET", "/api/agents/me/digest", { headers: bearer(t) });
    expect(r).toEqual({ status: 200, body: null });
  });
});
