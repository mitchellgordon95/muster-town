/**
 * Build step 7 of docs/legible-delegation.md (§7.3): T&M with a ceiling, gates at step reports. A funded grant holds only
 * when its spend reaches its ceiling; every step's report files a forecast on the grant; a projection past the ceiling
 * sets `needsTopUp` and appends `grant.top-up-needed`. The session circuit breaker asks once at 90% and cuts at 100%.
 */
import { describe, expect, it } from "vitest";
import { SESSION_CIRCUIT_BREAKER, buildingQueue, circuitBreakerTick, createBuilding, createResident, forkManager, newId, nowIso, retireFork, townHallIntray, updateBuilding } from "../src/index.ts";
import { creditBank, seededWorld } from "./helpers.ts";

const KR = { text: "A guest sees the banner", howToCheck: "Open the lab as a guest" };
const REPORT = "## What I did\nx\n## Findings\ny\n## What I need from you\nNothing needed.";
/** S 50k + M 150k + L 400k = an ask of 600k at the seeded table */
const STEPS = [
  { size: "S" as const, title: "Check the banner", description: "Open the lab as a guest" },
  { size: "M" as const, title: "Build the banner", description: "Ship the banner PR" },
  { size: "L" as const, title: "Build the board", description: "Ship the board PR" },
];

function lab() {
  const s = seededWorld();
  const { world, seed, admin } = s;
  const b = createBuilding(world, { name: "Gated", headcount: 3, model: "claude-opus-5-5", cheapModel: "claude-haiku-5-5" }, seed.admin.id);
  const pix = createResident(world, { buildingId: b.id, name: "Pix" });
  updateBuilding(world, b.id, { managerAgentId: pix.id });
  creditBank(world);
  const fund = (tokens?: number) => world.grantDesk.decide(admin, world.grantDesk.propose(null, world.grantDesk.create(null, b.id, { keyResults: [KR], objective: "A banner", steps: STEPS, stopCondition: "s" }).id).id, { action: "fund", ...(tokens ? { tokens } : {}) });
  /** a fork takes the building's first queued step, spends `tokens` on it (a booked session) and files its report */
  const runStep = async (tokens: number) => {
    const a = buildingQueue(world, b.id)[0]!;
    const { fork } = forkManager(world, b.id, a.id);
    world.assignments.patch(a.id, { status: "active" });
    world.sessions.upsert({
      id: newId("se"), agentId: fork.id, assignmentId: a.id, meetingId: null, purpose: "work", backend: "host", status: "done", model: "m",
      sdkSessionId: null, output: tokens, costUsd: 0, turns: 0, reportId: null, error: null, startedAt: nowIso(), endedAt: nowIso(), funding: null, lane: "grant", grantId: a.grantId,
    } as never);
    const r = await world.verbs.submit_report(fork, { title: `Report on ${a.title}`, body: REPORT, verdict: "continue" });
    retireFork(world, fork.id);
    return { a, r };
  };
  return { ...s, b, pix, fund, runStep };
}

describe("T&M with a ceiling (docs/legible-delegation.md §7.3)", () => {
  it("a grant holds only at its ceiling: one token short it runs, at the ceiling it holds", async () => {
    const { world, fund, runStep } = lab();
    const g = fund();
    expect(g).toMatchObject({ askTokens: 600_000, grantTokens: 600_000, holdAtTokens: 600_000 });
    await runStep(599_999);
    world.grantDesk.checkpoints(g.buildingId);
    expect(world.grants.require(g.id).status).toBe("funded");
    await runStep(1);
    world.grantDesk.checkpoints(g.buildingId);
    expect(world.grants.require(g.id)).toMatchObject({ status: "checkpoint", checkpointsDone: [1] });
  });
});

