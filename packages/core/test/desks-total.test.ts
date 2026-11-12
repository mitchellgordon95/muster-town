import { describe, expect, it } from "vitest";
import { createBuilding, createResident, createUser, desksTotalAt } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";

/** root › A (captained by Lena) › A1 (the lab, 3 desks), and a sibling B. Desks per subtree: 1:1 mt_a6wb51enia, gr_yu6qw3j9x5. */
function setup() {
  const s = seededWorld();
  const { world, admin } = s;
  const tree = world.goalTree;
  const a = tree.create(admin, { parentId: "gl_town", text: "A" });
  const a1 = tree.create(admin, { parentId: a.id, text: "A1" });
  const b = tree.create(admin, { parentId: "gl_town", text: "B" });
  tree.attach(admin, LAB, a1.id);
  world.ops.updateBuilding(admin, LAB, { headcount: 3 });
  const lena = createUser(world, "Lena").user;
  const lenaAv = world.ops.ensureAvatar(lena.id);
  tree.update(admin, a.id, { ownerId: lena.id });
  return { ...s, tree, a, a1, b, lena, lenaAv };
}

describe("desks per subtree: goals.desksTotal (gr_yu6qw3j9x5)", () => {
  it("totals combine as the smallest on the path to the root, with the goal that sets it; the tree shows it with the desks there", () => {
    const { world, admin, tree, a, a1 } = setup();
    expect(desksTotalAt(world.goals, a1.id)).toBeNull();
    tree.update(admin, "gl_town", { desksTotal: 40 });
    tree.update(admin, a.id, { desksTotal: 80 });
    expect(desksTotalAt(world.goals, a1.id)).toEqual({ total: 40, goalId: "gl_town" });
    tree.update(admin, a.id, { desksTotal: 5 });
    expect(desksTotalAt(world.goals, a1.id)).toEqual({ total: 5, goalId: a.id });
    const node = tree.tree().children.find((c) => c.id === a.id)!;
    expect(node.desksTotal).toBe(5);
    expect(node.funding.desksTotal).toEqual({ total: 5, goalId: a.id, desks: 3 });
    expect(node.children[0]!.funding.desksTotal).toEqual({ total: 5, goalId: a.id, desks: 3 });
    expect(tree.tree().funding.desksTotal?.goalId).toBe("gl_town");
  });

  it("a captain sets a total in their subtree but never above the one in force over them; others can't set one", () => {
    const { world, admin, tree, a, a1, b, lenaAv } = setup();
    tree.update(admin, "gl_town", { desksTotal: 10 });
    expect(() => tree.update(lenaAv, a.id, { desksTotal: 11 })).toThrow(/desk total of 10/);
    tree.update(lenaAv, a.id, { desksTotal: 8 });
    expect(() => tree.update(lenaAv, a1.id, { desksTotal: 9 })).toThrow(/desk total of 8/);
    tree.update(lenaAv, a1.id, { desksTotal: 4 });
    expect(desksTotalAt(world.goals, a1.id)).toEqual({ total: 4, goalId: a1.id });
    expect(() => tree.update(lenaAv, b.id, { desksTotal: 2 })).toThrow(/captain/);
    // an admin is not held by the one above (the smaller still binds)
    tree.update(admin, b.id, { desksTotal: 20 });
    expect(desksTotalAt(world.goals, b.id)).toEqual({ total: 10, goalId: "gl_town" });
  });

  it("raising desks past a total in force is a 409 naming the goal and its total, for admins too; lowering a total below the desks now only blocks raises", () => {
    const { world, admin, tree, a, a1, b } = setup();
    tree.update(admin, a.id, { desksTotal: 5 });
    world.ops.updateBuilding(admin, LAB, { headcount: 5 });
    expect(() => world.ops.updateBuilding(admin, LAB, { headcount: 6 })).toThrow(/Desk total reached: "A" .* allows 5 desks/);
    // a new building under A, or one moving in, brings desks too (on A2, a chain of its own: one building per chain)
    const a2 = tree.create(admin, { parentId: a.id, text: "A2" });
    expect(() => createBuilding(world, { name: "New", goalId: a2.id, headcount: 1 }, null)).toThrow(/Desk total reached/);
    const other = createBuilding(world, { name: "Other", goalId: b.id, headcount: 2 }, null);
    expect(() => tree.attach(admin, other.id, a2.id)).toThrow(/Desk total reached/);
    // a total under the desks there now is allowed; lowering always is; raising stays blocked until it fits
    tree.update(admin, a.id, { desksTotal: 3 });
    world.ops.updateBuilding(admin, LAB, { headcount: 4 });
    expect(world.buildings.require(LAB).headcount).toBe(4);
    expect(() => world.ops.updateBuilding(admin, LAB, { headcount: 5 })).toThrow(/at most 3, not 5/);
    tree.update(admin, a.id, { desksTotal: null });
    world.ops.updateBuilding(admin, LAB, { headcount: 6 });
    expect(world.buildings.require(LAB).headcount).toBe(6);
  });

  it("a named resident joining a full lab (claimDesk with grow) is held by the same total: 409 with the same message, nothing grows", () => {
    const { world, admin, tree, a } = setup();
    // the seeded lab is full (setup lowered it to 3 desks under its residents); the total is what is there now
    expect(world.layout.deskCount(LAB)).toBeGreaterThanOrEqual(3);
    tree.update(admin, a.id, { desksTotal: 3 });
    const desks = world.layout.deskCount(LAB);
    const residents = world.agents.count("homeBuildingId = ? AND kind = 'resident'", [LAB]);
    expect(() => createResident(world, { buildingId: LAB, name: "Extra" })).toThrow(/Desk total reached: "A" .* allows 3 desks under it and has 0 elsewhere, so Carbon Cycle Lab can have at most 3, not \d+/);
    // the transaction rolled back: no new resident, no new desk, headcount unchanged
    expect(world.buildings.require(LAB).headcount).toBe(3);
    expect(world.layout.deskCount(LAB)).toBe(desks);
    expect(world.agents.count("homeBuildingId = ? AND kind = 'resident'", [LAB])).toBe(residents);
    // with no total in force the lab grows as before
    tree.update(admin, a.id, { desksTotal: null });
    createResident(world, { buildingId: LAB, name: "Extra" });
    expect(world.buildings.require(LAB).headcount).toBeGreaterThan(3);
    expect(world.layout.deskCount(LAB)).toBe(desks + 1);
  });
});
