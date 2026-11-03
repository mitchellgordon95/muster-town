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
    const connect = await json(app, "POST", "/api/agents/visitors", { headers: visitor, body: { name: "Octo's Claude" } });
    expect(connect.status).toBe(403);
    expect(connect.body.error).toMatch(/Ask for access first/);
    expect(world.agents.first("name = ?", ["Octo's Claude"])).toBeUndefined();
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
    const pending = (await json(app, "GET", "/api/me", { headers: visitor })).body.accessRequest;
    // the pending card names who decides and promises no wait before the first decision
    expect(pending).toMatchObject({ status: "pending", typicalWaitMs: null });
    expect(pending.deciders.length).toBeGreaterThan(0);

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
    expect((await json(app, "GET", "/api/me", { headers: visitor })).body.accessRequest.typicalWaitMs).toBeGreaterThanOrEqual(0);
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

  it("GET /api/access-requests: pending rows for an admin only (the HUD notice)", async () => {
    const { app, world, auth, visitor, by } = await setup();
    await json(app, "POST", "/api/access-requests", { headers: visitor, body: { message: "hi" } });
    expect((await json(app, "GET", "/api/access-requests")).status).toBe(401);
    expect((await json(app, "GET", "/api/access-requests", { headers: visitor })).status).toBe(403);
    const resident = { authorization: `Bearer ${world.tokens.getOrCreate("agent", by("Tomas").id)}` };
    expect((await json(app, "GET", "/api/access-requests", { headers: resident })).status).toBe(403);
    const list = await json(app, "GET", "/api/access-requests", { headers: auth });
    expect(list.status).toBe(200);
    expect(list.body.access).toHaveLength(1);
    expect(list.body.access[0]).toMatchObject({ name: "Octo", status: "pending", message: "hi" });
    await json(app, "POST", `/api/access-requests/${list.body.access[0].id}/decide`, { headers: auth, body: { grant: false } });
    expect((await json(app, "GET", "/api/access-requests", { headers: auth })).body.access).toHaveLength(0);
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

  it("join funnel: a public GET with the shape; the guest card's view ping works for a guest and a visitor", async () => {
    const { app, auth, visitor } = await setup();
    const before = (await json(app, "GET", "/api/join-funnel")).body;
    expect(before).toMatchObject({ days: 30, totals: { guestCardViews: expect.any(Number), signIns: expect.any(Number), asked: expect.any(Number), letIn: expect.any(Number), declined: expect.any(Number), acted: expect.any(Number) } });
    expect(before.collectives).toHaveLength(1);
    expect((await json(app, "POST", "/api/join-funnel/view")).status).toBe(200);
    expect((await json(app, "POST", "/api/join-funnel/view", { headers: visitor })).status).toBe(200);
    const asked = await json(app, "POST", "/api/access-requests", { headers: visitor, body: {} });
    await json(app, "POST", `/api/access-requests/${asked.body.accessRequest.id}/decide`, { headers: auth, body: { grant: false } });
    const after = (await json(app, "GET", "/api/join-funnel")).body;
    expect(after.totals.guestCardViews).toBe(before.totals.guestCardViews + 2);
    expect(after.totals.asked).toBe(before.totals.asked + 1);
    expect(after.totals.declined).toBe(before.totals.declined + 1);
    expect(after.decisions).toBe(before.decisions + 1);
    expect(after.medianDecisionMs).toEqual(expect.any(Number));
    expect(after.collectives[0].totals).toEqual(after.totals);
  });
});

