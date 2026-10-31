import { describe, expect, it } from "vitest";
import { buildingRoleId, createAssignment, exploreBlock, exploreRuleAt, exploreTick, freeTokens, keyResultsBlock, newId, nowIso, EXPLORE_MIN_GAP_MS } from "../src/index.ts";
import { laneBlock } from "../src/lanes.ts";
import { creditBank, seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";

/** Mei manages the lab with spare desks; the Bank holds 10M; the other buildings have no manager, so only the lab explores. */
function setup() {
  const s = seededWorld();
  const { world, by, admin } = s;
  const mei = by("Mei");
  for (const b of world.buildings.all()) if (b.id !== LAB && b.kind !== "town-hall") world.buildings.upsert({ ...b, managerAgentId: null });
  world.ops.updateBuilding(admin, LAB, { managerAgentId: mei.id });
  world.permissions.grant({ kind: "agent", id: mei.id }, buildingRoleId(LAB, "manager"));
  world.buildings.upsert({ ...world.buildings.require(LAB), headcount: 20 });
  creditBank(world);
  const goalId = world.goalTree.attachmentOf(LAB);
  const explorers = () => world.assignments.where("buildingId = ? AND reservationId IS NOT NULL", [LAB]);
  return { ...s, mei, goalId, explorers };
}

describe("declarative exploration (docs/how-work-gets-done.md §3)", () => {
  it("the rule is inherited: on with 100k chunks by default, each setting from the nearest goal that sets it", () => {
    const { world, admin, goalId } = setup();
    expect(exploreRuleAt(world.goals, goalId)).toEqual({ on: true, onFrom: null, chunkTokens: 100_000, chunkFrom: null });
    world.goalTree.update(admin, "gl_town", { explore: false, exploreChunkTokens: 50_000 });
    if (goalId !== "gl_town") world.goalTree.update(admin, goalId, { explore: true });
    const rule = exploreRuleAt(world.goals, goalId);
    expect(rule).toMatchObject({ chunkTokens: 50_000, chunkFrom: "gl_town" });
    expect(rule.on).toBe(goalId !== "gl_town");
  });

  it("the tick reserves one chunk and queues one explorer on the building queue; the reservation claims free tokens", () => {
    const { world, goalId, explorers } = setup();
    const before = freeTokens(world, goalId).freeTokens;
    const { started } = exploreTick(world);
    expect(started).toHaveLength(1);
    const a = started[0]!;
    expect(a).toMatchObject({ buildingId: LAB, lane: "exploration", queue: "building", status: "pending" });
    const r = world.bankReservations.require(a.reservationId!);
    expect(r).toMatchObject({ goalId, buildingId: LAB, assignmentId: a.id, tokens: 100_000, closedAt: null });
    expect(freeTokens(world, goalId)).toMatchObject({ reservedTokens: 100_000, freeTokens: before - 100_000 });
    expect(world.events.list({ types: ["exploration.reserved"] })).toHaveLength(1);
    // the explorer runs on its own reservation even if nothing else is free; one open explorer per building
    expect(laneBlock(world, a)).toBeNull();
    expect(exploreTick(world).started).toHaveLength(0);
    expect(exploreBlock(world, world.buildings.require(LAB))).toMatch(/explorer of this building is still open/);
    expect(explorers()).toHaveLength(1);
    // its brief: the explorer instruction, not the manager's findings note
    const brief = keyResultsBlock(world, world.buildings.require(LAB), a);
    expect(brief).toMatch(/end with ONE grant proposal/);
    expect(brief).toMatch(new RegExp(r.id));
  });

  it("closes the reservation when its work ends (spent booked, rest returns), then waits 30 min before the next explorer", () => {
    const { world, mei, goalId, explorers } = setup();
    const t0 = new Date();
    const a = exploreTick(world, t0).started[0]!;
    world.sessions.upsert({
      id: newId("se"), agentId: mei.id, assignmentId: a.id, meetingId: null, purpose: "work", backend: "host", status: "done", model: "m",
      sdkSessionId: null, output: 30_000, costUsd: 0, turns: 0, reportId: null, error: null, startedAt: nowIso(), endedAt: nowIso(), funding: null, lane: "exploration", grantId: null,
    });
    // while it runs, the reservation claims only what its sessions haven't spent
    expect(freeTokens(world, goalId).reservedTokens).toBeLessThan(100_000);
    world.assignments.patch(a.id, { status: "done" });
    const t1 = new Date(t0.getTime() + 60_000);
    const { closed, started } = exploreTick(world, t1);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.closedAt).toBe(t1.toISOString());
    expect(closed[0]!.spentTokens).toBeGreaterThan(0);
    expect(started).toHaveLength(0);
    expect(freeTokens(world, goalId).reservedTokens).toBe(0);
    expect(exploreBlock(world, world.buildings.require(LAB), t1)).toMatch(/30 min/);
    expect(exploreTick(world, new Date(t0.getTime() + EXPLORE_MIN_GAP_MS + 1000)).started).toHaveLength(1);
    expect(explorers()).toHaveLength(2);
  });

  it("starts nothing when the rule is off, tokens are short, a proposal is open, other work is queued, or in the Town Hall", async () => {
    const { world, admin, mei, goalId } = setup();
    const lab = () => world.buildings.require(LAB);
    world.goalTree.update(admin, goalId, { explore: false });
    expect(exploreBlock(world, lab())).toMatch(/exploration is off/);
    world.goalTree.update(admin, goalId, { explore: null, exploreChunkTokens: 2_000_000 });
    if (goalId !== "gl_town") world.goalTree.update(admin, "gl_town", { explore: true });
    world.goalTree.update(admin, goalId, { exploreChunkTokens: 1_900_000 });
    world.goalTree.update(admin, goalId, { exploreCapTokensPerDay: 1_000_000 });
    expect(exploreBlock(world, lab())).toMatch(/cap/);
    world.goalTree.update(admin, goalId, { exploreCapTokensPerDay: null, exploreChunkTokens: null });
    expect(exploreBlock(world, lab())).toBeNull();
    const g = world.grantDesk.create(mei, LAB, { keyResults: [{ text: "k", howToCheck: "h" }], objective: "o", stopCondition: "s", askTokens: 1_000 });
    world.grantDesk.propose(mei, g.id);
    expect(exploreBlock(world, lab())).toMatch(/proposal of this building is open/);
    world.grantDesk.decide(admin, g.id, { action: "reject", note: "no" });
    createAssignment(world, { agentId: mei.id, buildingId: LAB, queue: "building", title: "t", description: "d", createdBy: { kind: "system", id: "x" }, lane: { gap: "a gap" } });
    expect(exploreBlock(world, lab())).toMatch(/other work is queued/);
    const hall = world.buildings.first("kind = 'town-hall'")!;
    expect(exploreBlock(world, hall)).toMatch(/Town Hall never explores/);
  });

  it("a fork proposes for its building as the manager, and an explorer's proposal is logged as exploration.proposed", async () => {
    const { world, mei, by } = setup();
    const a = exploreTick(world).started[0]!;
    const fork = world.agents.upsert({ ...by("Noor"), id: newId("ag"), name: "Mei 1", forkOf: mei.id, forkN: 1, homeBuildingId: LAB, currentAssignmentId: a.id });
    const out = await world.verbs.propose_grant(fork, { objective: "Show the lab's goal first", stopCondition: "two tries", askTokens: 200_000, keyResults: [{ text: "k1", howToCheck: "h1", due: "2026-12-01" }, { text: "k2", howToCheck: "h2", due: "2026-12-01" }] });
    expect(world.grants.require(out.grantId)).toMatchObject({ buildingId: LAB, status: "proposed" });
    const ev = world.events.list({ types: ["exploration.proposed"] });
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ grantId: out.grantId, reservationId: a.reservationId });
  });
});
