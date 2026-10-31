import { buildingRoleId } from "@muster-town/core";
import { afterEach, describe, expect, it } from "vitest";
import { json, seededApp } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const LAB = "carbon-cycle";

describe("GET /api/review-deck", () => {
  it("returns slide 1 then the proposal slide; a decision from a slide records payload.deckSlide", async () => {
    const s = await seededApp();
    cleanups.push(s.close);
    const { world, app, auth } = s;
    const manager = world.agents.first("homeBuildingId = ? AND kind != 'human'", [LAB])!;
    world.permissions.grant(manager, buildingRoleId(LAB, "manager"));
    const r = await world.verbs.propose_grant(manager, { keyResults: [{ text: "A banner line", howToCheck: "Open the banner" }], objective: "Banner", stopCondition: "done", askTokens: 100_000, whatYoudSee: "The banner says it", findingsDocIds: [], approach: "", note: "" });
    const deck = await json(app, "GET", "/api/review-deck");
    expect(deck.status).toBe(200);
    expect(deck.body.slides[0]).toMatchObject({ key: "town", kind: "town" });
    const slide = deck.body.slides.findIndex((x: { grantId?: string }) => x.grantId === r.grantId) + 1;
    expect(slide).toBeGreaterThan(1);
    expect(deck.body.slides[slide - 1].text).toContain("The banner says it");
    const d = await json(app, "POST", `/api/grants/${r.grantId}/decide`, { headers: auth, body: { action: "reject", deckSlide: slide } });
    expect(d.status).toBe(200);
    expect(world.events.list({ types: ["grant.rejected"] }).at(-1)!.payload).toMatchObject({ grantId: r.grantId, deckSlide: slide });
    expect((await json(app, "GET", "/api/review-deck")).body.slides.some((x: { grantId?: string }) => x.grantId === r.grantId)).toBe(false);
  });

  // gr_jh0lu0w6yj step 5: Presentation with chat
  it("a meeting presents the review deck: POST /present moves the slide and posts '— slide n'; a decision with meetingId is a meeting decision too", async () => {
    const s = await seededApp();
    cleanups.push(s.close);
    const { world, app, auth } = s;
    const manager = world.agents.first("homeBuildingId = ? AND kind != 'human'", [LAB])!;
    world.permissions.grant(manager, buildingRoleId(LAB, "manager"));
    const r = await world.verbs.propose_grant(manager, { keyResults: [{ text: "A banner line", howToCheck: "Open the banner" }], objective: "Banner", stopCondition: "done", askTokens: 100_000, findingsDocIds: [], approach: "", note: "" });
    const called = await json(app, "POST", "/api/meetings", { headers: auth, body: { kind: "in-tray-review", buildingId: null, startNow: true, brings: { mode: "nothing", text: "" }, askHumans: true, deck: { docId: "review-deck" } } });
    expect(called.status).toBe(201);
    const id = called.body.meeting.id;
    expect(called.body.meeting.deck).toMatchObject({ docId: "review-deck", slide: 1 });
    const deck = (await json(app, "GET", "/api/review-deck")).body;
    const slide = deck.slides.findIndex((x: { grantId?: string }) => x.grantId === r.grantId) + 1;
    const moved = await json(app, "POST", `/api/meetings/${id}/present`, { headers: auth, body: { docId: "review-deck", slide } });
    expect(moved.status).toBe(200);
    expect(moved.body.meeting.deck.slide).toBe(slide);
    expect(moved.body.meeting.transcript.at(-1).text).toBe(`— slide ${slide}: ${deck.slides[slide - 1].title}`);
    expect((await json(app, "POST", `/api/meetings/${id}/present`, { body: { docId: "review-deck", slide: 1 } })).status).toBe(401);
    const d = await json(app, "POST", `/api/grants/${r.grantId}/decide`, { headers: auth, body: { action: "reject", deckSlide: slide, meetingId: id } });
    expect(d.status).toBe(200);
    expect(world.events.list({ types: ["grant.rejected"] }).at(-1)!.payload).toMatchObject({ deckSlide: slide });
    const m = world.meetings.require(id);
    expect(m.decisions.at(-1)!.text).toContain(`rejected ${r.grantId} "Banner" (on slide ${slide})`);
  });
});

describe("the funder filter (goal tree build step 8)", () => {
  it("GET /api/funders/me/week: a guest gets 401, a signed-in human their week and its slide; ?funder=me narrows a Spend tab", async () => {
    const s = await seededApp();
    cleanups.push(s.close);
    const { app, auth, world } = s;
    expect((await json(app, "GET", "/api/funders/me/week")).status).toBe(401);
    const r = await json(app, "GET", "/api/funders/me/week?days=7", { headers: auth });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ days: 7, slide: { kind: "funder", title: "Your week as a funder" } });
    expect(r.body.streams.length).toBeGreaterThan(0);
    const goal = world.goalTree.attachmentOf(LAB);
    expect((await json(app, "GET", `/api/goals/${goal}/spend?funder=me`)).status).toBe(401);
    const spend = await json(app, "GET", `/api/goals/${goal}/spend?funder=me`, { headers: auth });
    expect(spend.status).toBe(200);
    expect(spend.body.sessions).toBe(0);
  });
});
