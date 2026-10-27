import { buildingRoleId } from "@muster-town/core";
import { afterEach, describe, expect, it } from "vitest";
import { json, seededApp } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const LAB = "carbon-cycle";
const KRS = [
  { text: "A visitor can see today's spend on the banner", howToCheck: "Open the lab banner" },
  { text: "The board shows the lab's goal first", howToCheck: "Open the lab board" },
];

describe("grants routes", () => {
  it("manager drafts and proposes, a funder counters and funds, KRs and close; drafts stay private", async () => {
    const s = await seededApp();
    cleanups.push(s.close);
    const { world, app, auth } = s;
    const manager = world.agents.first("homeBuildingId = ? AND kind != 'human'", [LAB])!;
    world.permissions.grant(manager, buildingRoleId(LAB, "manager"));
    const mgr = { authorization: `Bearer ${world.tokens.getOrCreate("agent", manager.id)}` };
    const stranger = { authorization: `Bearer ${world.ops.createUser("Stranger").token}` };

    // goal key results: only a human with building.manage writes them
    expect((await json(app, "POST", `/api/buildings/${LAB}/key-results`, { headers: mgr, body: KRS[0] })).status).toBe(403);
    expect((await json(app, "POST", `/api/buildings/${LAB}/key-results`, { headers: stranger, body: KRS[0] })).status).toBe(403);
    const krs: string[] = [];
    for (const k of KRS) {
      const r = await json(app, "POST", `/api/buildings/${LAB}/key-results`, { headers: auth, body: k });
      expect(r.status).toBe(201);
      krs.push(r.body.keyResult.id);
    }
    expect((await json(app, "GET", `/api/buildings/${LAB}/key-results`)).body).toMatchObject({ blocked: null, keyResults: [{ id: krs[0], grantId: null }, { id: krs[1] }] });
    expect((await json(app, "GET", `/api/buildings/${LAB}`)).body).toMatchObject({ blocked: null, keyResults: [{ id: krs[0] }, { id: krs[1] }] });

    // create: needs auth and building.manage; bad input is a 400; it names one goal key result
    const body = { keyResultId: krs[0], objective: "Visitors can tell what the lab is for", approach: "a banner line", stopCondition: "two failed tries", askTokens: 10_000_000, testingPlan: KRS };
    expect((await json(app, "POST", `/api/buildings/${LAB}/grants`, { body })).status).toBe(401);
    expect((await json(app, "POST", `/api/buildings/${LAB}/grants`, { headers: stranger, body })).status).toBe(403);
    expect((await json(app, "POST", `/api/buildings/${LAB}/grants`, { headers: mgr, body: { ...body, keyResultId: undefined } })).status).toBe(400);
    expect((await json(app, "POST", `/api/buildings/${LAB}/grants`, { headers: mgr, body: { ...body, keyResultId: "kr_nope" } })).status).toBe(400);
    const created = await json(app, "POST", `/api/buildings/${LAB}/grants`, { headers: mgr, body });
    expect(created.status).toBe(201);
    const id = created.body.grant.id as string;
    expect(created.body.grant).toMatchObject({ status: "draft", spentTokens: 0, keyResultId: krs[0], keyResult: { id: krs[0] }, approach: "a banner line", testingPlan: KRS });

    // drafts: hidden from the public, visible to the manager and funders
    expect((await json(app, "GET", `/api/buildings/${LAB}/grants`)).body.grants).toHaveLength(0);
    expect((await json(app, "GET", `/api/buildings/${LAB}/grants`, { headers: stranger })).body.grants).toHaveLength(0);
    expect((await json(app, "GET", `/api/buildings/${LAB}/grants`, { headers: mgr })).body.grants).toHaveLength(1);
    expect((await json(app, "GET", `/api/grants/${id}`)).status).toBe(404);
    expect((await json(app, "GET", `/api/grants/${id}`, { headers: auth })).status).toBe(200);

    const edited = await json(app, "PATCH", `/api/grants/${id}`, { headers: mgr, body: { askTokens: 8_000_000 } });
    expect(edited.body.grant.askTokens).toBe(8_000_000);
    const proposed = await json(app, "POST", `/api/grants/${id}/propose`, { headers: mgr });
    expect(proposed.status).toBe(200);
    expect(proposed.body.grant.status).toBe("proposed");
    expect((await json(app, "GET", `/api/grants/${id}`)).body.grant.status).toBe("proposed");

    // the board carries the goal, the open proposals and the exploration allowance
    const board = await json(app, "GET", `/api/buildings/${LAB}/board`);
    expect(board.status).toBe(200);
    expect(board.body).toHaveProperty("docs");
    expect(board.body.goal).toBe(world.buildings.require(LAB, "building").goal);
    expect(board.body.proposals.map((p: { id: string }) => p.id)).toEqual([id]);
    expect(board.body.grants).toEqual([]);
    expect(board.body.exploration).toMatchObject({ spentTodayTokens: 0 });

    // decide: building.fund only (agents never have it); a counter needs a note
    expect((await json(app, "POST", `/api/grants/${id}/decide`, { headers: mgr, body: { action: "fund" } })).status).toBe(403);
    expect((await json(app, "POST", `/api/grants/${id}/decide`, { headers: auth, body: { action: "counter" } })).status).toBe(400);
    expect((await json(app, "POST", `/api/grants/${id}/decide`, { headers: auth, body: { action: "nope" } })).status).toBe(400);
    const countered = await json(app, "POST", `/api/grants/${id}/decide`, { headers: auth, body: { action: "counter", tokens: 5_000_000, note: "half" } });
    expect(countered.body.grant).toMatchObject({ status: "countered", askTokens: 5_000_000 });
    await json(app, "POST", `/api/grants/${id}/propose`, { headers: mgr, body: { note: "ok, half" } });
    const funded = await json(app, "POST", `/api/grants/${id}/decide`, { headers: auth, body: { action: "fund" } });
    expect(funded.body.grant).toMatchObject({ status: "funded", grantTokens: 5_000_000 });
    expect((await json(app, "POST", `/api/grants/${id}/decide`, { headers: auth, body: { action: "fund" } })).status).toBe(409);
    expect((await json(app, "GET", `/api/buildings/${LAB}/grants?status=funded`)).body.grants.map((g: any) => g.id)).toEqual([id]);
    expect((await json(app, "GET", `/api/buildings/${LAB}/board`)).body).toMatchObject({ proposals: [], grants: [{ id }] });

    expect((await json(app, "GET", `/api/buildings/${LAB}/board`)).body.keyResults[0]).toMatchObject({ id: krs[0], grantId: id });
    expect((await json(app, "DELETE", `/api/key-results/${krs[0]}`, { headers: auth })).status).toBe(409);

    // key results: the manager claims, only a funder marks met
    const kr = funded.body.grant.keyResult.id as string;
    const claimed = await json(app, "PATCH", `/api/key-results/${kr}`, { headers: mgr, body: { status: "claimed", note: "see the banner" } });
    expect(claimed.body.keyResult).toMatchObject({ status: "claimed", statusNote: "see the banner" });
    expect((await json(app, "PATCH", `/api/key-results/${kr}`, { headers: mgr, body: { status: "met" } })).status).toBe(403);
    expect((await json(app, "PATCH", `/api/key-results/${kr}`, { headers: auth, body: { status: "met" } })).body.keyResult.status).toBe("met");

    // close: the manager only as "stopped"; a funder any outcome
    expect((await json(app, "POST", `/api/grants/${id}/close`, { headers: mgr, body: { outcome: "met" } })).status).toBe(403);
    const closed = await json(app, "POST", `/api/grants/${id}/close`, { headers: auth, body: { outcome: "met", note: "done" } });
    expect(closed.body.grant).toMatchObject({ status: "closed", outcome: "met" });
    expect((await json(app, "POST", `/api/grants/${id}/close`, { headers: auth, body: { outcome: "met" } })).status).toBe(409);

    // the goal's last key results go: the building is blocked, on GET /api/buildings/:id and the Town Hall in-tray
    expect((await json(app, "DELETE", `/api/key-results/${krs[1]}`, { headers: mgr })).status).toBe(403);
    for (const k of krs) expect((await json(app, "DELETE", `/api/key-results/${k}`, { headers: auth })).status).toBe(200);
    expect((await json(app, "GET", `/api/buildings/${LAB}`)).body).toMatchObject({ blocked: "blocked: no key results to work toward", keyResults: [] });
    expect((await json(app, "GET", `/api/buildings/town-hall/intray`)).body.blocked).toEqual([expect.objectContaining({ buildingId: LAB })]);

    expect((await json(app, "GET", `/api/grants/gr_missing`)).status).toBe(404);
    expect((await json(app, "GET", `/api/buildings/nowhere/grants`)).status).toBe(404);
  });
});
