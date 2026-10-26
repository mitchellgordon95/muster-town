import { townRoleId } from "@muster-town/core";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { json, seededApp } from "./helpers.ts";

// Who may interact (dc_f0cumcfubk): a signed-in visitor reads, asks to join, and an admin lets them in from the Town Hall in-tray.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
async function setup() {
  const s = await seededApp();
  cleanups.push(s.close);
  const { user, token } = s.world.ops.createUser("Octo");
  s.world.permissions.grant({ kind: "user", id: user.id }, townRoleId("visitor"));
  const th = s.world.buildings.first("kind = 'town-hall'")!;
  return { ...s, user, visitor: { authorization: `Bearer ${token}` }, th };
}

describe("who may interact", () => {
  it("a visitor reads but every write is 403 until let in; a member writes", async () => {
    const { app, world, visitor, user, by } = await setup();
    const agent = by("Tomas");
    expect((await json(app, "GET", "/api/town", { headers: visitor })).status).toBe(200);
    const me = await json(app, "GET", "/api/me", { headers: visitor });
    expect(me.body).toMatchObject({ canInteract: false, accessRequest: null, isAdmin: false });

    const msg = await json(app, "POST", `/api/agents/${agent.id}/message`, { headers: visitor, body: { text: "hi" } });
    expect(msg.status).toBe(403);
    expect(msg.body.error).toMatch(/Ask for access first/);
    expect((await json(app, "POST", "/api/docs", { headers: visitor, body: { title: "x", body: "y" } })).status).toBe(403);
    expect((await json(app, "POST", "/api/agents/visitors", { headers: visitor, body: { name: "Octo's Claude" } })).status).toBe(403);
    expect((await json(app, "POST", "/auth/logout", { headers: visitor })).status).toBe(200);

    world.permissions.grant({ kind: "user", id: user.id }, townRoleId("member"));
    expect((await json(app, "GET", "/api/me", { headers: visitor })).body.canInteract).toBe(true);
    expect((await json(app, "POST", "/api/docs", { headers: visitor, body: { title: "x", body: "y" } })).status).toBe(201);
  });

  it("a bring-your-own agent of a visitor is gated by its owner; residents are not", async () => {
    const { app, world, user, by } = await setup();
    world.permissions.grant({ kind: "user", id: user.id }, townRoleId("member"));
    const reg = await json(app, "POST", "/api/agents/visitors", { headers: { authorization: `Bearer ${world.tokens.getOrCreate("user", user.id)}` }, body: { name: "Octo's Claude", buildingId: "carbon-cycle" } });
    expect(reg.status).toBe(201);
    world.permissions.revoke({ kind: "user", id: user.id }, townRoleId("member"));
    const byoa = { authorization: `Bearer ${reg.body.token}` };
    expect((await json(app, "POST", "/api/verbs/say", { headers: byoa, body: { text: "hello" } })).status).toBe(403);
    const resident = { authorization: `Bearer ${world.tokens.getOrCreate("agent", by("Tomas").id)}` };
    expect((await json(app, "POST", "/api/verbs/say", { headers: resident, body: { text: "hello" } })).status).toBe(200);
  });

  it("ask → Town Hall in-tray row and badge → Let in → canInteract", async () => {
    const { app, auth, visitor, th } = await setup();
    const before = (await json(app, "GET", `/api/buildings/${th.id}`)).body.building.intray as number;
    const asked = await json(app, "POST", "/api/access-requests", { headers: visitor, body: { message: "  help with the onboarding  " } });
    expect(asked.status).toBe(200);
    expect(asked.body.accessRequest).toMatchObject({ status: "pending", message: "help with the onboarding" });
    const again = await json(app, "POST", "/api/access-requests", { headers: visitor, body: {} });
    expect(again.body.accessRequest.id).toBe(asked.body.accessRequest.id);
    expect((await json(app, "GET", "/api/me", { headers: visitor })).body.accessRequest).toMatchObject({ status: "pending" });

    const tray = await json(app, "GET", `/api/buildings/${th.id}/intray`, { headers: auth });
    expect(tray.body.access).toHaveLength(1);
    expect(tray.body.access[0]).toMatchObject({ name: "Octo", message: "help with the onboarding" });
    expect((await json(app, "GET", `/api/buildings/${th.id}`)).body.building.intray).toBe(before + 1);

    const id = asked.body.accessRequest.id;
    expect((await json(app, "POST", `/api/access-requests/${id}/decide`, { headers: visitor, body: { grant: true } })).status).toBe(403);
    const ok = await json(app, "POST", `/api/access-requests/${id}/decide`, { headers: auth, body: { grant: true } });
    expect(ok.status).toBe(200);
    expect(ok.body.accessRequest.status).toBe("granted");
    expect((await json(app, "POST", `/api/access-requests/${id}/decide`, { headers: auth, body: { grant: false } })).status).toBe(409);
    expect((await json(app, "GET", "/api/me", { headers: visitor })).body).toMatchObject({ canInteract: true, accessRequest: { status: "granted" } });
    expect((await json(app, "GET", `/api/buildings/${th.id}/intray`, { headers: auth })).body.access).toHaveLength(0);
    expect((await json(app, "POST", "/api/access-requests", { headers: visitor, body: {} })).status).toBe(409);
  });

  it("decline: still read-only, and asking again waits a day", async () => {
    const { app, auth, visitor } = await setup();
    const asked = await json(app, "POST", "/api/access-requests", { headers: visitor, body: {} });
    const no = await json(app, "POST", `/api/access-requests/${asked.body.accessRequest.id}/decide`, { headers: auth, body: { grant: false } });
    expect(no.body.accessRequest.status).toBe("declined");
    expect((await json(app, "GET", "/api/me", { headers: visitor })).body).toMatchObject({ canInteract: false, accessRequest: { status: "declined" } });
    const soon = await json(app, "POST", "/api/access-requests", { headers: visitor, body: {} });
    expect(soon.status).toBe(409);
    expect(soon.body.error).toMatch(/Not this time/);
  });

  it("WS: a visitor's move gets an error frame", async () => {
    const { app, visitor } = await setup();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: visitor });
    const msgs: any[] = [];
    ws.on("message", (d) => msgs.push(JSON.parse(String(d))));
    const waitFor = async (pred: (m: any) => boolean) => {
      for (let i = 0; i < 100; i++) { const m = msgs.find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 20)); }
      throw new Error("timeout");
    };
    expect((await waitFor((m) => m.type === "snapshot")).avatarAgentId).toMatch(/^ag_/);
    ws.send(JSON.stringify({ type: "human.move", x: 1, y: 1 }));
    expect((await waitFor((m) => m.type === "error")).message).toMatch(/Ask for access first/);
    ws.close();
  });
});
