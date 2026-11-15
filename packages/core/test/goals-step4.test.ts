import { describe, expect, it } from "vitest";
import { adjustedOfUsage, buildingRoleId, createBuilding, createUser, goalSpend, holderOf, intrayRoutes, intrayCount, reviewDeck, townHallIntray, worldGoalSpend, type GoalSpendInputs } from "../src/index.ts";
import { renderNeeds, seededWorld } from "./helpers.ts";

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
  it("an open goal proposal is no raw in-tray item, badge count or deck slide: it reaches the queue only as its ask (1:1 mt_dwsxo7oms8 decision 4)", async () => {
    const { world, mei, admin } = setup();
    const th = world.buildings.first("kind = 'town-hall'")!;
    const before = intrayCount(world, th.id);
    const r = await world.verbs.propose_goal(mei, { action: "add-goal", parentId: world.goalTree.attachmentOf(LAB), text: "Deck shows sessions", why: "funders asked" });
    expect(townHallIntray(world)).not.toHaveProperty("goalProposals");
    expect(intrayCount(world, th.id)).toBe(before);
    expect(reviewDeck(world).slides.some((s) => s.kind === "goal-proposal" || s.itemId === r.proposal.id)).toBe(false);
    const [ask] = renderNeeds(world, mei.id);
    expect(ask).toMatchObject({ targetKind: "goalProposal", targetId: r.proposal.id, type: "policy" });
    expect(reviewDeck(world).slides.filter((s) => s.askId === ask!.id || s.itemId === ask!.id)).toHaveLength(1);
    world.goalTree.decideProposal(admin, r.proposal.id, { action: "cut", note: "no" });
    expect(world.asks.get(ask!.id)!.status).toBe("retired");
  });

  it("routes: Mine is what ends at the viewer (the root's captain gets the root's), an owner decides and funds in their subtree only", async () => {
    const { world, admin, mei, tree, labGoal, otherGoal, other } = setup();
    const lena = createUser(world, "Lena").user;
    const lenaAv = world.ops.ensureAvatar(lena.id);
    tree.update(admin, labGoal.id, { ownerId: lena.id });
    const plan = { objective: "o", approach: "a", steps: [{ size: "M" as const, title: "Step 1", description: "Do the work" }], stopCondition: "s", askTokens: 1000 };
    const gLab = world.grantDesk.create(null, LAB, { ...plan, goalId: labGoal.id, keyResults: [{ text: "lab kr", howToCheck: "h", due }] });
    const gOther = world.grantDesk.create(null, other.id, { ...plan, goalId: otherGoal.id, keyResults: [{ text: "other kr", howToCheck: "h", due }] });
    world.grantDesk.propose(null, gLab.id);
    world.grantDesk.propose(null, gOther.id);
    const p = (await world.verbs.propose_goal(mei, { action: "add-goal", parentId: labGoal.id, text: "x", why: "z" })).proposal;
    renderNeeds(world, mei.id);
    const items = townHallIntray(world);
    const forLena = intrayRoutes(world, lenaAv, items);
    expect(forLena.defaultView).toBe("mine");
    expect(forLena.routes[gLab.id]).toMatchObject({ goalId: labGoal.id, ownerId: lena.id, ownerName: "Lena", mine: true, canDecide: true });
    expect(forLena.routes[gOther.id]).toMatchObject({ ownerId: holderOf(admin).id, ownerName: world.users.get(holderOf(admin).id)!.name, mine: false, canDecide: false });
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

  it("visitors at desks under the goal are counted, their spend is not: online visitors homed in the subtree's buildings only", () => {
    const base = inputs([s("mgr", {})]);
    const r = goalSpend("gl_a", { ...base, agents: [
      ...base.agents,
      { id: "ag_v1", buildingId: "b1", homeBuildingId: "b1", kind: "visitor", status: "idle" },
      { id: "ag_v2", buildingId: "town-hall", homeBuildingId: "b1", kind: "visitor", status: "offline" }, // offline: no desk
      { id: "ag_v3", buildingId: "b3", homeBuildingId: "b3", kind: "visitor", status: "working" }, // b3 → gl_b: elsewhere
      { id: "ag_v4", buildingId: "b1", homeBuildingId: "b1", kind: "visitor", status: "retired" }, // gone
      { id: "ag_r", buildingId: "b1", homeBuildingId: "b1", kind: "resident", status: "idle" },
    ] }, 7, now);
    expect(r.visitors).toBe(1);
    expect(r.sessions).toBe(1); // the visitor's own sessions never reach the table: nothing is booked or guessed for it
    expect(goalSpend("gl_a", base, 7, now).visitors).toBe(0);
  });

  it("the funder filter (step 8): weights keep only what one funder paid, scaled", () => {
    const one = adjustedOfUsage("claude-opus-4-5", { output: 1000 });
    const r = goalSpend("gl_a", { ...inputs([s("a", {}), s("b", {}), s("c", {})]), weights: new Map([["a", 1], ["b", 0.25]]) }, 7, now);
    expect(r.sessions).toBe(2);
    expect(r.total).toBe(one + Math.round(one * 0.25));
  });

  it("over the world: reads sessions, writes nothing to the Bank", () => {
    const { world, admin, labGoal, mei } = setup();
    const g = world.grantDesk.create(null, LAB, { goalId: labGoal.id, keyResults: [{ text: "k", howToCheck: "h", due }], objective: "o", approach: "a", steps: [{ size: "M", title: "Step 1", description: "Do the work" }], stopCondition: "s", askTokens: 100000 });
    const kr = world.keyResults.require(g.keyResultId!);
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
