/**
 * Build step 9 of docs/legible-delegation.md (§7.4): the Planner's weekly calibration run. Idle under the lines; a
 * crossed line files one policy ask with the data and one change; "Adopt" applies the table change through
 * `World.setGrantPricing` and logs it; "Keep as is" changes nothing.
 */
import { grantPricingOf } from "@muster-town/schema";
import { describe, expect, it } from "vitest";
import { createBuilding, createResident, newId, nowIso, updateBuilding } from "../src/index.ts";
import { decideAsk } from "../src/asks.ts";
import { legibleMeasures } from "../src/measures.ts";
import { calibrate, calibrationIdleReason, calibrationProposal, ensureCalibrationSchedule, PLANNER_LINES } from "../src/planner.ts";
import { creditBank, seededWorld } from "./helpers.ts";

const KR = { text: "A guest sees the banner", howToCheck: "Open the lab as a guest" };
const CARD = {
  title: "Price an M step at 300,000 tokens",
  body: [
    "Rule: Price an M step at 300,000 tokens.",
    "The data: thirty M steps finished this month. They spent twice their size.",
    "What I did: I applied nothing. The table stays as it is until you decide.",
    "Reversing it: you set M back to 150,000 tokens on the planning desk.",
    "If you adopt: new proposals price each M step at 300,000 tokens.",
    "If you keep it: the table stays. You hear about it again next week.",
  ].join("\n"),
  recommendation: "Adopt: M steps cost twice the table.",
};

function town() {
  const s = seededWorld();
  const { world, seed, admin } = s;
  const b = createBuilding(world, { name: "Gated", headcount: 3, model: "claude-opus-5-5", cheapModel: "claude-haiku-5-5" }, seed.admin.id);
  const pix = createResident(world, { buildingId: b.id, name: "Pix" });
  updateBuilding(world, b.id, { managerAgentId: pix.id });
  creditBank(world);
  const planner = world.reorgs.ensurePlanner();
  /** `n` completed M steps of one funded grant, each a done assignment with one session of `tokens` */
  const completedSteps = (n: number, tokens: number) => {
    const g = world.grantDesk.decide(admin, world.grantDesk.propose(null, world.grantDesk.create(null, b.id, { keyResults: [KR], objective: "Many steps", steps: [{ size: "M", title: "Step", description: "d" }], stopCondition: "s" }).id).id, { action: "fund" });
    world.grants.patch(g.id, { steps: Array.from({ length: n }, (_, i) => ({ size: "M" as const, title: `Step ${i + 1}`, description: "d" })) });
    const first = world.assignments.first("grantId = ? AND grantStep = 0", [g.id])!;
    for (let i = 0; i < n; i++) {
      const a = i === 0 ? first : world.assignments.upsert({ ...first, id: newId("as"), grantStep: i, chainId: null });
      world.assignments.patch(a.id, { status: "done" });
      world.sessions.upsert({
        id: newId("se"), agentId: pix.id, assignmentId: a.id, meetingId: null, purpose: "work", backend: "host", status: "done", model: "m",
        sdkSessionId: null, output: tokens, costUsd: 0, turns: 0, reportId: null, error: null, startedAt: nowIso(), endedAt: nowIso(), funding: null, lane: "grant", grantId: g.id,
      } as never);
    }
  };
  return { ...s, b, planner, completedSteps };
}

