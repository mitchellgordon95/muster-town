import { describe, expect, it } from "vitest";
import { buildingRoleId, modelEstimatePrompt, newId, nowIso, parseModelEstimate } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";
const kr = (i: number) => ({ text: `key result ${i}`, howToCheck: "look" });

/** A world with 5 closed grants (funded, charged, closed done or cut) for the estimator to read. */
function setup() {
  const s = seededWorld();
  const { world, admin } = s;
  const manager = world.agents.first("homeBuildingId = ? AND kind != 'human'", [LAB])!;
  world.permissions.grant(manager, buildingRoleId(LAB, "manager"));
  const charge = (grantId: string, tokens: number, assignmentId: string | null = null) => world.sessions.upsert({
    id: newId("se"), agentId: manager.id, assignmentId, meetingId: null, purpose: "work", backend: "host", status: "done", model: "m",
    sdkSessionId: null, output: tokens, costUsd: 0, startedAt: nowIso(), endedAt: nowIso(), lane: "grant", grantId,
  } as never);
  const proposed = (krs: number, ask: number, objective = "a plan") =>
    world.grantDesk.propose(manager, world.grantDesk.create(manager, LAB, { keyResults: Array.from({ length: krs }, (_, i) => kr(i)), objective, steps: [{ size: "M", title: "Step 1", description: "Do the work" }], stopCondition: "s", askTokens: ask }).id);
  /** funded at `funded`, spent `spent`, closed done (or cut at its checkpoint) */
  const closed = (krs: number, funded: number, spent: number, outcome: "done" | "cut" = "done") => {
    const g = proposed(krs, funded, `closed ${krs} KRs ${funded}`);
    world.grantDesk.decide(admin, g.id, { action: "fund", tokens: funded });
    charge(g.id, spent);
    if (outcome === "cut") {
      world.grantDesk.checkpoints(LAB);
      world.grantDesk.decide(admin, g.id, { action: "cut" });
    } else world.grantDesk.closeDone(manager, g.id, { note: "done" });
    return g.id;
  };
  return { ...s, manager, charge, proposed, closed };
}

