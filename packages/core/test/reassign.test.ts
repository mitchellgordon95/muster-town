/** The manager's `reassign` and `cancel` verbs: queued work in its own building moves or goes, lane and waitFor kept. */
import { describe, expect, it } from "vitest";
import { buildingRoleId, pendingQueue, setAssignmentStatus } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";

function setup() {
  const s = seededWorld();
  const { world, by, admin } = s;
  const mei = by("Mei"), noor = by("Noor");
  const kr = world.grantDesk.createKeyResult(admin, LAB, { text: "A visitor can see spend", howToCheck: "Open the banner" });
  world.ops.updateBuilding(admin, LAB, { managerAgentId: mei.id });
  world.permissions.grant({ kind: "agent", id: mei.id }, buildingRoleId(LAB, "manager"));
  const g = world.grantDesk.decide(admin, world.grantDesk.propose(mei, world.grantDesk.create(mei, LAB, { keyResultId: kr.id, objective: "o", stopCondition: "s", askTokens: 1_000_000 }).id).id, { action: "fund" });
  const residents = world.agents.where("kind = 'resident' AND homeBuildingId = ? AND id NOT IN (?, ?)", [LAB, mei.id, noor.id]);
  return { ...s, mei, noor, other: residents[0]!, kr, g };
}

describe("manager verbs: reassign and cancel", () => {
  it("reassign moves a queued grant assignment to another resident, keeping lane, grant, key result and waitFor", async () => {
    const { world, mei, noor, other, kr, g } = setup();
    const a = await world.verbs.assign(mei, { agentId: noor.id, title: "T1", description: "d", lane: "grant", grantId: g.id, waitFor: { deploy: "next" } });
    const r = await world.verbs.reassign(mei, { assignmentId: a.assignmentId, agentId: other.id });
    expect(world.assignments.require(a.assignmentId).status).toBe("cancelled");
    expect(world.assignments.require(r.assignmentId)).toMatchObject({
      agentId: other.id, buildingId: LAB, status: "pending", title: "T1", description: "d", lane: "grant", grantId: g.id, keyResultId: kr.id,
      fromAssignmentId: a.assignmentId, waitFor: { deploy: "next" },
    });
    expect(r).toMatchObject({ from: { assignmentId: a.assignmentId, agentId: noor.id }, agentId: other.id, lane: "grant", grantId: g.id });
    expect(pendingQueue(world, noor.id).map((x) => x.title)).not.toContain("T1");
    expect(world.events.recent({ limit: 10 }).some((e) => e.type === "assignment.delegated" && e.payload.toAgentId === other.id)).toBe(true);
    expect(world.messages.where("toId = ?", [other.id]).some((m) => m.body.includes("T1") && m.body.includes("was Noor's"))).toBe(true);
  });

  it("cancel cancels a queued assignment; started, ended and foreign ones are refused, as are non-managers and outsiders", async () => {
    const { world, mei, noor, other, g, admin } = setup();
    const base = { title: "T", description: "d", lane: "grant" as const, grantId: g.id };
    const q = await world.verbs.assign(mei, { agentId: noor.id, ...base });
    expect(await world.verbs.cancel(mei, { assignmentId: q.assignmentId })).toEqual({ assignmentId: q.assignmentId, status: "cancelled" });
    await expect(world.verbs.cancel(mei, { assignmentId: q.assignmentId })).rejects.toThrow(/already cancelled/);
    await expect(world.verbs.reassign(mei, { assignmentId: q.assignmentId, agentId: other.id })).rejects.toThrow(/already cancelled/);

    const started = await world.verbs.assign(mei, { agentId: noor.id, ...base });
    setAssignmentStatus(world, started.assignmentId, "active");
    await expect(world.verbs.reassign(mei, { assignmentId: started.assignmentId, agentId: other.id })).rejects.toThrow(/has started/);
    await expect(world.verbs.cancel(mei, { assignmentId: started.assignmentId })).rejects.toThrow(expect.objectContaining({ code: "conflict" }));

    // a resident without building.assign can't
    const mine = await world.verbs.assign(mei, { agentId: noor.id, ...base });
    await expect(world.verbs.cancel(noor, { assignmentId: mine.assignmentId })).rejects.toThrow(expect.objectContaining({ code: "forbidden" }));
    await expect(world.verbs.reassign(noor, { assignmentId: mine.assignmentId, agentId: other.id })).rejects.toThrow(expect.objectContaining({ code: "forbidden" }));
    // not to someone outside the building
    await expect(world.verbs.reassign(mei, { assignmentId: mine.assignmentId, agentId: admin.id })).rejects.toThrow(/isn't a resident/);
    // another building's assignment
    const foreign = world.ops.createWork(admin, noor.id, { title: "F" });
    world.assignments.patch(foreign.id, { buildingId: "town-hall" });
    await expect(world.verbs.cancel(mei, { assignmentId: foreign.id })).rejects.toThrow(/another building/);
    await expect(world.verbs.reassign(mei, { assignmentId: foreign.id, agentId: other.id })).rejects.toThrow(/another building/);
    expect(world.assignments.require(mine.assignmentId).status).toBe("pending");
    expect(world.assignments.require(foreign.id).status).toBe("pending");
  });
});