describe("the Planner's calibration run (docs/legible-delegation.md §7.4)", () => {
  it("idle under the lines: the weekly Fable schedule skips before any session, and calibrate files nothing", async () => {
    const { world, planner } = town();
    const s = ensureCalibrationSchedule(world)!;
    expect(s).toMatchObject({ takerId: planner.id, model: "claude-fable-5-1", everyMinutes: 7 * 24 * 60, lane: "retainer", retainer: "asked" });
    expect(ensureCalibrationSchedule(world)!.id).toBe(s.id);
    expect(calibrationIdleReason(world, s, new Date())).toBe("no line is crossed");
    const r = calibrate(world, planner, {});
    expect("brief" in r && r.brief).toContain("Crossed: none.");
    expect(() => calibrate(world, planner, CARD)).toThrow(/No line is crossed/);
    expect(world.asks.count("targetKind = 'rule'")).toBe(0);
    // only the Planner calibrates
    await expect(world.verbs.calibrate(world.agents.first("name = 'Pix'")!, {})).rejects.toThrow(/Only the Town Hall's Planner/);
  });

  it("a crossed line files one policy ask with the data and one change; a second is refused while it waits", () => {
    const { world, planner, completedSteps } = town();
    completedSteps(PLANNER_LINES.sizeMinSample, 300_000); // 30 M steps at 2× their size
    const s = ensureCalibrationSchedule(world)!;
    expect(calibrationIdleReason(world, s, new Date())).toBeNull();
    const brief = calibrate(world, planner, {});
    expect("brief" in brief && brief.brief).toContain("M steps spend 2.00× their size over 30 completed steps, outside 0.7-1.3");
    expect("brief" in brief && brief.brief).toContain("Proposed change: Raise M from 150,000 to 300,000 tokens.");
    const filed = calibrate(world, planner, CARD);
    if (!("askId" in filed)) throw new Error("not filed");
    const ask = world.asks.require(filed.askId);
    expect(ask).toMatchObject({ type: "policy", targetKind: "rule", targetId: "step-sizes", status: "open", tags: [], body: CARD.body });
    expect(ask.branches.map((x) => x.label)).toEqual(["Adopt", "Keep as is"]);
    expect(ask.proposal).toMatchObject({ kind: "step-size", change: "raise", size: "M", from: 150_000, to: 300_000 });
    expect(() => calibrate(world, planner, CARD)).toThrow(/at most one/);
    expect(calibrationIdleReason(world, s, new Date())).toBe("a calibration ask is still waiting for a human");
    // the table is untouched until a human decides
    expect(grantPricingOf(world.town.get()).stepSizes.M).toBe(150_000);
  });

  it("Adopt applies the table change through setGrantPricing and logs it; Keep as is changes nothing", () => {
    for (const decision of ["Adopt", "Keep as is"]) {
      const { world, planner, admin, completedSteps } = town();
      completedSteps(PLANNER_LINES.sizeMinSample, 300_000);
      const filed = calibrate(world, planner, CARD);
      if (!("askId" in filed)) throw new Error("not filed");
      decideAsk(world, admin, filed.askId, decision);
      const adopted = world.events.list({ types: ["calibration.adopted"] });
      if (decision === "Adopt") {
        expect(grantPricingOf(world.town.get()).stepSizes).toEqual({ S: 50_000, M: 300_000, L: 400_000 });
        expect(adopted).toHaveLength(1);
        expect(adopted[0]!.text).toContain("adopted the Planner's calibration: Raise M from 150,000 to 300,000 tokens.");
        expect(world.events.list({ textLike: "Grant pricing saved: step sizes S 50,000, M 300,000%" })).toHaveLength(1);
      } else {
        expect(grantPricingOf(world.town.get()).stepSizes).toEqual({ S: 50_000, M: 150_000, L: 400_000 });
        expect(adopted).toHaveLength(0);
      }
    }
  });

  it("holds or adjust asks over their line with no size running hot propose that L steps split; a hot S or M is raised", () => {
    const base = legibleMeasures(town().world);
    const table = { S: 50_000, M: 150_000, L: 400_000 };
    const holding = { ...base, holdShare: { held: 2, closed: 4, share: 0.5 } };
    expect(calibrationProposal(base, table)).toBeNull();
    expect(calibrationProposal(holding, table)).toMatchObject({ change: "split", size: "L", to: null });
    const hotS = { ...holding, spentOverSize: { ...base.spentOverSize, S: { ratio: 1.6, sample: 5 } } };
    expect(calibrationProposal(hotS, table)).toMatchObject({ change: "raise", size: "S", from: 50_000, to: 80_000 });
    const cold = { ...base, spentOverSize: { ...base.spentOverSize, L: { ratio: 0.5, sample: 40 } } };
    expect(calibrationProposal(cold, table)).toMatchObject({ change: "lower", size: "L", from: 400_000, to: 200_000 });
  });
});
