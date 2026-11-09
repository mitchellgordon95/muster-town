/**
 * The Secretary's ranking over the API (legible delegation step 5): the `rank` verb sets ranks and files the money slate
 * as a notice; GET /api/buildings/town-hall/intray carries the latest notices beside the asks, GET /api/notices filters
 * them, and the review deck opens on today's slate. POST /api/rank/run is the "Rank now" button (/api/digest/run its old name).
 */
import { buildingRoleId } from "@muster-town/core";
import { afterEach, describe, expect, it } from "vitest";
import { json, seededApp } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const LAB = "carbon-cycle";

async function setup() {
  const s = await seededApp();
  cleanups.push(s.close);
  const { world, by } = s;
  const mei = by("Mei");
  world.permissions.grant(mei, buildingRoleId(LAB, "manager"));
  const sec = world.secretary.ensure()!;
  const proposal = (objective: string) => world.grantDesk.propose(mei, world.grantDesk.create(mei, LAB, {
    keyResults: [{ text: "Banner shows Usage", howToCheck: "Open the lab banner" }], objective, approach: "a banner line", steps: [{ title: "Step 1", description: "Do the work" }], stopCondition: "two failed tries", askTokens: 300_000,
  }).id);
  return { ...s, mei, sec, proposal, secAuth: { authorization: `Bearer ${world.tokens.getOrCreate("agent", sec.id)}` } };
}

describe("the Secretary's ranking in the Town Hall in-tray", () => {
  it("the rank verb sets ranks and files the slate; the in-tray carries it under notices, /api/notices filters it, the deck opens on it", async () => {
    const { world, app, auth, secAuth, proposal } = await setup();
    const a = proposal("A banner with today's spend");
    const b = proposal("A second banner");
    const askOf = (id: string) => world.asks.first("targetId = ? AND status = 'open'", [id])!;
    const [ka, kb] = [askOf(a.id), askOf(b.id)];
    const read = await json(app, "POST", "/api/verbs/rank", { headers: secAuth, body: {} });
    expect(read.body.result.inputs).toContain(ka.id);
    const ran = await json(app, "POST", "/api/verbs/rank", { headers: secAuth, body: { order: [kb.id, ka.id], slate: { fund: [{ askId: kb.id, why: "it unblocks the lab" }], skip: [{ askId: ka.id, why: "it overlaps the second banner" }] } } });
    expect(ran.status).toBe(200);
    expect(world.asks.require(kb.id).rank).toBe(1);
    const intray = (await json(app, "GET", "/api/buildings/town-hall/intray", { headers: auth })).body;
    expect(intray.notices[0]).toMatchObject({ id: ran.body.result.slateId, kind: "slate", refs: [kb.id, ka.id] });
    expect(intray).not.toHaveProperty("digest");
    expect(intray.asks.map((x: { id: string }) => x.id)).toEqual(expect.arrayContaining([ka.id, kb.id]));
    expect((await json(app, "GET", "/api/notices?kind=slate", { headers: auth })).body.notices.map((n: { id: string }) => n.id)).toEqual([ran.body.result.slateId]);
    expect((await json(app, "GET", "/api/notices?kind=shipped", { headers: auth })).body.notices).toEqual([]);
    expect((await json(app, "GET", "/api/notices?kind=nope", { headers: auth })).status).toBe(400);
    const deck = (await json(app, "GET", "/api/review-deck", { headers: auth })).body;
    expect(deck.slides.slice(0, 3).map((x: { kind: string; askId?: string }) => [x.kind, x.askId ?? null])).toEqual([["slate", null], ["town", null], ["proposal", kb.id]]);
    // nothing funded: the slate is a recommendation
    expect(world.grants.require(b.id).status).toBe("proposed");
  });

  it("POST /api/rank/run (the in-tray's Rank now button; /api/digest/run its old name): a human who can decide the retainer starts one run; refused for an agent, before approval, with nothing new, or while a run is live", async () => {
    const { world, app, auth, sec, mei, proposal } = await setup();
    const sched = world.secretary.ensureRankSchedule()!;
    const meiAuth = { authorization: `Bearer ${world.tokens.getOrCreate("agent", mei.id)}` };
    expect((await json(app, "POST", "/api/rank/run", { headers: meiAuth })).status).toBe(403);
    expect((await json(app, "POST", "/api/rank/run", { headers: auth })).body.error).toMatch(/not approved/);
    expect((await json(app, "POST", `/api/schedules/${sched.id}/retainer`, { headers: auth, body: { action: "approve" } })).status).toBe(200);
    expect((await json(app, "POST", "/api/rank/run", { headers: auth })).status).toBe(409); // no open ask
    proposal("A banner with today's spend");
    const view = (await json(app, "GET", "/api/buildings/town-hall/intray", { headers: auth })).body;
    expect(view.rankRun).toEqual({ scheduleId: sched.id, runningId: null, refused: null });
    expect(view.digestRun).toEqual(view.rankRun);
    const ran = await json(app, "POST", "/api/digest/run", { headers: auth });
    expect(ran.status).toBe(200);
    expect(ran.body.assignment).toMatchObject({ agentId: sec.id, lane: "retainer", sourceId: sched.id, model: "claude-fable-5-1" });
    expect((await json(app, "GET", "/api/buildings/town-hall/intray", { headers: auth })).body.rankRun.runningId).toBe(ran.body.assignment.id);
    expect((await json(app, "GET", "/api/buildings/town-hall/intray", { headers: meiAuth })).body.rankRun).toBeNull();
    expect((await json(app, "POST", "/api/rank/run", { headers: auth })).status).toBe(409);
  });
});