describe("grant cost estimate (Mitchell, 1:1 mt_c9u1kr15jp)", () => {
  it("reads the closed grants: sample, medians, the 3 nearest by key-result count then funded tokens, and their range", () => {
    const { world, closed } = setup();
    const before = world.grantDesk.estimateFor({ buildingId: LAB, keyResults: 2, askTokens: 200_000 });
    expect(before).toMatchObject({ sample: 0, medianRatio: null, low: null, high: null, similar: [] });
    expect(before.sentence).toBe("ask 200,000 · no closed grants yet to compare it with");

    const a = closed(2, 100_000, 120_000);           // ratio 1.2
    const b = closed(2, 300_000, 150_000);           // 0.5
    const c = closed(1, 200_000, 400_000, "cut");    // 2.0
    const d = closed(3, 500_000, 500_000);           // 1.0
    closed(5, 200_000, 160_000);                     // 0.8, too far by key results
    const e = world.grantDesk.estimateFor({ buildingId: LAB, keyResults: 2, askTokens: 200_000 });
    expect(e.sample).toBe(5);
    expect(e.buildingSample).toBe(5);
    expect(e.medianRatio).toBe(1); // 0.5, 0.8, 1.0, 1.2, 2.0
    // 2 KRs: a (|100k−200k|) and b (|300k−200k|) tie on tokens, by id; then 1 or 3 KRs: c (0 off the ask) before d
    expect(e.similar.map((x) => x.id).sort()).toEqual([a, b, c].sort());
    expect(e.similar.find((x) => x.id === c)).toMatchObject({ outcome: "cut", grantTokens: 200_000, spentTokens: 400_000, keyResults: 1 });
    expect(e.similar.map((x) => x.id)).not.toContain(d);
    expect([e.low, e.high]).toEqual([120_000, 400_000]);
    expect(e.sentence).toBe("ask 200,000 · 3 similar grants spent 120,000–400,000 (median spent/funded 1.00 across 5 closed grants; this building 1.00 across 5)");
    // a grant never compares with itself, and no tokens are spent reading
    const sessions = world.sessions.count("1 = 1");
    expect(world.grantDesk.estimateFor(world.grantDesk.get(a)).sample).toBe(4);
    expect(world.sessions.count("1 = 1")).toBe(sessions);
  });

  it("fewer than 3 closed grants: says so and gives what there is", () => {
    const { world, closed } = setup();
    closed(1, 100_000, 80_000);
    closed(1, 100_000, 90_000);
    const e = world.grantDesk.estimateFor({ buildingId: "elsewhere", keyResults: 1, askTokens: 100_000 });
    expect(e).toMatchObject({ sample: 2, buildingSample: 0, buildingMedianRatio: null, low: 80_000, high: 90_000 });
    expect(e.sentence).toBe("ask 100,000 · only 2 closed grants to compare with: spent 80,000–90,000 (median spent/funded 0.85 across 2 closed grants)");
  });

  it("propose records it on the grant and propose_grant answers with the sentence; the close event carries the range", async () => {
    const { world, admin, manager, closed, charge } = setup();
    closed(1, 100_000, 80_000);
    closed(1, 100_000, 90_000);
    closed(1, 200_000, 300_000);
    const r = await world.verbs.propose_grant(manager, { title: "A test grant proposal", keyResults: [kr(0)], objective: "next", steps: [{ size: "M", title: "Step 1", description: "Do the work" }], stopCondition: "s", askTokens: 150_000 });
    expect(r.estimate).toBe("ask 150,000 · 3 similar grants spent 80,000–300,000 (median spent/funded 0.90 across 3 closed grants; this building 0.90 across 3)");
    const g = world.grantDesk.get(r.grantId);
    expect(g.estimate).toMatchObject({ askTokens: 150_000, low: 80_000, high: 300_000, sample: 3 });
    // advisory only: the ask stands as named
    expect(g.askTokens).toBe(150_000);
    world.grantDesk.decide(admin, g.id, { action: "fund" });
    charge(g.id, 50_000);
    world.grantDesk.closeDone(manager, g.id, { note: "done" });
    const ev = world.events.list({ types: ["grant.closed"] }).find((x) => x.payload.grantId === g.id)!;
    expect(ev.payload).toMatchObject({ estimateLow: 80_000, estimateHigh: 300_000, spentTokens: 50_000, modelLow: null, estimateBy: "history", insideEstimate: false,
      estimateLine: "estimated 80,000–300,000 (similar grants), spent 50,000: outside the range" });
  });

  it("withEstimate: an open or live grant without a recorded estimate gets a fresh one; a closed one gets none", () => {
    const { world, closed } = setup();
    const id = closed(1, 100_000, 80_000);
    const g = world.grantDesk.get(id);
    expect(world.grantDesk.withEstimate({ ...g, estimate: null }).estimate).toBeNull();
    const open = world.grantDesk.withEstimate({ ...g, status: "proposed", estimate: null, id: "gr_other" });
    expect(open.estimate?.sample).toBe(1);
  });

  it("step 2: the model's prompt carries the closed grants and the new plan; its answer parses to a range", () => {
    const { world, manager, closed, charge } = setup();
    const a = closed(2, 100_000, 120_000);
    charge(a, 5_000); // a second session
    const g = world.grantDesk.propose(manager, world.grantDesk.create(manager, LAB, { keyResults: [kr(0)], objective: "Write the estimate", approach: "one PR, then a check", steps: [{ size: "M", title: "Step 1", description: "Do the work" }], stopCondition: "s", askTokens: 150_000 }).id);
    const p = modelEstimatePrompt(world, g.id);
    expect(p).toContain(`- ${a} [done] funded 100000, spent 125000, 2 sessions, 2 key results. Objective: closed 2 KRs 100000. Key results: key result 0 | key result 1`);
    expect(p).toContain("Objective: Write the estimate");
    expect(p).toContain("Approach: one PR, then a check");
    expect(p).toContain("The manager asks for 150000 tokens.");
    expect(p).not.toContain(`- ${g.id}`);

    expect(parseModelEstimate('{"low": 150000, "high": 400000, "reason": "Like gr_a."}')).toEqual({ low: 150_000, high: 400_000, note: "Like gr_a." });
    expect(parseModelEstimate('Sure: {"low": "150,000", "high": 400000}')).toEqual({ low: 150_000, high: 400_000, note: "" });
    expect(parseModelEstimate('{"low": 400000, "high": 150000}')).toBeNull();
    expect(parseModelEstimate("about 200k")).toBeNull();
    expect(parseModelEstimate('{"low": 0, "high": 5}')).toBeNull();
  });

  it("step 2: the model's range is saved beside the history range, held to at close, and counted on the Spending tab", async () => {
    const { world, admin, manager, closed, charge } = setup();
    closed(1, 100_000, 80_000);
    const r = await world.verbs.propose_grant(manager, { title: "A test grant proposal", keyResults: [kr(0)], objective: "next", steps: [{ size: "M", title: "Step 1", description: "Do the work" }], stopCondition: "s", askTokens: 150_000 });
    const g = world.grantDesk.get(r.grantId);
    const model = { low: 100_000, high: 200_000, note: "n", modelId: "claude-haiku-5-5", sessionId: null, at: nowIso() };
    // a stale call (the grant was re-proposed since) saves nothing
    expect(world.grantDesk.recordModelEstimate(g.id, "2000-01-01T00:00:00.000Z", model)).toBe(false);
    expect(world.grantDesk.recordModelEstimate(g.id, g.estimate!.at, model)).toBe(true);
    expect(world.grantDesk.get(g.id).estimate).toMatchObject({ low: 80_000, high: 80_000, model: { low: 100_000, high: 200_000 } });
    expect(world.grantDesk.get(g.id).status).toBe("proposed");
    // before any closed grant carries an estimate, the Spending tab counts none
    expect(world.bank.spend().grants.estimates).toEqual({ closed: 0, inside: 0, unit: "adjusted tokens", badRanges: [] });
    world.grantDesk.decide(admin, g.id, { action: "fund" });
    charge(g.id, 150_000, "as_work"); // a work session: the Spending tree's grant row
    world.grantDesk.closeDone(manager, g.id, { note: "done" });
    const ev = world.events.list({ types: ["grant.closed"] }).find((x) => x.payload.grantId === g.id)!;
    expect(ev.payload).toMatchObject({ estimateLow: 80_000, modelLow: 100_000, modelHigh: 200_000, estimateBy: "model", insideEstimate: true,
      estimateLine: "estimated 100,000–200,000 (model), spent 150,000: inside the range" });
    expect(world.bank.spend().grants.estimates).toEqual({ closed: 1, inside: 1, unit: "adjusted tokens", badRanges: [] });
  });
});
