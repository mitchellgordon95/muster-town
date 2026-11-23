/**
 * Build step 9 of docs/legible-delegation.md (§7.4): the Planner's weekly calibration run. Idle under the lines; a
 * crossed line files one policy ask with the data and one change; "Adopt" applies the table change through
 * `World.setGrantPricing` and logs it; "Keep as is" changes nothing.
 */
import { grantPricingOf, type StepSize } from "@muster-town/schema";
import { describe, expect, it } from "vitest";
import { createBuilding, createResident, newId, nowIso, updateBuilding } from "../src/index.ts";
import { decideAsk } from "../src/asks.ts";
import { holdSample, stepCalibration, type HoldSample } from "../src/grant-estimate.ts";
import { legibleMeasures } from "../src/measures.ts";
import { calibrate, calibrationIdleReason, calibrationProposal, cheapestMargin, ensureCalibrationSchedule, PLANNER_LINES, projectHoldShare } from "../src/planner.ts";
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

/** Today's live data (2026-11-23 16:1xZ, GET /api/grants/:id stepStates on the 42 grants with sized steps funded in 30 days): done-step spends in tokens and the step mixes. S median 1.08×, mean 1.41× over 22 steps. */
const TODAY_SPENDS = {"S": [22933, 31339, 121370, 232371, 47652, 55865, 51442, 67270, 111019, 43698, 51833, 67854, 23333, 38759, 81588, 129472, 117872, 20570, 46509, 12121, 104328, 66378], "M": [168098, 98539, 158868, 115814, 104455, 92632, 276410, 96247, 214198, 208567, 138175, 74720, 128201, 145650, 181379, 29949, 196054, 89734, 126627, 164123, 50446, 43314, 126526, 81717, 173437, 127283, 252339, 90485, 158214, 147404, 271870, 43774, 25690, 70032, 109473, 227484, 137711, 63195, 95323, 247796, 94506, 300631, 209143, 147948, 101814, 134662, 141231, 161172, 234285], "L": [203233, 307845, 200492]} as const;
const TODAY_MIXES = ["MSS", "MMS", "MSS", "MS", "MMS", "MMS", "MLSM", "MMS", "MS", "MS", "M", "MS", "MSS", "MS", "MSMS", "MMM", "MS", "M", "SM", "MS", "MSS", "M", "MS", "M", "M", "S", "M", "MMM", "MMMS", "MS", "MS", "MS", "MSS", "MS", "M", "SMS", "MM", "MS", "SMS", "LLLM", "MMM", "S"];
const TABLE = { S: 50_000, M: 150_000, L: 400_000 };
const todaySample = (): HoldSample => ({
  ratios: { S: TODAY_SPENDS.S.map((x) => x / TABLE.S), M: TODAY_SPENDS.M.map((x) => x / TABLE.M), L: TODAY_SPENDS.L.map((x) => x / TABLE.L) },
  mixes: TODAY_MIXES.map((m) => [...m] as StepSize[]),
});

