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

    // goal key results are gone: key results belong to grants (docs/how-work-gets-done.md §4)
    expect((await json(app, "POST", `/api/buildings/${LAB}/key-results`, { headers: auth, body: KRS[0] })).status).toBe(404);

    // create: needs auth and building.manage; bad input is a 400; it carries its own 1-5 key results
    const steps = [{ title: "Ship the banner", description: "One PR" }, { title: "Check it live", description: "Open the lab", model: "nope-model" }];
    const body = { objective: "Visitors can tell what the lab is for", approach: "a banner line", steps: [steps[0]!, { title: steps[1]!.title, description: steps[1]!.description }], stopCondition: "two failed tries", askTokens: 10_000_000, keyResults: KRS };
    // grant B (gr_b5fyqibfx2): a proposal carries 1-5 steps, each on a model the building's forks run
    const { steps: _none, ...noSteps } = body;
    expect((await json(app, "POST", `/api/buildings/${LAB}/grants`, { headers: mgr, body: noSteps })).status).toBe(400);
    expect((await json(app, "POST", `/api/buildings/${LAB}/grants`, { headers: mgr, body: { ...body, steps: [] } })).status).toBe(400);
    expect((await json(app, "POST", `/api/buildings/${LAB}/grants`, { headers: mgr, body: { ...body, steps } })).status).toBe(400);
    expect((await json(app, "POST", `/api/buildings/${LAB}/grants`, { body })).status).toBe(401);
    expect((await json(app, "POST", `/api/buildings/${LAB}/grants`, { headers: stranger, body })).status).toBe(403);
    expect((await json(app, "POST", `/api/buildings/${LAB}/grants`, { headers: mgr, body: { ...body, keyResults: [] } })).status).toBe(400);
    expect((await json(app, "POST", `/api/buildings/${LAB}/grants`, { headers: mgr, body: { ...body, goalId: "gl_nope" } })).status).toBe(400);
    const created = await json(app, "POST", `/api/buildings/${LAB}/grants`, { headers: mgr, body });
    expect(created.status).toBe(201);
    const id = created.body.grant.id as string;
    expect(created.body.grant).toMatchObject({ status: "draft", spentTokens: 0, approach: "a banner line", keyResults: KRS.map((k) => ({ ...k, grantId: id })) });
    const krs: string[] = created.body.grant.keyResults.map((k: { id: string }) => k.id);

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
    // what it is likely to cost (core grant-estimate.ts): recorded at propose, served signed out with the grant
    const pub = await json(app, "GET", `/api/grants/${id}`);
    expect(pub.body.grant.estimate).toMatchObject({ askTokens: 8_000_000, sample: expect.any(Number), similar: expect.any(Array) });
    expect(pub.body.grant.estimate.sentence).toMatch(/^ask 8,000,000 · /);
    expect((await json(app, "GET", `/api/grants/${id}`)).body.grant.status).toBe("proposed");
    expect(pub.body.grant.steps).toEqual([{ title: "Ship the banner", description: "One PR" }, { title: "Check it live", description: "Open the lab" }]);

    // the board carries the goal, the open proposals and the exploration allowance
    const board = await json(app, "GET", `/api/buildings/${LAB}/board`);
    expect(board.status).toBe(200);
    expect(board.body).toHaveProperty("docs");
    expect(board.body.goal).toBe(world.goalTree.purposeOf(world.buildings.require(LAB, "building")));
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
    // grant C: a funded grant holds at its tokens minus min(150k, a third), served with the grant
    expect((await json(app, "GET", `/api/grants/${id}`)).body.grant.holdAtTokens).toBe(4_850_000);
    expect((await json(app, "POST", `/api/grants/${id}/decide`, { headers: auth, body: { action: "fund" } })).status).toBe(409);
    expect((await json(app, "GET", `/api/buildings/${LAB}/grants?status=funded`)).body.grants.map((g: any) => g.id)).toEqual([id]);
    expect((await json(app, "GET", `/api/buildings/${LAB}/board`)).body).toMatchObject({ proposals: [], grants: [{ id }] });

    expect((await json(app, "GET", `/api/buildings/${LAB}/board`)).body.keyResults[0]).toMatchObject({ id: krs[0], grantId: id });
    expect((await json(app, "DELETE", `/api/key-results/${krs[0]}`, { headers: auth })).status).toBe(409);

    // key results: the manager claims, only a funder marks met
    const kr = funded.body.grant.keyResults[0].id as string;
    const claimed = await json(app, "PATCH", `/api/key-results/${kr}`, { headers: mgr, body: { status: "claimed", note: "see the banner" } });
    expect(claimed.body.keyResult).toMatchObject({ status: "claimed", statusNote: "see the banner" });
    expect((await json(app, "PATCH", `/api/key-results/${kr}`, { headers: mgr, body: { status: "met" } })).status).toBe(403);
    expect((await json(app, "PATCH", `/api/key-results/${kr}`, { headers: auth, body: { status: "met" } })).body.keyResult.status).toBe("met");

    // close: the manager only as "stopped"; a funder any outcome
    expect((await json(app, "POST", `/api/grants/${id}/close`, { headers: mgr, body: { outcome: "met" } })).status).toBe(403);
    const closed = await json(app, "POST", `/api/grants/${id}/close`, { headers: auth, body: { outcome: "met", note: "done" } });
    expect(closed.body.grant).toMatchObject({ status: "closed", outcome: "met" });
    expect((await json(app, "POST", `/api/grants/${id}/close`, { headers: auth, body: { outcome: "met" } })).status).toBe(409);

    // a closed grant's key results can be deleted by a human only; the building is never blocked for having none
    expect((await json(app, "DELETE", `/api/key-results/${krs[1]}`, { headers: mgr })).status).toBe(403);
    for (const k of krs) expect((await json(app, "DELETE", `/api/key-results/${k}`, { headers: auth })).status).toBe(200);
    expect((await json(app, "GET", `/api/buildings/${LAB}`)).body).toMatchObject({ blocked: null });
    expect((await json(app, "GET", `/api/buildings/town-hall/intray`)).body.blocked).toEqual([]);

    expect((await json(app, "GET", `/api/grants/gr_missing`)).status).toBe(404);
    expect((await json(app, "GET", `/api/buildings/nowhere/grants`)).status).toBe(404);
  });
  it("a checkpoint grant in the Town Hall in-tray and the review deck carries its evidence: per key result verdict and note, spend, the top-up line (mt_7b4zc7yja3)", async () => {
    const s = await seededApp();
    cleanups.push(s.close);
    const { world, app } = s;
    const admin = null; // the system decides (no session needed for a funding decision here)
    const manager = world.agents.first("homeBuildingId = ? AND kind != 'human'", [LAB])!;
    world.permissions.grant(manager, buildingRoleId(LAB, "manager"));
    const g = world.grantDesk.propose(manager, world.grantDesk.create(manager, LAB, { objective: "Banner", approach: "", steps: [{ title: "Step 1", description: "Do the work" }], stopCondition: "two tries", askTokens: 1_000_000, keyResults: KRS }).id);
    world.grantDesk.decide(admin, g.id, { action: "fund", tokens: 1_000_000 });
    world.grants.patch(g.id, { status: "checkpoint", history: [...world.grants.require(g.id).history, { at: new Date().toISOString(), byId: "system", byKind: "agent", action: "checkpoint", tokens: null, note: "" }] });
    const [k1] = world.grantDesk.get(g.id).keyResults;
    world.grantDesk.updateKeyResult(manager, k1!.id, { status: "claimed", note: "live on the banner" });
    world.grants.patch(g.id, { topUpTokens: 200_000, whatTopUpBuys: "KR 2: the board" });
    const intray = await json(app, "GET", "/api/buildings/town-hall/intray");
    const row = intray.body.grants.find((x: { id: string }) => x.id === g.id);
    expect(row.evidence).toMatchObject({
      grantId: g.id, grantTokens: 1_000_000, spentTokens: 0, topUpTokens: 200_000, whatTopUpBuys: "KR 2: the board", shipped: [],
      keyResults: [{ verdict: "shipped", note: "live on the banner", status: "claimed" }, { verdict: "not", note: "", status: "not-started" }],
    });
    const deck = await json(app, "GET", "/api/review-deck");
    const slide = deck.body.slides.find((x: { key: string }) => x.key === `checkpoint:${g.id}`);
    expect(slide.text).toContain("1. ✓ shipped: live on the banner");
    expect(slide.text).toContain(`2. ✗ not shipped: ${KRS[1]!.text}`);
    expect(slide.text).toContain("A top-up of 200,000 tokens buys: KR 2: the board");
  });
  it("closing a grant as done marks its key results met: no Town Hall in-tray row, no deck slide; a funder can still flip one to missed (mt_v09cn7a8yr decision 2)", async () => {
    const s = await seededApp();
    cleanups.push(s.close);
    const { world, app, auth } = s;
    const manager = world.agents.first("homeBuildingId = ? AND kind != 'human'", [LAB])!;
    world.permissions.grant(manager, buildingRoleId(LAB, "manager"));
    const mgr = { authorization: `Bearer ${world.tokens.getOrCreate("agent", manager.id)}` };
    const id = (await json(app, "POST", `/api/buildings/${LAB}/grants`, { headers: mgr, body: { objective: "Banner", approach: "", steps: [{ title: "Step 1", description: "Do the work" }], stopCondition: "two tries", askTokens: 1_000_000, keyResults: KRS } })).body.grant.id as string;
    await json(app, "POST", `/api/grants/${id}/propose`, { headers: mgr });
    await json(app, "POST", `/api/grants/${id}/decide`, { headers: auth, body: { action: "fund" } });
    expect((await json(app, "POST", `/api/grants/${id}/close`, { headers: mgr, body: { outcome: "done", note: "live on the banner" } })).status).toBe(200);
    const got = (await json(app, "GET", `/api/grants/${id}`)).body.grant;
    expect(got).toMatchObject({ status: "closed", outcome: "done" });
    for (const k of got.keyResults) expect(k).toMatchObject({ status: "met", statusNote: "live on the banner", archivedAt: expect.any(String) });
    const intray = (await json(app, "GET", "/api/buildings/town-hall/intray", { headers: auth })).body;
    expect(intray.grants.map((g: { id: string }) => g.id)).not.toContain(id);
    const deck = (await json(app, "GET", "/api/review-deck", { headers: auth })).body;
    expect(deck.slides.some((x: { grantId?: string }) => x.grantId === id)).toBe(false);
    // the manager can't flip it; a funder can, with a reason, and undo it
    const k0 = got.keyResults[0].id as string;
    expect((await json(app, "PATCH", `/api/key-results/${k0}`, { headers: mgr, body: { status: "missed", note: "no" } })).status).toBe(403);
    expect((await json(app, "PATCH", `/api/key-results/${k0}`, { headers: auth, body: { status: "missed" } })).status).toBe(400);
    expect((await json(app, "PATCH", `/api/key-results/${k0}`, { headers: auth, body: { status: "missed", note: "not on the banner" } })).body.keyResult.status).toBe("missed");
    expect((await json(app, "PATCH", `/api/key-results/${k0}`, { headers: auth, body: { status: "met", note: "it is" } })).body.keyResult.status).toBe("met");
  });
  it("stopping a funded grant is a human's: the manager's stop and close-stopped get 403, its withdraw of a proposal 200; a funder's stop closes it and misses its key results (gr_8i952perny)", async () => {
    const s = await seededApp();
    cleanups.push(s.close);
    const { world, app, auth } = s;
    const manager = world.agents.first("homeBuildingId = ? AND kind != 'human'", [LAB])!;
    world.permissions.grant(manager, buildingRoleId(LAB, "manager"));
    const mgr = { authorization: `Bearer ${world.tokens.getOrCreate("agent", manager.id)}` };
    const body = { objective: "Banner", approach: "", steps: [{ title: "Step 1", description: "Do the work" }], stopCondition: "two tries", askTokens: 1_000_000, keyResults: KRS };
    const propose = async () => {
      const id = (await json(app, "POST", `/api/buildings/${LAB}/grants`, { headers: mgr, body })).body.grant.id as string;
      await json(app, "POST", `/api/grants/${id}/propose`, { headers: mgr });
      return id;
    };
    const id = await propose();
    const other = await propose();
    // the manager still withdraws its own proposal (close as stopped = withdraw_grant)
    expect((await json(app, "POST", `/api/grants/${other}/close`, { headers: mgr, body: { outcome: "stopped", note: "superseded" } })).status).toBe(200);
    expect((await json(app, "POST", `/api/grants/${id}/stop`, { headers: auth, body: { reason: "too early" } })).status).toBe(409); // proposed: withdraw or reject it
    await json(app, "POST", `/api/grants/${id}/decide`, { headers: auth, body: { action: "fund" } });
    expect((await json(app, "POST", `/api/grants/${id}/stop`, { body: { reason: "x" } })).status).toBe(401);
    expect((await json(app, "POST", `/api/grants/${id}/stop`, { headers: mgr, body: { reason: "x" } })).status).toBe(403);
    expect((await json(app, "POST", `/api/grants/${id}/close`, { headers: mgr, body: { outcome: "stopped", note: "x" } })).status).toBe(403);
    expect((await json(app, "POST", `/api/grants/${id}/stop`, { headers: auth, body: { reason: " " } })).status).toBe(400);
    expect((await json(app, "GET", `/api/grants/${id}`)).body.grant.status).toBe("funded");
    const stopped = await json(app, "POST", `/api/grants/${id}/stop`, { headers: auth, body: { reason: "the plan is wrong" } });
    expect(stopped.status).toBe(200);
    // no session ran on it: it closes at once
    const got = (await json(app, "GET", `/api/grants/${id}`)).body.grant;
    expect(got).toMatchObject({ status: "closed", outcome: "stopped" });
    expect(got.keyResults).toHaveLength(2);
    for (const k of got.keyResults) expect(k).toMatchObject({ status: "missed", statusNote: "Grant stopped: the plan is wrong", archivedAt: expect.any(String) });
    expect((await json(app, "POST", `/api/grants/${id}/stop`, { headers: auth, body: { reason: "again" } })).status).toBe(409);
    const ev = world.events.list({ types: ["grant.closed"], desc: true, limit: 5 }).find((e) => e.payload.grantId === id)!;
    expect(ev.payload).toMatchObject({ outcome: "stopped", reason: "the plan is wrong", grantTokens: 1_000_000, spentTokens: 0, unspentTokens: 1_000_000, returnedTo: "pool" });
    // the Town Hall in-tray lists it for the record (routed, nothing to decide); the withdrawn proposal is not a stop
    const intray = (await json(app, "GET", "/api/buildings/town-hall/intray", { headers: auth })).body;
    expect(intray.stopped.map((g: { id: string }) => g.id)).toEqual([id]);
    expect(intray.grants.map((g: { id: string }) => g.id)).not.toContain(id);
    expect(intray.routes[id]).toMatchObject({ canDecide: false });
    const deck = (await json(app, "GET", "/api/review-deck", { headers: auth })).body;
    expect(deck.slides.find((x: { kind: string }) => x.kind === "stopped")).toMatchObject({ grantId: id });
  });
});
