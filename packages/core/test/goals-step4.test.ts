import { describe, expect, it } from "vitest";
import { adjustedOfUsage, buildingRoleId, createBuilding, createUser, goalSpend, intrayRoutes, intrayCount, reviewDeck, townHallIntray, worldGoalSpend, type GoalSpendInputs } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";
const due = "2026-12-31";

function setup() {
  const s = seededWorld();
  const { world, by, admin } = s;
  const mei = by("Mei");
  world.ops.updateBuilding(admin, LAB, { managerAgentId: mei.id });
  world.permissions.grant({ kind: "agent", id: mei.id }, buildingRoleId(LAB, "manager"));
  const tree = world.goalTree;
  const labGoal = tree.create(admin, { parentId: "gl_trust", text: "A funder sees what every token bought" });
  const otherGoal = tree.create(admin, { parentId: "gl_join", text: "A stranger finishes useful work" });
  tree.attach(admin, LAB, labGoal.id);
  const other = createBuilding(world, { name: "Other", goalId: otherGoal.id }, null);
  return { ...s, mei, tree, labGoal, otherGoal, other };
}

describe("the in-tray and the deck (docs/goals.md, step 4)", () => {
  it("open goal proposals are Town Hall in-tray items: listed, counted in the badge, one deck slide each after grant proposals", async () => {
    const { world, mei, admin } = setup();
    const th = world.buildings.first("kind = 'town-hall'")!;
    const before = intrayCount(world, th.id);
    const r = await world.verbs.propose_key_result(mei, { text: "Deck shows sessions", howToCheck: "Open the deck", due, why: "funders asked" });
    const kr = world.goalTree.addKeyResult(admin, world.goalTree.attachmentOf(LAB), { text: "k", howToCheck: "h", due, buildingId: LAB });
    const g = world.grantDesk.create(null, LAB, { keyResultId: kr.id, objective: "o", approach: "a", stopCondition: "s", askTokens: 1000 });
    world.grantDesk.propose(null, g.id);
    expect(townHallIntray(world).goalProposals.map((p) => p.id)).toEqual([r.proposal.id]);
    expect(intrayCount(world, th.id)).toBe(before + 2);
    const deck = reviewDeck(world);
    const kinds = deck.slides.map((s) => s.kind);
    expect(kinds).toContain("goal-proposal");
    expect(kinds.indexOf("proposal")).toBeLessThan(kinds.indexOf("goal-proposal"));
    const slide = deck.slides.find((s) => s.kind === "goal-proposal")!;
    expect(slide).toMatchObject({ itemId: r.proposal.id, group: 4, buildingId: LAB });
    expect(slide.text).toMatch(/add a key result.*Deck shows sessions/);
    world.goalTree.decideProposal(admin, r.proposal.id, { action: "cut", note: "no" });
    expect(townHallIntray(world).goalProposals).toEqual([]);
    expect(reviewDeck(world).slides.some((s) => s.kind === "goal-proposal")).toBe(false);
  });

  it("routes: Mine is what ends at the viewer (admins get the root's), an owner decides and funds in their subtree only", async () => {
    const { world, admin, mei, tree, labGoal, otherGoal, other } = setup();
    const lena = createUser(world, "Lena").user;
    const lenaAv = world.ops.ensureAvatar(lena.id);
    tree.update(admin, labGoal.id, { ownerId: lena.id });
    const krLab = tree.addKeyResult(admin, labGoal.id, { text: "lab kr", howToCheck: "h", due, buildingId: LAB });
    const krOther = tree.addKeyResult(admin, otherGoal.id, { text: "other kr", howToCheck: "h", due, buildingId: other.id });
    const plan = { objective: "o", approach: "a", stopCondition: "s", askTokens: 1000 };
    const gLab = world.grantDesk.create(null, LAB, { ...plan, keyResultId: krLab.id });
    const gOther = world.grantDesk.create(null, other.id, { ...plan, keyResultId: krOther.id });
    world.grantDesk.propose(null, gLab.id);
    world.grantDesk.propose(null, gOther.id);
    const p = (await world.verbs.propose_key_result(mei, { text: "x", howToCheck: "y", due, why: "z" })).proposal;
    const items = townHallIntray(world);
    const forLena = intrayRoutes(world, lenaAv, items);
    expect(forLena.defaultView).toBe("mine");
    expect(forLena.routes[gLab.id]).toMatchObject({ goalId: labGoal.id, ownerId: lena.id, ownerName: "Lena", mine: true, canDecide: true });
    expect(forLena.routes[gOther.id]).toMatchObject({ ownerId: null, ownerName: "the town admins", mine: false, canDecide: false });
    expect(forLena.routes[p.id]).toMatchObject({ mine: true, canDecide: true });
    const forAdmin = intrayRoutes(world, admin, items);
    expect(forAdmin.defaultView).toBe("all");
    expect(forAdmin.routes[gOther.id]).toMatchObject({ mine: true, canDecide: true });
    expect(forAdmin.routes[gLab.id]).toMatchObject({ mine: false, canDecide: true });
    const anon = intrayRoutes(world, undefined, items);
    expect(Object.values(anon.routes).some((r) => r.mine || r.canDecide)).toBe(false);
    expect(intrayRoutes(world, mei, items).routes[gLab.id]?.canDecide).toBe(false); // an agent never decides
    // what canDecide promises holds: Lena funds hers (from the Bank, no member input), not the other
    expect(world.grantDesk.decide(lenaAv, gLab.id, { action: "fund" }).status).toBe("funded");
    expect(() => world.grantDesk.decide(lenaAv, gOther.id, { action: "fund" })).toThrow();
    expect(tree.decideProposal(lenaAv, p.id, { action: "accept" }).status).toBe("accepted");
  });
});

