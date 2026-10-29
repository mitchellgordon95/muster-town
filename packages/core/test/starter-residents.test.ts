import { describe, expect, it } from "vitest";
import { RESIDENT_NAMES, createBuilding, suggestResidentName } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const residentsOf = (world: ReturnType<typeof seededWorld>["world"], id: string) =>
  world.agents.where("homeBuildingId = ? AND kind = 'resident'", [id], "ORDER BY createdAt");

describe("new buildings start with residents, named by the town", () => {
  it("a building created from the UI/API gets 3 residents with distinct, unused names; the first is its manager", () => {
    const { world, admin } = seededWorld();
    const before = new Set(world.agents.where().map((a) => a.name));
    const b = world.ops.createBuilding(admin, { name: "Onboarding" });
    const rs = residentsOf(world, b.id);
    expect(rs).toHaveLength(3);
    expect(new Set(rs.map((a) => a.name)).size).toBe(3);
    for (const a of rs) { expect(before.has(a.name)).toBe(false); expect(world.layout.deskOf(a.id)).toBeDefined(); }
    expect(world.buildings.require(b.id).managerAgentId).toBe(rs[0].id);
  });

  it("headcount caps the starter residents", () => {
    const { world, admin } = seededWorld();
    expect(residentsOf(world, createBuilding(world, { name: "Pair", headcount: 2 }, null, { starterResidents: true }).id)).toHaveLength(2);
  });

  it("a resident added without a name gets a free one", () => {
    const { world, admin } = seededWorld();
    const b = world.ops.createBuilding(admin, { name: "Lab" });
    const a = world.ops.createResident(admin, { buildingId: b.id });
    expect(a.name).toBeTruthy();
    expect(world.agents.where("lower(name) = lower(?)", [a.name])).toHaveLength(1);
    expect(world.ops.createResident(admin, { buildingId: b.id, name: "  Lena  " }).name).toBe("Lena");
  });

  it("suggestions skip taken and avoided names, then number them when the pool runs out", () => {
    const { world } = seededWorld();
    const taken = world.agents.where().map((a) => a.name);
    const n = suggestResidentName(world, ["Wren"]);
    expect([...taken, "Wren"].map((x) => x.toLowerCase())).not.toContain(n.toLowerCase());
    expect(suggestResidentName(world, RESIDENT_NAMES)).toMatch(/ 2$/);
  });
});
