import { describe, expect, it } from "vitest";
import { seededWorld } from "./helpers.ts";

describe("explicit building manager", () => {
  it("the manager set in settings facilitates; a stopped manager falls back to the first active resident by join order", () => {
    const { world, by, admin } = seededWorld();
    world.ops.updateBuilding(admin, "carbon-cycle", { managerAgentId: by("Mei").id });
    expect(world.buildings.require("carbon-cycle").managerAgentId).toBe(by("Mei").id);
    expect(world.ops.createMeeting(admin, { kind: "standup", buildingId: "carbon-cycle", startNow: true }).facilitatorId).toBe(by("Mei").id);
    world.ops.stopAgent(admin, by("Mei").id);
    expect(world.ops.createMeeting(admin, { kind: "retro", buildingId: "carbon-cycle", startNow: true }).facilitatorId).toBe(by("Noor").id);
  });

  it("with no manager, the first resident to join facilitates, not the first invitee by name", () => {
    const { world, admin } = seededWorld();
    world.ops.updateBuilding(admin, "carbon-cycle", { managerAgentId: null });
    const residents = world.agents.where("homeBuildingId = 'carbon-cycle' AND kind = 'resident'", [], "ORDER BY createdAt");
    const byName = [...residents].sort((a, b) => a.name.localeCompare(b.name));
    expect(byName[0].id).not.toBe(residents[0].id); // otherwise the test proves nothing
    const m = world.ops.createMeeting(admin, { kind: "standup", buildingId: "carbon-cycle", startNow: true, attendeeIds: byName.map((a) => a.id) });
    expect(m.facilitatorId).toBe(residents[0].id);
  });

  it("only an active resident of the building can be manager; members can't set it; null clears it", () => {
    const { world, by, admin } = seededWorld();
    expect(() => world.ops.updateBuilding(admin, "carbon-cycle", { managerAgentId: world.reorgs.planner()!.id })).toThrow(/resident of this building/);
    world.ops.stopAgent(admin, by("Noor").id);
    expect(() => world.ops.updateBuilding(admin, "carbon-cycle", { managerAgentId: by("Noor").id })).toThrow(/stopped/);
    expect(() => world.ops.updateBuilding(by("Mei"), "carbon-cycle", { managerAgentId: by("Mei").id })).toThrow();
    world.ops.updateBuilding(admin, "carbon-cycle", { managerAgentId: by("Mei").id });
    world.ops.updateBuilding(admin, "carbon-cycle", { managerAgentId: null });
    expect(world.buildings.require("carbon-cycle").managerAgentId).toBeNull();
  });
});