describe("direct work under <goal> (gr_cuobjlny6r, Mitchell mt_hlizi9wxxc decision 1)", () => {
  it("direct work permission gates 1:1s, meetings and directed sources", async () => {
    const { app, world, auth, visitor, by, seed } = await setup();
    const admin = world.ops.ensureAvatar(seed.admin.id);
    const mei = by("Mei");
    world.ops.updateBuilding(admin, "carbon-cycle", { managerAgentId: mei.id });
    const goal = world.goalTree.create(null, { parentId: "gl_town", text: "Carbon goal" }).id;
    world.goalTree.attach(null, "carbon-cycle", goal);
    const other = world.ops.createBuilding(admin, { name: "Other lab" });
    world.goalTree.attach(null, other.id, world.goalTree.create(null, { parentId: "gl_town", text: "Other goal" }).id);
    world.agents.patch(by("Noor").id, { homeBuildingId: other.id, buildingId: other.id });
    world.ops.updateBuilding(admin, other.id, { managerAgentId: by("Noor").id });

    // Let in + direct work in one call: two events; /api/me lists the goal
    const asked = await json(app, "POST", "/api/access-requests", { headers: visitor, body: {} });
    const funnel0 = (await json(app, "GET", "/api/join-funnel")).body.totals;
    expect((await json(app, "POST", `/api/access-requests/${asked.body.accessRequest.id}/decide`, { headers: auth, body: { grant: true, directGoalId: goal } })).status).toBe(200);
    const texts = world.events.recent({ limit: 10 }).map((e) => e.text);
    expect(texts.some((t) => /Octo was let in as a member/.test(t))).toBe(true);
    expect(texts.some((t) => /may direct work under "Carbon goal"/.test(t))).toBe(true);
    expect((await json(app, "GET", "/api/me", { headers: visitor })).body.direct).toEqual([{ goalId: goal, text: "Carbon goal", how: "granted" }]);
    // the web's Talk gate: the buildings where canDirect holds (never the Town Hall)
    expect((await json(app, "GET", "/api/me", { headers: visitor })).body.directBuildingIds).toContain("carbon-cycle");
    expect((await json(app, "GET", "/api/me", { headers: visitor })).body.directBuildingIds).not.toContain("town-hall");
    expect((await json(app, "GET", "/api/me", { headers: auth })).body.directDefaultGoalId).toEqual(expect.any(String));

    // a plain Let in grants nothing: no 1:1, no meeting (403)
    const pat = world.ops.createUser("Pat");
    world.permissions.grant({ kind: "user", id: pat.user.id }, townRoleId("visitor"));
    const patH = { authorization: `Bearer ${pat.token}` };
    const patAsk = await json(app, "POST", "/api/access-requests", { headers: patH, body: {} });
    await json(app, "POST", `/api/access-requests/${patAsk.body.accessRequest.id}/decide`, { headers: auth, body: { grant: true } });
    expect((await json(app, "GET", "/api/me", { headers: patH })).body).toMatchObject({ canInteract: true, direct: [], directBuildingIds: [] });
    const refused = await json(app, "POST", "/api/buildings/carbon-cycle/one-on-one", { headers: patH, body: {} });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/direct work under/);
    expect((await json(app, "POST", "/api/meetings", { headers: patH, body: { kind: "standup", buildingId: "carbon-cycle" } })).status).toBe(403);

    // the holder: inside the subtree a 1:1 (and a meeting); outside it refused
    const mine = await json(app, "POST", "/api/buildings/carbon-cycle/one-on-one", { headers: visitor, body: {} });
    expect(mine.status).toBe(200);
    expect(mine.body.meeting).toMatchObject({ kind: "one-on-one", facilitatorId: mei.id });
    expect((await json(app, "POST", "/api/meetings", { headers: visitor, body: { kind: "standup", buildingId: "carbon-cycle" } })).status).toBe(201);
    expect((await json(app, "POST", `/api/buildings/${other.id}/one-on-one`, { headers: visitor, body: {} })).status).toBe(403);
    // their first 1:1 line still counts as acted, once
    expect((await json(app, "POST", `/api/meetings/${mine.body.meeting.id}/say`, { headers: visitor, body: { text: "Hi, what can I do here?" } })).status).toBe(200);
    await json(app, "POST", `/api/meetings/${mine.body.meeting.id}/say`, { headers: visitor, body: { text: "And next?" } });
    expect((await json(app, "GET", "/api/join-funnel")).body.totals.acted).toBe(funnel0.acted + 1);

    // directed sources: the holder's 1:1 is one in carbon-cycle, not in the other lab; a non-holder's tell or old 1:1 is refused
    const task = { agentId: mei.id, title: "t", description: "d", lane: "directed" as const };
    expect((await world.verbs.assign(mei, { ...task, sourceId: mine.body.meeting.id })).assignmentId).toMatch(/^as_/);
    await expect(world.verbs.assign(by("Noor"), { ...task, agentId: by("Noor").id, sourceId: mine.body.meeting.id })).rejects.toThrow(/may direct work/);
    const patAvatar = world.ops.ensureAvatar(pat.user.id);
    await world.verbs.tell(patAvatar, { to: mei.id, text: "please build X" });
    const patTell = world.messages.first("fromId = ? AND kind = 'tell'", [patAvatar.id], "ORDER BY createdAt DESC, rowid DESC")!;
    await expect(world.verbs.assign(mei, { ...task, sourceId: patTell.id })).rejects.toThrow(/Pat may not direct work in/);
    const legacy = world.meetings.upsert({ ...mine.body.meeting, id: "mt_legacy0001", withUserId: pat.user.id, transcript: [{ speakerId: pat.user.id, speakerKind: "user", text: "build X", at: new Date().toISOString() }] });
    await expect(world.verbs.assign(mei, { ...task, sourceId: legacy.id })).rejects.toThrow(/No human in meeting/);

    // grant later (admin), not by a plain member; GET /api/members lists them; revoke closes it again
    expect((await json(app, "POST", `/api/members/${pat.user.id}/direct`, { headers: visitor, body: { goalId: goal } })).status).toBe(403);
    expect((await json(app, "GET", "/api/members", { headers: patH })).status).toBe(403);
    expect((await json(app, "POST", `/api/members/${pat.user.id}/direct`, { headers: auth, body: { goalId: goal } })).status).toBe(200);
    expect((await json(app, "POST", "/api/buildings/carbon-cycle/one-on-one", { headers: patH, body: {} })).status).toBe(200);
    expect((await world.verbs.assign(mei, { ...task, sourceId: patTell.id })).assignmentId).toMatch(/^as_/);
    const members = (await json(app, "GET", "/api/members", { headers: auth })).body.members as { userId: string; letInAt: string | null; direct: { goalId: string }[] }[];
    expect(members.find((m) => m.userId === pat.user.id)).toMatchObject({ letInAt: expect.any(String), direct: [{ goalId: goal, text: "Carbon goal" }] });
    expect((await json(app, "DELETE", `/api/members/${pat.user.id}/direct`, { headers: auth, body: { goalId: goal } })).body).toEqual({ removed: true });
    expect(world.events.recent({ limit: 3 }).some((e) => /Pat may no longer direct work under "Carbon goal"/.test(e.text))).toBe(true);
    expect((await json(app, "POST", "/api/buildings/carbon-cycle/one-on-one", { headers: patH, body: {} })).status).toBe(403);
    expect((await json(app, "GET", "/api/me", { headers: patH })).body.direct).toEqual([]);
  });
});