describe("gates at step reports: the forecast", () => {
  it("every step report files a forecast on the grant: steps done and left by size, spent, spent over size, projected; grant.forecast", async () => {
    const { world, fund, runStep } = lab();
    const g = fund();
    expect(world.grantDesk.get(g.id).forecast ?? null).toBeNull();
    await runStep(40_000); // the S step, under its size
    const f = world.grantDesk.get(g.id).forecast!;
    expect(f).toMatchObject({ stepsDone: 1, stepsLeft: { S: 0, M: 1, L: 1 }, spent: 40_000, ceiling: 600_000, spentOverSize: 0.8, projected: 590_000, overCeiling: false, shortfall: 0 });
    expect(world.grants.require(g.id).needsTopUp).toBe(false);
    const ev = world.events.list({ types: ["grant.forecast"] }).at(-1)!;
    expect(ev.payload).toMatchObject({ grantId: g.id, projected: 590_000, overCeiling: false });
    expect(ev.text).toContain("within the ceiling");
    expect(world.events.list({ types: ["grant.top-up-needed"] })).toHaveLength(0);
  });

  it("a forecast past the ceiling sets needsTopUp and appends grant.top-up-needed with the shortfall; the in-tray row and GET carry it", async () => {
    const { world, fund, runStep } = lab();
    const g = fund();
    await runStep(40_000);
    await runStep(300_000); // the M step ran at 2× its size
    const f = world.grantDesk.get(g.id).forecast!;
    // 340k spent + the L step left at 400k (too few steps to calibrate: ratio 1.0)
    expect(f).toMatchObject({ stepsDone: 2, stepsLeft: { S: 0, M: 0, L: 1 }, spent: 340_000, spentOverSize: 1.7, projected: 740_000, overCeiling: true, shortfall: 140_000 });
    expect(world.grantDesk.get(g.id).needsTopUp).toBe(true);
    const top = world.events.list({ types: ["grant.top-up-needed"] });
    expect(top).toHaveLength(1);
    expect(top[0]!.payload).toMatchObject({ grantId: g.id, shortfallTokens: 140_000, projected: 740_000, ceiling: 600_000 });
    // no ask and no report of its own: the money ask that carries it is a later step
    expect(world.docs.where("type = 'report' AND authorId = 'system'", [])).toHaveLength(0);
    // the grant's row in the Town Hall in-tray (once it holds) carries the forecast
    world.grants.patch(g.id, { status: "checkpoint", checkpointsDone: [1] });
    expect(townHallIntray(world).grants.find((x) => x.id === g.id)?.forecast).toMatchObject({ projected: 740_000, overCeiling: true });
  });
});

describe("the session circuit breaker", () => {
  it("asks a session once to file at 90% of SESSION_CIRCUIT_BREAKER and cuts it at 100%", () => {
    const { world, pix } = lab();
    const s = world.sessions.upsert({
      id: newId("se"), agentId: pix.id, assignmentId: null, meetingId: null, purpose: "work", backend: "host", status: "running", model: "m",
      sdkSessionId: null, output: SESSION_CIRCUIT_BREAKER * 0.8, costUsd: 0, turns: 0, reportId: null, error: null, startedAt: nowIso(), endedAt: null, funding: null, lane: "exploration", grantId: null,
    } as never);
    const warned = () => world.events.list({ types: ["system"], payloadKey: "circuitBreaker" });
    const cutEvents = () => world.events.list({ types: ["system"], payloadKey: "circuitBreakerCut" });
    expect(circuitBreakerTick(world)).toEqual([]);
    expect(warned()).toHaveLength(0);
    world.sessions.patch(s.id, { output: SESSION_CIRCUIT_BREAKER * 0.9 });
    expect(circuitBreakerTick(world)).toEqual([]);
    expect(circuitBreakerTick(world)).toEqual([]); // asked once
    expect(warned()).toHaveLength(1);
    expect(warned()[0]!.payload).toMatchObject({ circuitBreaker: s.id, limitTokens: 500_000 });
    world.sessions.patch(s.id, { output: SESSION_CIRCUIT_BREAKER });
    expect(circuitBreakerTick(world)).toEqual([pix.id]);
    expect(circuitBreakerTick(world)).toEqual([]); // cut once: the runtime ends it
    expect(cutEvents()).toHaveLength(1);
  });
});
