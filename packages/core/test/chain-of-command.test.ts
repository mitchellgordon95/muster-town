import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { answererOf, chainOfCommand, type ChainBuilding, type ChainGoal } from "../src/chain-of-command.ts";
import { createBuilding, createUser } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const ROOT = "g0";

/** A random goal tree rooted at g0 (each goal's parent is an earlier goal), some captained, and buildings on random goals (or none / unknown). */
const town = fc.integer({ min: 1, max: 25 }).chain((n) => fc.record({
  parents: fc.array(fc.nat(), { minLength: n - 1, maxLength: n - 1 }),
  owners: fc.array(fc.option(fc.constantFrom("us_a", "us_b", "us_c"), { nil: null }), { minLength: n, maxLength: n }),
  buildings: fc.array(fc.option(fc.integer({ min: -1, max: n - 1 }), { nil: null }), { maxLength: 12 }),
}).map(({ parents, owners, buildings }) => {
  const goals: ChainGoal[] = owners.map((ownerId, i) => ({ id: `g${i}`, parentId: i === 0 ? null : `g${parents[i - 1]! % i}`, ownerId }));
  const bs: ChainBuilding[] = buildings.map((at, i) => ({ id: `b${i}`, goalId: at == null ? null : at < 0 ? "g_unknown" : `g${at}` }));
  return { goals, buildings: bs, rootId: ROOT };
}));

/** The goal and its ancestors, the goal first (an unknown goal = the root's chain). */
function chainOf(goals: ChainGoal[], goalId: string | null): string[] {
  const byId = new Map(goals.map((g) => [g.id, g]));
  const out: string[] = [];
  for (let g = byId.get(goalId ?? ROOT) ?? byId.get(ROOT); g; g = g.parentId ? byId.get(g.parentId) : undefined) out.push(g.id);
  return out;
}

describe("chainOfCommand: the goal tree in, each building's answerer out (mt_msnjkpgwdb decisions 13, 15)", () => {
  it("total: every building gets exactly one answerer", () => {
    fc.assert(fc.property(town, (t) => {
      const map = chainOfCommand(t);
      expect([...map.keys()].sort()).toEqual(t.buildings.map((b) => b.id).sort());
    }));
  });

  it("the answerer is the building's goal or an ancestor; captained unless it is the root; and the nearest such", () => {
    fc.assert(fc.property(town, (t) => {
      const owner = new Map(t.goals.map((g) => [g.id, g.ownerId]));
      for (const [bid, a] of chainOfCommand(t)) {
        const chain = chainOf(t.goals, t.buildings.find((b) => b.id === bid)!.goalId);
        const at = chain.indexOf(a.answererGoalId);
        expect(at).toBeGreaterThanOrEqual(0);
        if (a.answererGoalId !== ROOT) expect(owner.get(a.answererGoalId)).toBeTruthy();
        expect(a.userId).toBe(owner.get(a.answererGoalId) ?? null);
        // nothing captained strictly below it on the chain
        expect(chain.slice(0, at).some((id) => owner.get(id))).toBe(false);
      }
    }));
  });

  it("adding a captain to a goal never moves an answerer upward", () => {
    fc.assert(fc.property(town, fc.nat(), (t, pick) => {
      const target = t.goals[pick % t.goals.length]!;
      const before = chainOfCommand(t);
      const after = chainOfCommand({ ...t, goals: t.goals.map((g) => g.id === target.id ? { ...g, ownerId: "us_new" } : g) });
      for (const b of t.buildings) {
        const chain = chainOf(t.goals, b.goalId);
        // depth on the chain: 0 = the building's goal; a larger index is higher up
        expect(chain.indexOf(after.get(b.id)!.answererGoalId)).toBeLessThanOrEqual(chain.indexOf(before.get(b.id)!.answererGoalId));
      }
    }));
  });

  it("UI / UX under the Workshop's Steer answers to the root, past the Workshop (Mitchell's example)", () => {
    const goals: ChainGoal[] = [
      { id: "gl_town", parentId: null, ownerId: "us_mitchell" },
      { id: "gl_join", parentId: "gl_town", ownerId: null },
      { id: "gl_uiux", parentId: "gl_join", ownerId: null },
      { id: "gl_bank", parentId: "gl_town", ownerId: "us_cap" },
      { id: "gl_bank_sub", parentId: "gl_bank", ownerId: null },
    ];
    const map = chainOfCommand({ rootId: "gl_town", goals, buildings: [{ id: "workshop", goalId: "gl_join" }, { id: "uiux", goalId: "gl_uiux" }, { id: "bank", goalId: "gl_bank_sub" }] });
    expect(map.get("uiux")).toEqual({ answererGoalId: "gl_town", userId: "us_mitchell" });
    expect(map.get("workshop")).toEqual({ answererGoalId: "gl_town", userId: "us_mitchell" });
    expect(map.get("bank")).toEqual({ answererGoalId: "gl_bank", userId: "us_cap" });
    // an uncaptained root answers with no user: the shell (Goals.ownerOf) fills in the first admin
    expect(answererOf("gl_uiux", (id) => goals.map((g) => g.id === "gl_town" ? { ...g, ownerId: null } : g).find((g) => g.id === id), "gl_town")).toEqual({ answererGoalId: "gl_town", userId: null });
  });

  it("the live town reads the same rule: Goals.ownerOf and route agree with chainOfCommand", () => {
    const { world, admin } = seededWorld();
    const tree = world.goalTree;
    const top = tree.create(admin, { parentId: "gl_join", text: "Top" });
    const mid = tree.create(admin, { parentId: top.id, text: "Mid" });
    const low = tree.create(admin, { parentId: mid.id, text: "Low" });
    tree.update(admin, top.id, { ownerId: createUser(world, "Cap").user.id });
    for (const [name, g] of [["Top lab", top], ["Low lab", low]] as const) createBuilding(world, { name, goalId: g.id }, null);
    const map = chainOfCommand({ goals: world.goals.all(), buildings: world.buildings.all(), rootId: tree.root().id });
    for (const b of world.buildings.all()) {
      const a = map.get(b.id)!;
      expect(tree.route({ buildingId: b.id })).toEqual({ goalId: a.answererGoalId, userId: a.userId ?? tree.ownerOf(tree.root().id).userId });
    }
    expect(tree.ownerOf(low.id).goalId).toBe(top.id);
  });
});

