/**
 * act_in_1on1 over the API (gr_kdlogzzo5s step 1): a human opens a 1:1 and says a decision; the agent's verb call does it
 * as the human (GET /api/grants/:id history shows the human with the "via" note). A human without building.fund is
 * refused by the verb as by the button; stop is refused.
 */
import { buildingRoleId, grantDirect, townRoleId } from "@muster-town/core";
import { afterEach, describe, expect, it } from "vitest";
import { json, seededApp } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const LAB = "carbon-cycle";

describe("act_in_1on1 route", () => {
  it("does what the human said in their 1:1, as them; their gate applies; stop is refused", async () => {
    const s = await seededApp();
    cleanups.push(s.close);
    const { world, app, auth, by } = s;
    const mei = by("Mei");
    world.ops.updateBuilding(world.ops.ensureAvatar(s.seed.admin.id), LAB, { managerAgentId: mei.id });
    world.permissions.grant(mei, buildingRoleId(LAB, "manager"));
    const agent = { authorization: `Bearer ${world.tokens.getOrCreate("agent", mei.id)}` };
    const created = await json(app, "POST", `/api/buildings/${LAB}/grants`, { headers: agent, body: { title: "Lab banner for guests", objective: "A banner", approach: "a", steps: [{ size: "M", title: "Step 1", description: "Do the work" }], stopCondition: "s", askTokens: 400_000, keyResults: [{ text: "banner", howToCheck: "look" }] } });
    const id = created.body.grant.id as string;
    expect((await json(app, "POST", `/api/grants/${id}/propose`, { headers: agent })).status).toBe(200);

    // a member who may direct work here but can't fund: the verb refuses as the button does
    const ana = world.ops.createUser("Ana");
    world.permissions.grant({ kind: "user", id: ana.user.id }, townRoleId("member"));
    grantDirect(world, world.ops.ensureAvatar(s.seed.admin.id), ana.user.id, world.goalTree.attachmentOf(LAB));
    const anaAuth = { authorization: `Bearer ${ana.token}` };
    const am = (await json(app, "POST", `/api/buildings/${LAB}/one-on-one`, { headers: anaAuth })).body.meeting;
    const anaSaid = (await json(app, "POST", `/api/meetings/${am.id}/say`, { headers: anaAuth, body: { text: `fund ${id}` } })).body.meeting.transcript.at(-1).at;
    expect((await json(app, "POST", `/api/grants/${id}/decide`, { headers: anaAuth, body: { action: "fund" } })).status).toBe(403);
    expect((await json(app, "POST", "/api/verbs/act_in_1on1", { headers: agent, body: { meetingId: am.id, utteranceAt: anaSaid, action: "fund", targetId: id } })).status).toBe(403);

    // the admin's 1:1: fund at 600k as said
    const m = (await json(app, "POST", `/api/buildings/${LAB}/one-on-one`, { headers: auth })).body.meeting;
    const said = (await json(app, "POST", `/api/meetings/${m.id}/say`, { headers: auth, body: { text: `fund ${id} at 600k` } })).body.meeting.transcript.at(-1).at;
    expect((await json(app, "POST", "/api/verbs/act_in_1on1", { headers: agent, body: { meetingId: m.id, utteranceAt: said, action: "stop", targetId: id } })).status).toBe(403);
    const r = await json(app, "POST", "/api/verbs/act_in_1on1", { headers: agent, body: { meetingId: m.id, utteranceAt: said, action: "fund", targetId: id, tokens: 600_000 } });
    expect(r.status).toBe(200);
    const g = (await json(app, "GET", `/api/grants/${id}`, { headers: auth })).body.grant;
    expect(g).toMatchObject({ status: "funded", grantTokens: 600_000 });
    expect(g.history.at(-1)).toMatchObject({ action: "fund", byId: s.seed.admin.id, byKind: "user", viaAgentId: mei.id, viaMeetingId: m.id });
    expect(g.history.at(-1).note).toContain(`via Mei in ${m.id}: "fund ${id} at 600k"`);
  });

  it("declines an outbox request as the human; the author withdraws its own over REST", async () => {
    const s = await seededApp();
    cleanups.push(s.close);
    const { world, app, auth, by } = s;
    const mei = by("Mei");
    const ingrid = by("Ingrid");
    world.ops.updateBuilding(world.ops.ensureAvatar(s.seed.admin.id), LAB, { managerAgentId: mei.id });
    world.permissions.grant(mei, buildingRoleId(LAB, "manager"));
    const agent = { authorization: `Bearer ${world.tokens.getOrCreate("agent", mei.id)}` };
    const ingridAuth = { authorization: `Bearer ${world.tokens.getOrCreate("agent", ingrid.id)}` };
    const a = (await json(app, "POST", "/api/verbs/request_human", { headers: ingridAuth, body: { title: "Drill v1", body: "x" } })).body.result;
    const b = (await json(app, "POST", "/api/verbs/request_human", { headers: ingridAuth, body: { title: "Topics", body: "y" } })).body.result;
    const aId = a.id as string;
    const bId = b.id as string;
    // withdraw: the author over the request route, with the note in `note`
    const w = await json(app, "POST", `/api/docs/${aId}/request`, { headers: ingridAuth, body: { action: "withdraw", note: "Replaced." } });
    expect(w.status).toBe(200);
    expect(w.body.doc).toMatchObject({ requestStatus: "withdrawn", requestNote: "Replaced." });
    // decline through the Secretary-style 1:1
    const m = (await json(app, "POST", `/api/buildings/${LAB}/one-on-one`, { headers: auth })).body.meeting;
    const said = (await json(app, "POST", `/api/meetings/${m.id}/say`, { headers: auth, body: { text: `decline ${bId}` } })).body.meeting.transcript.at(-1).at;
    const r = await json(app, "POST", "/api/verbs/act_in_1on1", { headers: agent, body: { meetingId: m.id, utteranceAt: said, action: "decline", targetId: bId } });
    expect(r.status).toBe(200);
    const d = (await json(app, "GET", `/api/docs/${bId}`, { headers: auth })).body.doc;
    expect(d).toMatchObject({ requestStatus: "declined", requestDecidedById: s.seed.admin.id, requestViaAgentId: mei.id, requestViaMeetingId: m.id });
    expect(d.requestNote).toContain(`via Mei in ${m.id}: "decline ${bId}"`);
    expect((await json(app, "GET", "/api/docs?type=request", { headers: auth })).body.docs.map((x: { requestStatus: string }) => x.requestStatus).sort()).toEqual(["declined", "withdrawn"]);
  });
});