describe("calibration prices sizes that can meet the hold line (gr_1ilvotnzta step 1)", () => {
  /** today's measures: S median 1.08, mean 1.41; M 0.90 / 0.94; 23 of 37 closed grants held (62%), 22 adjust asks for 42 funded */
  const today = () => {
    const base = legibleMeasures(town().world);
    return {
      ...base,
      holdShare: { held: 23, closed: 37, share: 0.62 },
      topUpsPerFundedGrant: { topUps: 22, funded: 42, ratio: 0.52 },
      spentOverSize: { S: { ratio: 1.08, sample: 22, mean: 1.41, p75: 2.07 }, M: { ratio: 0.9, sample: 49, mean: 0.94, p75: 1.11 }, L: { ratio: 0.51, sample: 3, mean: 0.59, p75: 0.64 } },
    };
  };

  it("on today's data it raises S to a new value with the hold share it projects, never 50,000 to 50,000", () => {
    const p = calibrationProposal(today(), TABLE, todaySample())!;
    expect(p).toMatchObject({ change: "raise", size: "S", from: 50_000 });
    expect(p.to!).toBeGreaterThan(50_000);
    expect(p.holdBefore!).toBeGreaterThan(PLANNER_LINES.holdShareMax);
    expect(p.holdAfter!).toBeLessThanOrEqual(PLANNER_LINES.holdShareMax);
    // the smallest such raise: 10,000 less would not meet the line
    expect(projectHoldShare(todaySample(), TABLE, { ...TABLE, S: p.to! - 10_000 })!).toBeGreaterThan(PLANNER_LINES.holdShareMax);
    expect(p).toEqual({ kind: "step-size", change: "raise", size: "S", from: 50_000, to: 120_000, holdBefore: 0.46, holdAfter: 0.24, line: "23 of 37 grants closed in 14 days held before they closed (62%), over 25%" });
  });

  it("the projection is deterministic, falls as a size rises, and a ceiling margin is an alternative", () => {
    const s = todaySample();
    expect(projectHoldShare(s, TABLE, TABLE)).toBe(projectHoldShare(s, TABLE, TABLE));
    expect(projectHoldShare(s, TABLE, { ...TABLE, S: 100_000 })!).toBeLessThan(projectHoldShare(s, TABLE, TABLE)!);
    expect(projectHoldShare({ ratios: { S: [], M: [], L: [] }, mixes: [] }, TABLE, TABLE)).toBeNull();
    const m = cheapestMargin(s, TABLE)!;
    expect(m.after).toBeLessThanOrEqual(PLANNER_LINES.holdShareMax);
    expect(m.margin).toBeGreaterThan(0);
  });

  it("never proposes a size's current value: the median-priced raise that rounds to the table falls back to the split rule", () => {
    const m = today();
    // no sample, S's heat rounds back to 50,000: split, not "from 50,000 to 50,000"
    const flat = { ...m, spentOverSize: { ...m.spentOverSize, S: { ratio: 1.08, sample: 22, mean: 1.04, p75: 1.2 } } };
    expect(calibrationProposal(flat, TABLE)).toMatchObject({ change: "split", size: "L", to: null });
    // with a sample whose step spend already projects under the line, no raise is priced from it either
    const cool: HoldSample = { ratios: { S: [0.5], M: [0.5], L: [0.5] }, mixes: [["S"], ["M"]] };
    expect(calibrationProposal(flat, TABLE, cool)).toMatchObject({ change: "split", holdBefore: 0, holdAfter: null });
    // without a sample, a hot S is priced at its mean
    expect(calibrationProposal(m, TABLE)).toMatchObject({ change: "raise", size: "S", to: 70_000, holdBefore: null, holdAfter: null });
  });

  it("stepCalibration reads each size's mean and p75 beside the median; holdSample has the funded grants' step mixes", () => {
    const { world, completedSteps } = town();
    completedSteps(3, 150_000);
    completedSteps(1, 450_000);
    expect(stepCalibration(world).sizes.M).toEqual({ ratio: 1, sample: 4, mean: 1.5, p75: 1.5 });
    const s = holdSample(world);
    expect(s.ratios.M.sort()).toEqual([1, 1, 1, 3]);
    expect(s.mixes.map((x) => x.join("")).sort()).toEqual(["M", "MMM"]);
  });

  it("the brief carries mean and p75 and the projected hold share before and after", () => {
    const { world, planner, completedSteps } = town();
    completedSteps(PLANNER_LINES.sizeMinSample, 300_000);
    const r = calibrate(world, planner, {});
    const brief = "brief" in r ? r.brief : "";
    expect(brief).toContain("M median 2.00×, mean 2.00×, p75 2.00× over 30 steps");
    expect(brief).toMatch(/Proposed change: Raise M from 150,000 to 300,000 tokens\. Projected hold share 100% → 0%\./);
    expect(brief).toMatch(/Projected hold share, a bootstrap of the 1 grants funded in 30 days/);
  });
});
