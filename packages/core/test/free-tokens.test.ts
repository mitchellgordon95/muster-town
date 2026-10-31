import { describe, expect, it } from "vitest";
import { buildingRoleId, exploreCapAt, freeTokens, newId, nowIso } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

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
  const kr = world.grantDesk.createKeyResult(admin, LAB, { text: "k", howToCheck: "h" });
  const propose = (askTokens: number) => world.grantDesk.propose(manager, world.grantDesk.create(manager, LAB, { keyResultId: kr.id, objective: "o", stopCondition: "s", askTokens }).id);
  const spend = (grantId: string, tokens: number) => world.sessions.upsert({
    id: newId("se"), agentId: manager.id, assignmentId: null, meetingId: null, purpose: "work", backend: "host", status: "done", model: "m",
    sdkSessionId: null, output: tokens, costUsd: 0, startedAt: nowIso(), endedAt: nowIso(), lane: "grant", grantId,
  } as never);
  return { ...s, a, a1, b, propose, spend };
}

describe("free tokens (docs/how-work-gets-done.md §7)", () => {
  it("with no claims: the general balance, plus the earmarks at or above the goal", () => {
    const { world, a1, b } = setup();
    expect(freeTokens(world, a1.id)).toEqual({ goalId: a1.id, generalTokens: 10_000, earmarkTokens: 3_000, fundedRemainingTokens: 0, openAsksTokens: 0, reservedTokens: 0, freeTokens: 13_000 });
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
    expect(freeTokens(world, a1.id)).toEqual({ goalId: a1.id, generalTokens: 10_000, earmarkTokens: 3_000, fundedRemainingTokens: 3_000, openAsksTokens: 2_000, reservedTokens: 500, freeTokens: 7_500 });
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
});