describe("the Spend tab (docs/goals.md \"Spend tab\", step 4): read-only, from session rows", () => {
  const now = new Date("2026-10-30T12:00:00Z");
  const at = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
  const s = (id: string, o: Partial<GoalSpendInputs["sessions"][number]>): GoalSpendInputs["sessions"][number] =>
    ({ id, agentId: "ag_a", assignmentId: null, grantId: null, lane: null, model: "claude-opus-4-5", input: 0, output: 1000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, byModel: null, startedAt: at(2), endedAt: at(1), ...o });
  const inputs = (sessions: GoalSpendInputs["sessions"]): GoalSpendInputs => ({
    subtree: new Set(["gl_a", "gl_a1"]), rootId: "gl_town", sessions,
    assignments: [
      { id: "as_g", buildingId: "b1", grantId: "gr_1", keyResultId: "kr_1", lane: "grant" },
      { id: "as_e", buildingId: "b2", grantId: null, keyResultId: "kr_2", lane: "exploration" },
      { id: "as_d", buildingId: "b1", grantId: null, keyResultId: null, lane: "directed" },
      { id: "as_x", buildingId: "b3", grantId: null, keyResultId: null, lane: "directed" },
    ],
    agents: [{ id: "ag_a", buildingId: "b1" }, { id: "ag_c", buildingId: "b3" }],
    buildings: [{ id: "b1", name: "One", goalId: "gl_a" }, { id: "b2", name: "Two", goalId: "gl_b" }, { id: "b3", name: "Three", goalId: "gl_b" }],
    grants: [{ id: "gr_1", keyResultId: "kr_1", buildingId: "b1" }],
    keyResults: [
      { id: "kr_1", text: "one", goalId: "gl_a1", status: "on-track", updatedAt: at(50) },
      { id: "kr_2", text: "two", goalId: "gl_a", status: "met", updatedAt: at(5) },
      { id: "kr_3", text: "old", goalId: "gl_a", status: "missed", updatedAt: at(24 * 30) },
    ],
  });

  it("a session belongs by its lane: grant → the KR's goal, a named KR → its goal, else the building's attachment", () => {
    const one = adjustedOfUsage("claude-opus-4-5", { output: 1000 });
    const r = goalSpend("gl_a", inputs([
      s("grant", { assignmentId: "as_g", grantId: "gr_1", lane: "grant" }),
      s("expl", { assignmentId: "as_e", lane: "exploration" }), // building b2 is elsewhere, but its KR is in the subtree
      s("dir", { assignmentId: "as_d", lane: "directed" }),
      s("mgr", {}), // no assignment: agent's building b1 → gl_a
      s("out", { assignmentId: "as_x", agentId: "ag_c", lane: "directed" }), // b3 → gl_b: not counted
      s("old", { assignmentId: "as_d", lane: "directed", startedAt: at(24 * 9), endedAt: at(24 * 8) }), // outside 7 days
    ]), 7, now);
    expect(r.sessions).toBe(4);
    expect(r.total).toBe(4 * one);
    expect(r.byLane).toEqual({ grant: one, exploration: one, directed: one, none: one });
    expect(r.byBuilding.map((b) => [b.id, b.tokens])).toEqual([["b1", 3 * one], ["b2", one]]);
    expect(r.byKeyResult.map((k) => [k.id, k.tokens])).toEqual([["kr_1", one], ["kr_2", one]]);
    expect(r.seriesUnit).toBe("day");
    expect(r.series).toHaveLength(7);
    expect(r.series.at(-1)!.tokens).toBe(4 * one);
    expect(r.results.map((k) => k.id)).toEqual(["kr_2"]);
    // a narrower node sees only its own: gl_a1 holds kr_1's goal
    const sub = goalSpend("gl_a1", { ...inputs([s("grant", { assignmentId: "as_g", grantId: "gr_1", lane: "grant" }), s("dir", { assignmentId: "as_d", lane: "directed" })]), subtree: new Set(["gl_a1"]) }, 30, now);
    expect(sub).toMatchObject({ sessions: 1, seriesUnit: "week" });
    expect(sub.series).toHaveLength(5);
  });

  it("the funder filter (step 8): weights keep only what one funder paid, scaled", () => {
    const one = adjustedOfUsage("claude-opus-4-5", { output: 1000 });
    const r = goalSpend("gl_a", { ...inputs([s("a", {}), s("b", {}), s("c", {})]), weights: new Map([["a", 1], ["b", 0.25]]) }, 7, now);
    expect(r.sessions).toBe(2);
    expect(r.total).toBe(one + Math.round(one * 0.25));
  });

  it("over the world: reads sessions, writes nothing to the Bank", () => {
    const { world, admin, labGoal, mei } = setup();
    const kr = world.goalTree.addKeyResult(admin, labGoal.id, { text: "k", howToCheck: "h", due, buildingId: LAB });
    const g = world.grantDesk.create(null, LAB, { keyResultId: kr.id, objective: "o", approach: "a", stopCondition: "s", askTokens: 100000 });
    world.grantDesk.propose(null, g.id);
    world.grantDesk.decide(admin, g.id, { action: "fund" });
    const agent = mei;
    const t = new Date().toISOString();
    world.sessions.upsert({ id: "se_t1", agentId: agent.id, assignmentId: null, purpose: "work", status: "done", model: "claude-opus-4-5", output: 500, startedAt: t, endedAt: t, lane: "grant", grantId: g.id } as never);
    const snapshot = () => ({ balance: world.bank.balance(), events: world.events.list({ limit: 1 })[0]?.id, grant: world.grants.require(g.id).updatedAt });
    const before = snapshot();
    const r = worldGoalSpend(world, "gl_trust");
    expect(r.sessions).toBe(1);
    expect(r.byKeyResult[0]?.id).toBe(kr.id);
    expect(worldGoalSpend(world, "gl_join").sessions).toBe(0);
    expect(snapshot()).toEqual(before);
  });
});