describe("one building per goal (decision 13): refusals, nesting stays legal", () => {
  function setup() {
    const s = seededWorld();
    const tree = s.world.goalTree;
    const goal = tree.create(s.admin, { parentId: "gl_join", text: "Taken" });
    const under = tree.create(s.admin, { parentId: goal.id, text: "Under it" });
    const lab = createBuilding(s.world, { name: "First", goalId: goal.id }, null);
    return { ...s, tree, goal, under, lab };
  }

  it("createBuilding refuses a goal that already has a building on it (POST /api/buildings: 409); nesting under it is fine; the root is exempt", () => {
    const { world, goal, under, lab, tree } = setup();
    expect(() => createBuilding(world, { name: "Second", goalId: goal.id }, null)).toThrow(/First .* already works on "Taken": one building per goal/);
    try { createBuilding(world, { name: "Second", goalId: goal.id }, null); } catch (e) { expect((e as { code?: string }).code).toBe("conflict"); }
    const nested = createBuilding(world, { name: "Nested", goalId: under.id }, null);
    expect(tree.nearestBuilding(under.id)?.id).toBe(nested.id);
    expect(tree.nearestBuilding(tree.create(null, { parentId: under.id, text: "Deeper" }).id)?.id).toBe(nested.id);
    expect(tree.nearestBuilding(goal.id)?.id).toBe(lab.id);
    createBuilding(world, { name: "Root one" }, null);
    createBuilding(world, { name: "Root two" }, null);
  });

  it("attach refuses a goal that has another building; re-attaching to its own goal is a no-op", () => {
    const { world, admin, tree, goal, under } = setup();
    const other = createBuilding(world, { name: "Other", goalId: under.id }, null);
    expect(() => tree.attach(admin, other.id, goal.id)).toThrow(/one building per goal/);
    expect(() => world.ops.updateBuilding(admin, other.id, { goalId: goal.id })).toThrow(/one building per goal/);
    expect(tree.attach(admin, other.id, under.id).goalId).toBe(under.id);
  });

  it("adopt refuses a goal with a building on it (and, the visitor path, one above it): register there instead", () => {
    const { world, seed, goal, under } = setup();
    const v = world.ops.registerVisitor(seed.admin.id, { name: "Vis" }).agent;
    for (const g of [goal.id, under.id]) expect(() => world.ops.adoptGoal(v.id, g)).toThrow(/register a visitor on goal/);
  });

  it("retire's move refuses to land a second building on the sibling", () => {
    const { world, admin, tree, goal } = setup();
    const sib = tree.create(admin, { parentId: "gl_join", text: "Sibling" });
    createBuilding(world, { name: "On sibling", goalId: sib.id }, null);
    expect(() => tree.retire(admin, goal.id, { moveTo: sib.id })).toThrow(/one building per goal/);
    const empty = tree.create(admin, { parentId: "gl_join", text: "Empty sibling" });
    expect(tree.retire(admin, goal.id, { moveTo: empty.id }).status).toBe("retired");
  });

  it("moving a goal keeps its building: nesting a goal with a building under another building's goal is legal", () => {
    const { world, admin, tree, goal } = setup();
    const elsewhere = tree.create(admin, { parentId: "gl_trust", text: "Elsewhere" });
    createBuilding(world, { name: "Elsewhere lab", goalId: elsewhere.id }, null);
    expect(tree.update(admin, goal.id, { parentId: elsewhere.id }).parentId).toBe(elsewhere.id);
  });
});
