import { describe, expect, it } from "vitest";
import { buildingRoleId, newId, nowIso } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";
const kr = (i: number) => ({ text: `key result ${i}`, howToCheck: "look" });

/** A world with 5 closed grants (funded, charged, closed done or cut) for the estimator to read. */
function setup() {
  const s = seededWorld();
  const { world, admin } = s;
  const manager = world.agents.first("homeBuildingId = ? AND kind != 'human'", [LAB])!;
  world.permissions.grant(manager, buildingRoleId(LAB, "manager"));
  const charge = (grantId: string, tokens: number) => world.sessions.upsert({
    id: newId("se"), agentId: manager.id, assignmentId: null, meetingId: null, purpose: "work", backend: "host", status: "done", model: "m",
    sdkSessionId: null, output: tokens, costUsd: 0, startedAt: nowIso(), endedAt: nowIso(), lane: "grant", grantId,
  } as never);
  const proposed = (krs: number, ask: number, objective = "a plan") =>
    world.grantDesk.propose(manager, world.grantDesk.create(manager, LAB, { keyResults: Array.from({ length: krs }, (_, i) => kr(i)), objective, stopCondition: "s", askTokens: ask }).id);
  /** funded at `funded`, spent `spent`, closed done (or cut at its checkpoint) */
  const closed = (krs: number, funded: number, spent: number, outcome: "done" | "cut" = "done") => {
    const g = proposed(krs, funded, `closed ${krs} KRs ${funded}`);
    world.grantDesk.decide(admin, g.id, { action: "fund" });
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
    const r = await world.verbs.propose_grant(manager, { keyResults: [kr(0)], objective: "next", stopCondition: "s", askTokens: 150_000 });
    expect(r.estimate).toBe("ask 150,000 · 3 similar grants spent 80,000–300,000 (median spent/funded 0.90 across 3 closed grants; this building 0.90 across 3)");
    const g = world.grantDesk.get(r.grantId);
    expect(g.estimate).toMatchObject({ askTokens: 150_000, low: 80_000, high: 300_000, sample: 3 });
    // advisory only: the ask stands as named
    expect(g.askTokens).toBe(150_000);
    world.grantDesk.decide(admin, g.id, { action: "fund" });
    charge(g.id, 50_000);
    world.grantDesk.closeDone(manager, g.id, { note: "done" });
    const ev = world.events.list({ types: ["grant.closed"] }).find((x) => x.payload.grantId === g.id)!;
    expect(ev.payload).toMatchObject({ estimateLow: 80_000, estimateHigh: 300_000, spentTokens: 50_000 });
  });

  it("withEstimate: an open or live grant without a recorded estimate gets a fresh one; a closed one gets none", () => {
    const { world, closed } = setup();
    const id = closed(1, 100_000, 80_000);
    const g = world.grantDesk.get(id);
    expect(world.grantDesk.withEstimate({ ...g, estimate: null }).estimate).toBeNull();
    const open = world.grantDesk.withEstimate({ ...g, status: "proposed", estimate: null, id: "gr_other" });
    expect(open.estimate?.sample).toBe(1);
  });
});
