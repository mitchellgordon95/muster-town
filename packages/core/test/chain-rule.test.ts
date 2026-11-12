import { describe, expect, it } from "vitest";
import { createBuilding, createUser } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";

/** root › A (the lab) › A1, and a sibling B no lab works on. One building per chain: docs/goals.md, gr_2r17x8egrc step 1. */
function setup() {
  const s = seededWorld();
  const { world, admin } = s;
  const tree = world.goalTree;
  const a = tree.create(admin, { parentId: "gl_town", text: "A" });
  const a1 = tree.create(admin, { parentId: a.id, text: "A1" });
  const b = tree.create(admin, { parentId: "gl_town", text: "B" });
  tree.attach(admin, LAB, a.id);
  return { ...s, tree, a, a1, b };
}

describe("one building per chain (gr_2r17x8egrc step 1)", () => {
  it("chainConflict finds a lab at, above or under the goal; the root and the Town Hall sit on no chain", () => {
    const { world, tree, a, a1, b } = setup();
    expect(tree.chainConflict(a.id)?.id).toBe(LAB);
    expect(tree.chainConflict(a1.id)?.id).toBe(LAB);
    expect(tree.chainConflict(a.id, LAB)).toBeUndefined();
    expect(tree.chainConflict(b.id)).toBeUndefined();
    expect(tree.chainConflict("gl_town")).toBeUndefined();
    // a lab under B makes B's chain occupied from above too
    const b1 = tree.create(null, { parentId: b.id, text: "B1" });
    const low = createBuilding(world, { name: "Low", goalId: b1.id }, null);
    expect(tree.chainConflict(b.id)?.id).toBe(low.id);
    // the Town Hall is attached at the root and is not a lab
    expect(world.buildings.require("town-hall").kind).toBe("town-hall");
  });

  it("createBuilding refuses a goal on an occupied chain (at, above, under) and allows the root and a free chain", () => {
    const { world, tree, a, a1, b } = setup();
    expect(() => createBuilding(world, { name: "Same", goalId: a.id }, null)).toThrow(/already works on this goal.*one building per chain/);
    expect(() => createBuilding(world, { name: "Below", goalId: a1.id }, null)).toThrow(/a goal above it/);
    const b1 = tree.create(null, { parentId: b.id, text: "B1" });
    createBuilding(world, { name: "Low", goalId: b1.id }, null);
    expect(() => createBuilding(world, { name: "Above", goalId: b.id }, null)).toThrow(/a goal under it/);
    expect(createBuilding(world, { name: "Fresh" }, null).goalId).toBe("gl_town");
    const c = tree.create(null, { parentId: "gl_town", text: "C" });
    expect(createBuilding(world, { name: "Free", goalId: c.id }, null).goalId).toBe(c.id);
  });

  it("attach refuses an occupied chain, before the desk totals; a lab may move along its own chain", () => {
    const { world, admin, tree, a, a1, b } = setup();
    const other = createBuilding(world, { name: "Other", goalId: b.id }, null);
    tree.update(admin, a.id, { desksTotal: 1 });
    expect(() => tree.attach(admin, other.id, a1.id)).toThrow(/one building per chain/);
    expect(() => tree.attach(admin, other.id, a.id)).toThrow(/one building per chain/);
    tree.update(admin, a.id, { desksTotal: null });
    // the lab itself moves down its own chain: nobody else is on it
    tree.attach(admin, LAB, a1.id);
    expect(world.buildings.require(LAB).goalId).toBe(a1.id);
  });

  it("adopt refuses a goal with a lab under it", () => {
    const { world, seed, a } = setup();
    const v = world.ops.registerVisitor(seed.admin.id, { name: "Vis" }).agent;
    expect(() => world.ops.adoptGoal(v.id, a.id)).toThrow(/register a visitor on goal/);
    const top = world.goalTree.create(null, { parentId: "gl_town", text: "Top" });
    world.goalTree.attach(null, LAB, world.goalTree.create(null, { parentId: top.id, text: "Under top" }).id);
    expect(() => world.ops.adoptGoal(v.id, top.id)).toThrow(/a goal under it.*one building per chain/);
  });

  it("a goal move a human makes is allowed, recorded on goal.moved, and the audit counts it as an accepted exception", () => {
    const { world, admin, seed, tree, a, b } = setup();
    const other = createBuilding(world, { name: "Other", goalId: b.id }, null);
    expect(tree.chainAudit()).toEqual({ violations: [], accepted: [] });
    tree.update(admin, b.id, { parentId: a.id });
    const moved = world.events.list({ types: ["goal.moved"] }).find((e) => e.payload.goalId === b.id)!;
    expect(moved.payload.chainOverlaps).toEqual([{ upperId: LAB, lowerId: other.id }]);
    expect(moved.text).toMatch(/puts Other under .* on one chain/);
    const audit = tree.chainAudit();
    expect(audit.violations).toEqual([]);
    expect(audit.accepted).toHaveLength(1);
    expect(audit.accepted[0]).toMatchObject({ upper: { id: LAB }, lower: { id: other.id }, acceptedBy: { goalId: b.id, userId: seed.admin.id } });
    const ev = tree.logChainAudit();
    expect(ev.accepted).toHaveLength(1);
    const sys = world.events.list({ types: ["system"] }).find((e) => e.payload.chainAudit)!;
    expect(sys.text).toMatch(/^chain audit: 0 violations, 1 accepted exception: accepted: Other under .* \(goal gl_\w+ moved by /);
  });

  it("an overlap no human accepted is a violation: a system move, or two labs set on one goal before the rule", () => {
    const { world, tree, a, b } = setup();
    const other = createBuilding(world, { name: "Other", goalId: b.id }, null);
    tree.update(null, b.id, { parentId: a.id });
    expect(tree.chainAudit().violations.map((p) => [p.upper.id, p.lower.id])).toEqual([[LAB, other.id]]);
    // a human moving it back clears it; a pre-rule pair on one goal stays a violation (reported once)
    const { user } = createUser(world, "Hu");
    world.permissions.grant({ kind: "user", id: user.id }, "role:admin");
    tree.update(world.ops.ensureAvatar(user.id), b.id, { parentId: "gl_town" });
    expect(tree.chainAudit()).toEqual({ violations: [], accepted: [] });
    world.buildings.upsert({ ...world.buildings.require(other.id), goalId: a.id });
    const audit = tree.logChainAudit();
    expect(audit.violations.map((p) => [p.upper.id, p.lower.id])).toEqual([[LAB, other.id]]);
    expect(world.events.list({ types: ["system"] }).find((e) => e.payload.chainAudit)!.text).toMatch(/^chain audit: 1 violation, 0 accepted exceptions: violation: Other under /);
  });
});
