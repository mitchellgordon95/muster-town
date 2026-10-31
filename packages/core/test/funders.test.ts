import { describe, expect, it } from "vitest";
import { adjustedOfUsage } from "../src/bank.ts";
import { funderSlide } from "@muster-town/schema";
import { createAssignment, funderWeek, funderWeights, worldGoalSpend } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";
const DAY = 86_400_000;
const TOKEN = "sk-ant-oat01-" + "b".repeat(80);

/**
 * A key donor with an earmark on a child goal, the admin's town key and a credited subscription, and three sessions:
 * one on the earmark (literal), one on the subscription (pooled), one older than the window.
 */
function setup() {
  const s = seededWorld();
  const { world, admin } = s;
  const manager = world.agents.first("homeBuildingId = ? AND kind != 'human'", [LAB])!;
  const child = world.goalTree.create(admin, { parentId: world.goalTree.attachmentOf(LAB), text: "Child goal" });
  const kr = world.goalTree.addKeyResult(admin, child.id, { text: "A thing", howToCheck: "Look", due: "2026-12-31" } as never);
  const townKey = world.bank.addInput(admin.ownerUserId!, { label: "Town key", source: "api-key", model: "m", tokens: 1_000_000, apiKey: "sk-town" } as never);
  const sub = world.bank.addInput(admin.ownerUserId!, { label: "Max plan", source: "subscription", model: "claude-opus-5-5", tokens: 500_000, recurrence: "daily", weeklyCapTokens: 3_500_000, token: TOKEN } as never);
  const donor = world.ops.createUser("Donor").user;
  const earmark = world.bank.addInput(donor.id, { label: "My key", source: "api-key", model: "m", tokens: 800_000, apiKey: "sk-mine", goalId: child.id } as never);
  const asg = createAssignment(world, { agentId: manager.id, title: "Build the thing", description: "d", createdBy: { kind: "system", id: "system" } });
  world.assignments.patch(asg.id, { keyResultId: kr.id });
  const now = new Date();
  const run = (credentialInputId: string | null, output: number, endedAt = now, assignmentId: string | null = asg.id) => {
    const x = world.ops.startSession(manager.id, { purpose: "work", model: "claude-opus-5-5", assignmentId, credentialInputId });
    world.sessions.patch(x.id, { output, status: "done", endedAt: new Date(endedAt.getTime() - 1000).toISOString() });
    return world.sessions.require(x.id);
  };
  const lit = run(earmark.id, 40_000);
  const pooled = run(sub.id, 20_000, now, null);
  const old = run(earmark.id, 99_000, new Date(now.getTime() - 8 * DAY));
  return { ...s, manager, child, kr, townKey, sub, donor, earmark, asg, lit, pooled, old };
}

const adj = (s: { model: string; output: number }) => adjustedOfUsage(s.model, { output: s.output });

describe("the funder filter (goal tree build step 8): read-only", () => {
  it("a key donor gets the literal story: the sessions on their key in the window, with assignment and KR", () => {
    const { world, donor, earmark, lit, kr, asg, child } = setup();
    const before = { balance: world.bank.balance(), earmark: world.bank.inputBalance(earmark.id), debits: world.events.list({ types: ["bank.debited"] }).length };
    const w = funderWeek(world, donor.id);
    expect(w.literal.sessions.map((l) => l.sessionId)).toEqual([lit.id]);
    expect(w.literal.sessions[0]).toMatchObject({ assignmentId: asg.id, title: "Build the thing", keyResultId: kr.id, goalId: child.id, inputId: earmark.id, tokens: adj(lit) });
    expect(w.literal.tokens).toBe(adj(lit));
    expect(w.streams).toEqual([expect.objectContaining({ inputId: earmark.id, story: "literal", sessions: 1, tokens: adj(lit), goalId: child.id })]);
    expect(w.proRata).toMatchObject({ share: 0, tokens: 0, byAssignment: [] });
    expect(w.everything).toBe(false);
    expect(w.goalIds).toContain(child.id);
    // nothing booked, drawn or logged
    expect({ balance: world.bank.balance(), earmark: world.bank.inputBalance(earmark.id), debits: world.events.list({ types: ["bank.debited"] }).length }).toEqual(before);
  });

  it("a subscription donor gets the pro rata story: their share of the subscription credits, over sessions on no key", () => {
    const { world, admin, pooled, sub } = setup();
    const w = funderWeek(world, admin.ownerUserId!);
    expect(w.proRata.share).toBe(1); // the only subscription that credited in the window is theirs
    expect(w.proRata.poolSessions).toBe(1);
    expect(w.proRata.tokens).toBe(adj(pooled));
    expect(w.proRata.byAssignment[0]).toMatchObject({ sessionId: pooled.id, inputId: null });
    expect(w.literal.sessions).toEqual([]); // no session ran on the town key
    expect(w.everything).toBe(true);
    expect(w.streams.find((s) => s.inputId === sub.id)).toMatchObject({ story: "pro-rata" });
    expect(w.streams.find((s) => s.inputId === sub.id)!.creditedTokens).toBeGreaterThan(0);
  });

  it("the Spend tab's funder filter keeps only what that funder paid for", () => {
    const { world, donor, admin, child, lit, pooled } = setup();
    expect(funderWeights(world, donor.id)).toEqual(new Map([[lit.id, 1]]));
    expect(worldGoalSpend(world, child.id, 7, new Date(), donor.id)).toMatchObject({ sessions: 1, total: adj(lit) });
    const top = world.goalTree.attachmentOf(LAB);
    const all = worldGoalSpend(world, top);
    expect(all.sessions).toBe(2);
    expect(worldGoalSpend(world, top, 7, new Date(), admin.ownerUserId!)).toMatchObject({ sessions: 1, total: adj(pooled) });
  });

  it("the deck's slide 1 for a funder tells both stories", () => {
    const { world, donor, admin } = setup();
    const s = funderSlide(funderWeek(world, donor.id));
    expect(s).toMatchObject({ kind: "funder", group: 0, itemId: null, title: "Your week as a funder" });
    expect(s.text).toContain("## Sessions that ran on your key (1,");
    expect(s.text).toContain("Build the thing");
    expect(s.text).not.toContain("pooled week");
    expect(funderSlide(funderWeek(world, admin.ownerUserId!)).text).toContain("## Your share of the pooled week (100%");
    const nobody = world.ops.createUser("Nobody").user;
    expect(funderSlide(funderWeek(world, nobody.id)).text).toContain("You have no Bank input");
  });
});
