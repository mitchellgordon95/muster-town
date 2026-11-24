/** A goal's desks bound the forks under it (gr_bre43gflz9 step 2): forks.ts `bindingDesks`, `goalDeskBound`, `freeDesks`. */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { branchAct } from "@muster-town/schema";
import { createBuilding, createResident, exploreRuleAt, forkManager, freeDesks, queueLane, retireFork, updateBuilding } from "../src/index.ts";
import { bindingDesks } from "../src/forks.ts";
import { exploreBlock } from "../src/explore.ts";
import { creditBank, seededWorld } from "./helpers.ts";

/** A 5-desk lab under a leaf goal, its manager Pix seated: 4 seats for forks. */
function lab() {
  const s = seededWorld();
  const { world, seed, admin } = s;
  const leaf = world.goalTree.create(admin, { parentId: "gl_town", text: "Leaf" });
  const b = createBuilding(world, { name: "Forky", headcount: 5, dailyTokensPerAgent: 1000, model: "claude-opus-5-5", cheapModel: "claude-haiku-5-5", goalId: leaf.id }, seed.admin.id);
  const pix = createResident(world, { buildingId: b.id, name: "Pix", sprite: 5 });
  updateBuilding(world, b.id, { managerAgentId: pix.id });
  creditBank(world);
  world.budget.donate(seed.admin.id, { tokens: 1_000_000, buildingId: b.id });
  const queue = async (title: string) => (await world.verbs.assign(world.agents.require(pix.id), { title, description: "d", gap: "test gap" })).assignmentId;
  return { ...s, leaf, b: () => world.buildings.require(b.id), queue };
}

describe("goal desks bound forks (gr_bre43gflz9 step 2)", () => {
  it("with no desks set on the path the building's seats are the bound; desks below the live forks hold the next one, naming the goal", async () => {
    const { world, admin, leaf, b, queue } = lab();
    expect(freeDesks(world, b())).toBe(4);
    const a1 = await queue("One"), a2 = await queue("Two");
    world.goalTree.update(admin, leaf.id, { desksTotal: 1 });
    expect(freeDesks(world, b())).toBe(1);
    const f1 = forkManager(world, b().id, a1).fork;
    expect(freeDesks(world, b())).toBe(0);
    const lane = queueLane(world, b().id);
    expect(lane.held.map((c) => c.id)).toEqual([a2]);
    expect(lane.held[0]!.heldReason).toBe(`held: desks full under goal "Leaf" (${leaf.id}): 1 desk, 1 fork running`);
    expect(exploreBlock(world, b())).toMatch(/desks full under goal "Leaf"/);
    // raise the desks and it may start; a fork that ends frees its desk under the goal
    world.goalTree.update(admin, leaf.id, { desksTotal: 2 });
    expect(freeDesks(world, b())).toBe(1);
    expect(queueLane(world, b().id).queued.map((c) => c.id)).toContain(a2);
    world.goalTree.update(admin, leaf.id, { desksTotal: 1 });
    retireFork(world, f1.id, {});
    expect(freeDesks(world, b())).toBe(1);
    // headcount stays the seats on the map: a big total never gives more forks than seats
    world.goalTree.update(admin, leaf.id, { desksTotal: null });
    world.goalTree.update(admin, "gl_town", { desksTotal: 400 });
    expect(freeDesks(world, b())).toBe(4);
  });

  it("the smallest desks left on the path binds: a total higher up counts forks in every building under it", async () => {
    const { world, admin, leaf, b, queue } = lab();
    const a1 = await queue("One");
    forkManager(world, b().id, a1);
    world.goalTree.update(admin, leaf.id, { desksTotal: 3 });
    world.goalTree.update(admin, "gl_town", { desksTotal: 1 });
    expect(freeDesks(world, b())).toBe(0);
    expect(queueLane(world, b().id).exploreBlock).toMatch(/"Make Muster Town|gl_town/);
  });
});

describe("the town's exploration switch (gr_bre43gflz9 step 2)", () => {
  it("off holds every explorer, whatever the goals say, and says it is the town's", () => {
    const { world, admin, b } = lab();
    world.setGrantPricing({ exploreOn: false }, admin.id);
    expect(exploreRuleAt(world, b().goalId!).on).toBe(false);
    expect(exploreBlock(world, b())).toBe("exploration is off for the town (town defaults)");
    world.setGrantPricing({ exploreOn: true }, admin.id);
    expect(exploreRuleAt(world, b().goalId!).on).toBe(true);
  });
});

describe("bindingDesks (pure)", () => {
  const goal = fc.record({ goalId: fc.string({ minLength: 1, maxLength: 4 }), text: fc.string(), desks: fc.nat(50), forks: fc.nat(60) });
  it("null exactly when no goal on the path sets desks; else the slack is the smallest desks left, never below 0, and names a goal on the path", () => {
    fc.assert(fc.property(fc.array(goal, { maxLength: 6 }), (path) => {
      const r = bindingDesks(path);
      if (!path.length) return r === null;
      const min = Math.min(...path.map((g) => Math.max(0, g.desks - g.forks)));
      return r !== null && r.slack === min && r.slack >= 0 && path.some((g) => g.goalId === r.goalId && Math.max(0, g.desks - g.forks) === min);
    }));
  });
  it("the nearest goal wins a tie", () => {
    expect(bindingDesks([{ goalId: "a", text: "", desks: 2, forks: 2 }, { goalId: "b", text: "", desks: 1, forks: 1 }])?.goalId).toBe("a");
  });
});

describe("goal ask buttons set desks (gr_bre43gflz9 step 2)", () => {
  it("desks:<n> and desks:none act on the goal; old cards' cap: and explore: still parse", () => {
    const goal = { targetKind: "goal" as const, type: "click" as const };
    expect(branchAct(goal, { label: "Give it 4 desks", action: "desks:4" })).toEqual({ kind: "goalSetting", set: { desksTotal: 4 } });
    expect(branchAct(goal, { label: "Clear", action: "desks:none" })).toEqual({ kind: "goalSetting", set: { desksTotal: null } });
    expect(branchAct(goal, { label: "Cap", action: "cap:100000" })).toEqual({ kind: "goalSetting", set: { exploreCapTokensPerDay: 100_000 } });
    expect(branchAct(goal, { label: "Off", action: "explore:off" })).toEqual({ kind: "goalSetting", set: { explore: false } });
    expect(branchAct(goal, { label: "Bad", action: "desks:-1" }).kind).not.toBe("goalSetting");
  });
});
