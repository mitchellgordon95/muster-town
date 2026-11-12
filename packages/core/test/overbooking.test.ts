/**
 * Build step 8 of docs/legible-delegation.md (§7.3 "earmarks at expected"): a funded grant's claim on free tokens is
 * ceilingRemaining × (1 − oversell) + expectedRemaining × oversell, expectedRemaining being its steps left at the
 * calibrated table, never below 0. Oversell 0 (the default) is exactly the old figure. The Bank floor is untouched.
 */
import { describe, expect, it } from "vitest";
import { ROOT_GOAL_ID } from "@muster-town/schema";
import { buildingQueue, createBuilding, createResident, forkManager, freeTokens, newId, nowIso, retireFork, updateBuilding } from "../src/index.ts";
import { creditBank, seededWorld } from "./helpers.ts";

const KR = { text: "A guest sees the banner", howToCheck: "Open the lab as a guest" };
const REPORT = "## What I did\nx\n## Findings\ny\n## What I need from you\nNothing needed.";

/** One funded grant: steps S + M + L (600k at the seeded table) under a 1M ceiling. */
function lab() {
  const s = seededWorld();
  const { world, seed, admin } = s;
  const b = createBuilding(world, { name: "Booked", headcount: 3 }, seed.admin.id);
  const pix = createResident(world, { buildingId: b.id, name: "Pix" });
  updateBuilding(world, b.id, { managerAgentId: pix.id });
  creditBank(world, 10_000_000);
  const steps = (["S", "M", "L"] as const).map((size) => ({ size, title: `${size} step`, description: "Do it" }));
  const g = world.grantDesk.decide(admin, world.grantDesk.propose(null, world.grantDesk.create(null, b.id, { keyResults: [KR], objective: "A banner", steps, stopCondition: "s" }).id).id, { action: "fund", tokens: 1_000_000 });
  const runStep = async (tokens: number) => {
    const a = buildingQueue(world, b.id)[0]!;
    const { fork } = forkManager(world, b.id, a.id);
    world.assignments.patch(a.id, { status: "active" });
    world.sessions.upsert({ id: newId("se"), agentId: fork.id, assignmentId: a.id, meetingId: null, purpose: "work", backend: "host", status: "done", model: "m", sdkSessionId: null, output: tokens, costUsd: 0, turns: 0, reportId: null, error: null, startedAt: nowIso(), endedAt: nowIso(), funding: null, lane: "grant", grantId: g.id } as never);
    await world.verbs.submit_report(fork, { title: "r", body: REPORT, verdict: "continue", left: "The rest of the plan." });
    retireFork(world, fork.id);
  };
  const free = () => freeTokens(world, ROOT_GOAL_ID);
  return { ...s, g, runStep, free };
}

describe("overbooking: the oversell setting", () => {
  it("oversell 0 reproduces today's free tokens: a funded grant claims its ceiling's remainder, whatever its steps' sizes", async () => {
    const { world, admin, runStep, free } = lab();
    const before = free();
    expect(before.fundedRemainingTokens).toBe(1_000_000); // not the 600k its steps are expected to cost
    world.setGrantPricing({ oversell: 0 }, admin.id);
    expect(free()).toEqual(before);
    await runStep(100_000);
    expect(free().fundedRemainingTokens).toBe(900_000); // granted − spent, exactly as before oversell existed
  });

  it("oversell 1 earmarks a funded grant at its expected remaining spend; 0.5 halfway; never below 0", async () => {
    const { world, admin, runStep, free } = lab();
    const at0 = free();
    world.setGrantPricing({ oversell: 1 }, admin.id);
    expect(free().fundedRemainingTokens).toBe(600_000); // S + M + L at the table, nothing done yet
    expect(free().freeTokens).toBe(at0.freeTokens + 400_000);
    world.setGrantPricing({ oversell: 0.5 }, admin.id);
    expect(free().fundedRemainingTokens).toBe(800_000);
    // every step done: nothing is expected, so at oversell 1 the grant claims nothing, though 700k of its ceiling is left
    world.setGrantPricing({ oversell: 1 }, admin.id);
    await runStep(100_000);
    await runStep(100_000);
    await runStep(100_000);
    expect(free().fundedRemainingTokens).toBe(0);
    world.setGrantPricing({ oversell: 0 }, admin.id);
    expect(free().fundedRemainingTokens).toBe(700_000);
  });
});
