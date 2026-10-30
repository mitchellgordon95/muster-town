/**
 * One named manager per building (1:1 mt_wngibcr98b decision 1): the manager's `assign` names only itself or a visitor
 * (else it is building-queue work), a flag goes to the building queue, there is no `reassign`, and `cancel` still drops
 * queued work in its own building.
 */
import { describe, expect, it } from "vitest";
import { buildingRoleId, pickUpFlag, setAssignmentStatus } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";

function setup() {
  const s = seededWorld();
  const { world, by, admin } = s;
  const mei = by("Mei"), noor = by("Noor");
  world.ops.updateBuilding(admin, LAB, { managerAgentId: mei.id });
  world.permissions.grant({ kind: "agent", id: mei.id }, buildingRoleId(LAB, "manager"));
  return { ...s, mei, noor };
}

describe("one named manager: assign, flags, cancel", () => {
  it("assign: no agentId = the building queue; agentId = the manager itself or a visitor, never another named agent", async () => {
    const { world, mei, noor, admin } = setup();
    const q = await world.verbs.assign(mei, { title: "Q", description: "d", gap: "g" });
    expect(world.assignments.require(q.assignmentId)).toMatchObject({ agentId: mei.id, queue: "building" });
    const own = await world.verbs.assign(mei, { agentId: mei.id, title: "Mine", description: "d", gap: "g" });
    expect(world.assignments.require(own.assignmentId)).toMatchObject({ agentId: mei.id, queue: "agent" });
    await expect(world.verbs.assign(mei, { agentId: noor.id, title: "No", description: "d", gap: "g" })).rejects.toThrow(/Leave agentId out to queue it to the building/);
    const v = world.ops.registerVisitor(admin.ownerUserId!, { name: "V", buildingId: LAB }).agent;
    const offer = await world.verbs.assign(mei, { agentId: v.id, title: "Offer", description: "d", gap: "g" });
    expect(world.assignments.require(offer.assignmentId)).toMatchObject({ agentId: v.id });
    expect((world.verbs as unknown as Record<string, unknown>).reassign).toBeUndefined();
  });

  it("a flag continued without assigneeId goes to the building queue; another named agent is refused", async () => {
    const { world, mei, noor, admin } = setup();
    const flag = world.ops.plantFlag(admin, LAB, "Make the banner readable");
    pickUpFlag(world, mei, flag);
    await expect(world.verbs.review(mei, { docId: flag.id, decision: "continue", assigneeId: noor.id })).rejects.toThrow(/can't take the flag/);
    const d = await world.verbs.review(mei, { docId: flag.id, decision: "continue" });
    expect(world.assignments.require(d.assignmentId!)).toMatchObject({ agentId: mei.id, queue: "building", lane: "directed", fromReportId: flag.id });
  });

  it("cancel cancels a queued assignment; started, ended and foreign ones are refused, as are non-managers", async () => {
    const { world, mei, noor, admin } = setup();
    const base = { title: "T", description: "d", gap: "g" };
    const q = await world.verbs.assign(mei, base);
    expect(await world.verbs.cancel(mei, { assignmentId: q.assignmentId })).toEqual({ assignmentId: q.assignmentId, status: "cancelled" });
    await expect(world.verbs.cancel(mei, { assignmentId: q.assignmentId })).rejects.toThrow(/already cancelled/);
    const started = await world.verbs.assign(mei, base);
    setAssignmentStatus(world, started.assignmentId, "active");
    await expect(world.verbs.cancel(mei, { assignmentId: started.assignmentId })).rejects.toThrow(expect.objectContaining({ code: "conflict" }));
    const mine = await world.verbs.assign(mei, base);
    await expect(world.verbs.cancel(noor, { assignmentId: mine.assignmentId })).rejects.toThrow(expect.objectContaining({ code: "forbidden" }));
    const foreign = world.ops.createWork(admin, noor.id, { title: "F" });
    world.assignments.patch(foreign.id, { buildingId: "town-hall" });
    await expect(world.verbs.cancel(mei, { assignmentId: foreign.id })).rejects.toThrow(/another building/);
    expect(world.assignments.require(mine.assignmentId).status).toBe("pending");
  });
});
