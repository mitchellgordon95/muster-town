import { describe, expect, it } from "vitest";
import { RESIDENT_NAMES, STARTER_MANAGER_MODEL, createBuilding, suggestResidentName } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const residentsOf = (world: ReturnType<typeof seededWorld>["world"], id: string) =>
  world.agents.where("homeBuildingId = ? AND kind = 'resident'", [id], "ORDER BY createdAt");

describe("a new building starts with its one named manager, named by the town", () => {
  it("a building created from the UI/API gets exactly one agent: its manager, on Fable, with an unused name and a desk", () => {
    const { world, admin } = seededWorld();
    const before = new Set(world.agents.where().map((a) => a.name));
    const b = world.ops.createBuilding(admin, { name: "Onboarding" });
    const rs = residentsOf(world, b.id);
    expect(rs).toHaveLength(1);
    expect(world.agents.where("homeBuildingId = ?", [b.id])).toHaveLength(1);
    expect(before.has(rs[0].name)).toBe(false);
    expect(world.layout.deskOf(rs[0].id)).toBeDefined();
    expect(rs[0].model).toBe(STARTER_MANAGER_MODEL);
    expect(STARTER_MANAGER_MODEL).toBe("claude-fable-5-1");
    expect(world.buildings.require(b.id).managerAgentId).toBe(rs[0].id);
  });

  it("a building drawn on the town plan gets the same single manager", () => {
    const { world } = seededWorld();
    const b = createBuilding(world, { name: "Pair", headcount: 2 }, null, { starterResidents: true });
    const rs = residentsOf(world, b.id);
    expect(rs.map((a) => [a.id, a.model])).toEqual([[world.buildings.require(b.id).managerAgentId, "claude-fable-5-1"]]);
  });

  it("there is no op to add a resident (no standing residents, 1:1 mt_wngibcr98b decision 1)", () => {
    const { world } = seededWorld();
    expect((world.ops as unknown as Record<string, unknown>).createResident).toBeUndefined();
    expect((world.ops as unknown as Record<string, unknown>).delegateAssignment).toBeUndefined();
  });

  it("suggestions skip taken and avoided names, then number them when the pool runs out", () => {
    const { world } = seededWorld();
    const taken = world.agents.where().map((a) => a.name);
    const n = suggestResidentName(world, ["Wren"]);
    expect([...taken, "Wren"].map((x) => x.toLowerCase())).not.toContain(n.toLowerCase());
    expect(suggestResidentName(world, RESIDENT_NAMES)).toMatch(/ 2$/);
  });
});
