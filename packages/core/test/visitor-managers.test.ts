import { describe, expect, it } from "vitest";
import { buildingRoleId, createAssignment, createBuilding, createSchedule, forkableManagerOf, forkableQueue, managerAgentOf } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const later = (ms: number) => new Date(Date.now() + ms);

/** A goal no lab works on: the seed's labs sit on the root (every goal's ancestor), so park them on a sibling first. */
function orphanGoal(world: ReturnType<typeof seededWorld>["world"]) {
  const parking = world.goalTree.create(null, { parentId: "gl_town", text: "Parking" });
  for (const g of world.buildings.all()) if (g.kind === "lab" && g.goalId === "gl_town") world.goalTree.attach(null, g.id, parking.id);
  return world.goalTree.create(null, { parentId: "gl_town", text: "Nobody works on this yet" });
}

function adopted() {
  const ctx = seededWorld();
  const goal = orphanGoal(ctx.world);
  const v = ctx.world.ops.registerVisitor(ctx.seed.admin.id, { name: "Vis" }).agent;
  const { building } = ctx.world.ops.adoptGoal(v.id, goal.id);
  return { ...ctx, goal, v: ctx.world.agents.require(v.id), b: building };
}

describe("gr_a5ct690l7a step 4: a visitor adopts a goal and manages its building", () => {
  it("a visitor adopting a goal with no desks becomes its building's manager", async () => {
    const { world, goal, v, b } = adopted();
    expect(b.goalId).toBe(goal.id);
    expect(b.kind).toBe("lab");
    expect(b.managerAgentId).toBe(v.id);
    expect(managerAgentOf(world, b)?.id).toBe(v.id);
    expect(v.homeBuildingId).toBe(b.id);
    expect(v.pos).toEqual(world.layout.deskOf(v.id)!.pos);
    expect(world.permissions.agentsWithRole(buildingRoleId(b.id, "manager"))).toContain(v.id);
    // its desk is beyond the headcount: the building has no fork slot taken
    expect(world.layout.visitorDeskCount(b.id)).toBe(1);
    // a tell to the building id reaches the visitor
    const r = await world.verbs.tell(world.agents.all().find((a) => a.kind === "resident")!, { to: b.id, text: "hello" });
    expect(JSON.stringify(r)).toContain(v.id);
    // the same verb over the generic path, and the goal is no longer adoptable
    const w = world.ops.registerVisitor(world.agents.require(v.id).ownerUserId!, { name: "Other" }).agent;
    await expect(world.verbs.adopt(w, { goalId: goal.id })).rejects.toThrow(/register a visitor on goal/);
  });

  it("adopting a goal that has a building on it or above it is refused (409): register on it instead", () => {
    const { world, seed } = seededWorld();
    const top = world.goalTree.create(null, { parentId: "gl_town", text: "Has a lab" });
    const sub = world.goalTree.create(null, { parentId: top.id, text: "Under it" });
    createBuilding(world, { name: "Lab", headcount: 1, goalId: top.id }, null, { starterResidents: true });
    const v = world.ops.registerVisitor(seed.admin.id, { name: "V" }).agent;
    for (const g of [top.id, sub.id]) expect(() => world.ops.adoptGoal(v.id, g)).toThrow(/register a visitor on goal/);
    const r = world.agents.all().find((a) => a.kind === "resident")!;
    expect(() => world.ops.adoptGoal(r.id, sub.id)).toThrow(/Only a visitor/);
  });

  it("assign to a visitor-managed building's queue is refused", async () => {
    const { world, v, b } = adopted();
    await expect(world.verbs.assign(v, { title: "Do it", description: "x" })).rejects.toThrow(/is a visitor: the town can't fork a visitor/);
    expect(() => createSchedule(world, b.id, world.holderOf(v), { title: "Weekly", description: "x", runsAt: later(3_600_000).toISOString() })).toThrow(/is a visitor/);
    // offering the work to the visitor by id still works
    const r = await world.verbs.assign(v, { agentId: v.id, title: "Mine", description: "x", lane: "exploration", gap: "nothing yet" });
    expect(r.assignmentId).toBeTruthy();
    // nothing the town queues there is ever forked
    createAssignment(world, { agentId: v.id, buildingId: b.id, title: "Queued", description: "x", createdBy: { kind: "system", id: "system" }, laneOverride: { lane: "exploration", grantId: null, keyResultId: null, gap: "x", sourceId: null } });
    expect(forkableManagerOf(world, b)).toBeUndefined();
    expect(forkableQueue(world, world.buildings.require(b.id))).toEqual([]);
  });

  it("a visitor manager going offline holds the queue; back resumes it; dismissing clears managerAgentId", () => {
    const { world, v, b } = adopted();
    world.presence.sweep(later(91_000));
    expect(world.agents.require(v.id).status).toBe("offline");
    expect(managerAgentOf(world, world.buildings.require(b.id))).toBeUndefined();
    expect(world.layout.deskOf(v.id)).toBeUndefined();
    expect(world.presence.touch(v.id)!.back).toBe(true);
    expect(managerAgentOf(world, world.buildings.require(b.id))?.id).toBe(v.id);
    expect(world.layout.deskOf(v.id)).toBeTruthy();
    world.ops.dismissAgent(null, v.id);
    expect(world.buildings.require(b.id).managerAgentId).toBeNull();
  });
});
