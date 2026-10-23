/** Design review 5: the manager agent is a building's conversational surface; residents work from assignments. */
import { describe, expect, it } from "vitest";
import { seededWorld } from "./helpers.ts";

describe("ops.messageAgent: residents route through their manager", () => {
  it("a resident with a manager agent in its building refuses messages and names the manager; the manager takes them; a building without one keeps direct messages", async () => {
    const s = seededWorld();
    const { world, by } = s;
    const userId = s.seed.admin.id;
    const mei = by("Mei"), noor = by("Noor");
    const bid = mei.homeBuildingId!;
    expect(world.buildings.require(bid).managerAgentId).toBeNull();
    await expect(world.ops.messageAgent(userId, mei.id, "hi", { isWorking: () => false })).resolves.toMatchObject({ mode: "started" });
    world.buildings.patch(bid, { managerAgentId: noor.id });
    await expect(world.ops.messageAgent(userId, mei.id, "hi again", { isWorking: () => false })).rejects.toThrow(/Talk to Noor, its manager/);
    await expect(world.ops.messageAgent(userId, noor.id, "hello manager", { isWorking: () => false })).resolves.toMatchObject({ mode: "started" });
    // assigning work directly still works: residents are driven by assignments
    expect(world.ops.createWork(null, mei.id, { title: "Direct", description: "do it" })).toMatchObject({ agentId: mei.id, status: "pending" });
    // a retired manager doesn't block the building
    world.agents.patch(noor.id, { status: "retired" });
    await expect(world.ops.messageAgent(userId, mei.id, "manager gone", { isWorking: () => false })).resolves.toMatchObject({ mode: "started" });
  });
});
