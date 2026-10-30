import { townRoleId, World } from "@muster-town/core";
import { existsSync, mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildApp } from "../src/app.ts";
import { Hub } from "../src/hub.ts";
import { json } from "./helpers.ts";

// docs/hosted-collectives.md step 1: one process, the Workshop at the root, hosted collectives at /<slug>/ with their own World.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const mountIn = (hub: () => Hub) => (w: World, row: { slug: string }, dir: string) =>
  buildApp({ world: w, webDist: false, prefix: `/${row.slug}`, exportDir: join(dir, "export"), runtime: null });

async function setup(dir = mkdtempSync(join(tmpdir(), "hub-"))) {
  const world = World.open(":memory:");
  const seed = world.seedDefaults({ adminName: "Mitchell" });
  world.town.set({ name: "Workshop Collective" });
  let hub!: Hub;
  hub = new Hub(dir, mountIn(() => hub));
  await hub.openAll();
  const app = await buildApp({ world, webDist: false, hub });
  cleanups.push(async () => { await app.close(); world.close(); });
  return { world, hub, app, dir, admin: { authorization: `Bearer ${seed.adminToken}` } };
}
const demo = { slug: "demo", name: "Demo Collective", goal: "Show the hub works" };

describe("the hub", () => {
  it("creates a hosted collective live and serves its own World at /demo/", async () => {
    const { app, admin, dir } = await setup();
    const made = await json(app, "POST", "/api/collectives", { headers: admin, body: demo });
    expect(made.status).toBe(201);
    expect(made.body.collective).toMatchObject({ slug: "demo", name: "Demo Collective", state: "active", url: "/demo/" });
    expect(existsSync(join(dir, "demo", "data", "town.db"))).toBe(true);
    expect(existsSync(join(dir, "demo", "collective.json"))).toBe(true);

    // two towns: the root is the Workshop, /demo is the new one
    expect((await json(app, "GET", "/api/town")).body.town.name).toBe("Workshop Collective");
    expect((await json(app, "GET", "/demo/api/town")).body.town.name).toBe("Demo Collective");
    expect((await json(app, "GET", "/demo/api/health")).body).toMatchObject({ ok: true, runtime: false });
    expect((await json(app, "GET", "/demo/api/health")).body.hosted).toBeUndefined();
    expect((await json(app, "GET", "/api/health")).body.hosted).toEqual({ count: 1 });
    expect((await json(app, "GET", "/demo/api/nope")).status).toBe(404);

    // tokens are per World: the Workshop admin's token means nothing at /demo
    expect((await json(app, "GET", "/api/me", { headers: admin })).status).toBe(200);
    expect((await json(app, "GET", "/demo/api/me", { headers: admin })).status).toBe(401);

    // the homepage list comes from the hub: Workshop first, then demo; the placeholder only while none exists
    const list = (await json(app, "GET", "/api/collectives")).body.collectives;
    expect(list.map((c: { slug: string; url: string }) => [c.slug, c.url])).toEqual([["workshop", "/workshop/"], ["demo", "/demo/"]]);
    expect((await app.inject("/")).body).toContain('data-preview="/demo/api/town"');
  });

  it("/demo/mcp and /demo/ws answer from the hosted World", async () => {
    const { app, admin, hub } = await setup();
    await json(app, "POST", "/api/collectives", { headers: admin, body: demo });
    expect((await json(app, "POST", "/demo/mcp", { body: {} })).status).toBe(401);
    const w = hub.world("demo")!;
    const mod = w.users.first("1=1")!;
    const agentToken = w.tokens.getOrCreate("agent", w.ops.ensureAvatar(mod.id).id);
    const init = await app.inject({ method: "POST", url: "/demo/mcp", headers: { authorization: `Bearer ${agentToken}`, accept: "application/json, text/event-stream", "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } } });
    expect(init.statusCode).toBe(200);
    expect(init.json().result.serverInfo.name).toBe("muster-town");

    await app.listen({ port: 0, host: "127.0.0.1" });
    const base = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const first = (path: string) => new Promise<{ type: string; town: { name: string } }>((res, rej) => {
      const ws = new WebSocket(base + path);
      ws.once("message", (m) => { res(JSON.parse(String(m))); ws.close(); });
      ws.once("error", rej);
    });
    expect((await first("/demo/ws")).town.name).toBe("Demo Collective");
    expect((await first("/ws")).town.name).toBe("Workshop Collective");
  });

  it("a collective's name in any capitalisation lands on its lowercase address", async () => {
    const { app, admin, hub } = await setup();
    await json(app, "POST", "/api/collectives", { headers: admin, body: { slug: "hollyville", name: "Hollyville", goal: "A town" } });
    const at = async (url: string) => { const r = await app.inject(url); return [r.statusCode, r.headers.location]; };
    expect(await at("/Hollyville/")).toEqual([301, "/hollyville/"]);
    expect(await at("/HOLLYVILLE/")).toEqual([301, "/hollyville/"]);
    expect(await at("/Hollyville")).toEqual([301, "/hollyville"]);
    expect(await at("/Hollyville/api/health?x=1")).toEqual([301, "/hollyville/api/health?x=1"]);
    expect((await json(app, "GET", "/hollyville/api/town")).body.town.name).toBe("Hollyville");
    // an unknown name, or the Workshop's own routes, are the Workshop's as before
    expect((await app.inject("/Nowhere/")).statusCode).not.toBe(301);
    expect((await json(app, "GET", "/API/health")).status).not.toBe(301);
    // a retired one too: its lowercase address shows the notice
    hub.retire("hollyville");
    expect(await at("/Hollyville/")).toEqual([301, "/hollyville/"]);
    expect((await app.inject("/hollyville/")).statusCode).toBe(410);
  });

  it("refuses reserved and taken slugs, and anyone but a town admin", async () => {
    const { app, admin, world } = await setup();
    const reserved = await json(app, "POST", "/api/collectives", { headers: admin, body: { ...demo, slug: "workshop" } });
    expect(reserved.status).toBe(400);
    expect(reserved.body.error).toMatch(/reserved/);
    expect((await json(app, "POST", "/api/collectives", { headers: admin, body: { ...demo, slug: "Bad Slug" } })).status).toBe(400);
    expect((await json(app, "POST", "/api/collectives", { headers: admin, body: demo })).status).toBe(201);
    const taken = await json(app, "POST", "/api/collectives", { headers: admin, body: { ...demo, name: "Other" } });
    expect(taken.status).toBe(409);
    expect(taken.body.error).toMatch(/taken/);

    const { user, token } = world.ops.createUser("Octo");
    world.permissions.grant({ kind: "user", id: user.id }, townRoleId("member"));
    expect((await json(app, "POST", "/api/collectives", { headers: { authorization: `Bearer ${token}` }, body: { ...demo, slug: "octo" } })).status).toBe(403);
    expect((await json(app, "POST", "/api/collectives", { body: { ...demo, slug: "anon" } })).status).toBe(401);
  });

  it("a restart opens the hub's collectives again from disk", async () => {
    const first = await setup();
    await json(first.app, "POST", "/api/collectives", { headers: first.admin, body: demo });
    await first.hub.close();
    const again = await setup(first.dir);
    expect(again.hub.count).toBe(1);
    expect((await json(again.app, "GET", "/demo/api/town")).body.town.name).toBe("Demo Collective");
  });
});
