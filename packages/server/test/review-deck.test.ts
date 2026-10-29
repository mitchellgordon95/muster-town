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
    const kr = (await json(app, "POST", `/api/buildings/${LAB}/key-results`, { headers: auth, body: { text: "A banner line", howToCheck: "Open the banner" } })).body.keyResult.id;
    const r = await world.verbs.propose_grant(manager, { keyResultId: kr, objective: "Banner", stopCondition: "done", askTokens: 100_000, whatYoudSee: "The banner says it", testingPlan: [], findingsDocIds: [], approach: "", note: "" });
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
});
