import { describe, expect, it } from "vitest";
import { buildingRoleId, exploreCapAt, exploreCapsOnPath, freeTokens, newId, nowIso } from "../src/index.ts";
import { askAt, seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";

/** root › A (an earmark of 3,000) › A1 (the lab), and a sibling B; the general balance is one 10,000 API-key credit. */
function setup() {
  const s = seededWorld();
  const { world, admin } = s;
  const a = world.goalTree.create(null, { parentId: "gl_town", text: "A" });
  const a1 = world.goalTree.create(null, { parentId: a.id, text: "A1" });
  const b = world.goalTree.create(null, { parentId: "gl_town", text: "B" });
  world.goalTree.attach(null, LAB, a1.id);
  const donor = world.ops.createUser("Donor").user;
  world.bank.addInput(admin.ownerUserId!, { label: "General", source: "api-key", model: "m", tokens: 10_000, apiKey: "sk-general" } as never);
  world.bank.addInput(donor.id, { label: "Earmark", source: "api-key", model: "m", tokens: 3_000, apiKey: "sk-earmark", goalId: a.id } as never);
  const manager = world.agents.first("homeBuildingId = ? AND kind != 'human'", [LAB])!;
  world.permissions.grant(manager, buildingRoleId(LAB, "manager"));
  const propose = (askTokens: number) => askAt(world, world.grantDesk.propose(manager, world.grantDesk.create(manager, LAB, { keyResults: [{ text: "k", howToCheck: "h" }], objective: "o", steps: [{ size: "M", title: "Step 1", description: "Do the work" }], stopCondition: "s", askTokens }).id), askTokens);
  const spend = (grantId: string, tokens: number) => world.sessions.upsert({
    id: newId("se"), agentId: manager.id, assignmentId: null, meetingId: null, purpose: "work", backend: "host", status: "done", model: "m",
    sdkSessionId: null, output: tokens, costUsd: 0, startedAt: nowIso(), endedAt: nowIso(), lane: "grant", grantId,
  } as never);
  return { ...s, a, a1, b, propose, spend };
}

describe("free tokens (docs/how-work-gets-done.md §7)", () => {
  it("with no claims: the general balance, plus the earmarks at or above the goal", () => {
    const { world, a1, b } = setup();
    expect(freeTokens(world, a1.id)).toEqual({ goalId: a1.id, generalTokens: 10_000, reserveTokens: 0, earmarkTokens: 3_000, fundedRemainingTokens: 0, openAsksTokens: 0, reservedTokens: 0, retainerTokens: 0, retainerJobs: 0, freeTokens: 13_000 });
    expect(freeTokens(world, b.id).freeTokens).toBe(10_000);
    expect(freeTokens(world, "gl_town").freeTokens).toBe(10_000);
    expect(world.bank.summary().free?.freeTokens).toBe(10_000);
  });

  it("claims are paid by the nearest earmark above their goal first, then the general balance, which every goal shares", () => {
    const { world, admin, a1, b, propose, spend } = setup();
    // a funded grant of 4,000 that spent 1,000 claims its 3,000 remaining: the earmark on A covers it
    const funded = world.grantDesk.decide(admin, propose(4_000).id, { action: "fund" });
    spend(funded.id, 1_000);
    // an open proposal's ask (2,000) and an open reservation (500 under B) claim the general balance
    propose(2_000);
    world.bankReservations.upsert({ id: newId("rv"), goalId: b.id, buildingId: LAB, assignmentId: null, tokens: 500, openedAt: nowIso(), closedAt: null, spentTokens: null });
    expect(freeTokens(world, a1.id)).toEqual({ goalId: a1.id, generalTokens: 10_000, reserveTokens: 0, earmarkTokens: 3_000, fundedRemainingTokens: 3_000, openAsksTokens: 2_000, reservedTokens: 500, retainerTokens: 0, retainerJobs: 0, freeTokens: 7_500 });
    expect(freeTokens(world, b.id).freeTokens).toBe(7_500);
    // a closed reservation and a closed grant claim nothing; the earmark's room comes back to its subtree only
    world.bankReservations.patch(world.bankReservations.all()[0]!.id, { closedAt: nowIso(), spentTokens: 200 });
    world.grants.patch(funded.id, { status: "closed" });
    expect(freeTokens(world, a1.id).freeTokens).toBe(10_000 + 1_000);
    expect(freeTokens(world, b.id).freeTokens).toBe(10_000);
    // never below 0
    propose(50_000);
    expect(freeTokens(world, b.id).freeTokens).toBe(0);
  });

  it("caps combine as the smallest on the path to the root: a captain tightens, never loosens (gr_yu6qw3j9x5)", () => {
    const { world, admin, a, a1 } = setup();
    expect(exploreCapAt(world.goals, a1.id)).toBeNull();
    world.goalTree.update(admin, "gl_town", { exploreCapTokensPerDay: 500_000 });
    world.goalTree.update(admin, a.id, { exploreCapTokensPerDay: 5_000_000 });
    expect(exploreCapAt(world.goals, a1.id)).toEqual({ tokensPerDay: 500_000, goalId: "gl_town" });
    expect(exploreCapAt(world.goals, a.id)).toEqual({ tokensPerDay: 500_000, goalId: "gl_town" });
    expect(exploreCapsOnPath(world.goals, a1.id)).toEqual([{ tokensPerDay: 5_000_000, goalId: a.id }, { tokensPerDay: 500_000, goalId: "gl_town" }]);
    world.goalTree.update(admin, a.id, { exploreCapTokensPerDay: 100_000 });
    expect(exploreCapAt(world.goals, a1.id)).toEqual({ tokensPerDay: 100_000, goalId: a.id });
    expect(world.goalTree.tree().children.find((c) => c.id === a.id)!.funding.exploreCap).toEqual({ tokensPerDay: 100_000, goalId: a.id });
  });

  it("the exploration cap is inherited from the nearest goal that sets one; none = uncapped; the tree shows it with the free tokens", () => {
    const { world, admin, a, a1 } = setup();
    expect(exploreCapAt(world.goals, a1.id)).toBeNull();
    world.goalTree.update(admin, "gl_town", { exploreCapTokensPerDay: 9_000 });
    world.goalTree.update(admin, a.id, { exploreCapTokensPerDay: 4_000 });
    expect(exploreCapAt(world.goals, a1.id)).toEqual({ tokensPerDay: 4_000, goalId: a.id });
    const node = world.goalTree.tree().children.find((c) => c.id === a.id)!.children[0]!;
    expect(node.funding).toMatchObject({ exploreCap: { tokensPerDay: 4_000, goalId: a.id }, exploreSpentTodayTokens: 0, free: { goalId: a1.id, freeTokens: 13_000 } });
    expect(node.exploreCapTokensPerDay).toBeNull();
  });

  describe("the operating reserve (1:1 mt_lb7tm75jgb)", () => {
    it("comes off the general balance before any claim; earmarks are untouched; never below 0", () => {
      const { world, a1, b } = setup();
      world.town.set({ operatingReserveTokens: 4_000 });
      expect(freeTokens(world, b.id)).toMatchObject({ generalTokens: 10_000, reserveTokens: 4_000, freeTokens: 6_000 });
      expect(freeTokens(world, a1.id).freeTokens).toBe(6_000 + 3_000);
      expect(world.bank.summary()).toMatchObject({ reserveTokens: 4_000, freeTokens: 6_000 });
      // a reserve above the balance leaves only the earmarks
      world.town.set({ operatingReserveTokens: 50_000 });
      expect(freeTokens(world, b.id).freeTokens).toBe(0);
      expect(freeTokens(world, a1.id).freeTokens).toBe(3_000);
    });

    it("funding a grant (or topping one up) past what is free is allowed: the shortfall is overdrawn and the grant waits its turn (1:1 mt_fgsticyyhr)", () => {
      const { world, admin, a1, propose, spend } = setup();
      world.town.set({ operatingReserveTokens: 4_000 });
      // free under A1: 10,000 − 4,000 + the 3,000 earmark = 9,000; funding 9,500 overdraws by 500 and still runs (partly covered)
      const big = world.grantDesk.decide(admin, propose(9_500).id, { action: "fund" });
      expect(big.status).toBe("funded");
      expect(freeTokens(world, a1.id)).toMatchObject({ freeTokens: 0, overdraftTokens: 500 });
      expect(world.events.list({ types: ["grant.funded"] }).at(-1)?.text).toMatch(/; 500 tokens overdrawn, partly covered, it runs until the Bank can cover it$/);
      // held at its checkpoint, a top-up past what is free goes through too
      spend(big.id, 9_000);
      world.grants.patch(big.id, { status: "checkpoint" });
      expect(world.grantDesk.decide(admin, big.id, { action: "adjust", tokens: 20_000 }).status).toBe("funded");
      // a second grant with nothing left to cover it: funded, its work waits
      const later = world.grantDesk.decide(admin, propose(5_000).id, { action: "fund" });
      expect(later.status).toBe("funded");
      expect(world.events.list({ types: ["grant.funded"] }).at(-1)?.text).toMatch(/5,000 tokens overdrawn, its work waits until the Bank can cover it$/);
    });

    it("manager sessions (1:1s, meetings, the team-lead wake) still draw on the balance below the reserve; work of every lane waits at it (Mitchell, 2026-11-02)", () => {
      const { world, admin, b } = setup();
      world.town.set({ operatingReserveTokens: 8_000 });
      const manager = world.agents.first("homeBuildingId = ? AND kind != 'human'", [LAB])!;
      const dir = world.ops.createWork(admin, manager.id, { title: "directed" });
      // above the reserve: directed work runs (there are free tokens: 10,000 + 3,000 earmark − 8,000)
      expect(world.budget.canStart(manager.id, dir)).toBe(true);
      const before = world.bank.balance();
      world.budget.charge(manager.id, 5_000, 0);
      expect(world.bank.balance()).toBe(before - 5_000);
      expect(world.bank.balance()).toBeLessThan(8_000);
      expect(freeTokens(world, b.id).freeTokens).toBe(0);
      // within the reserve: a session with no assignment (the manager's) starts and is still charged; directed work waits
      expect(world.budget.canStart(manager.id)).toBe(true);
      expect(world.budget.canStart(manager.id, dir)).toBe(false);
      expect(world.assignments.require(dir.id).heldReason).toMatch(/within the operating reserve/);
    });
  });
});
