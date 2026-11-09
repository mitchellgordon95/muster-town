/**
 * Build step 9 of docs/legible-delegation.md (§9, §7.4): the legible-delegation measures, each count from a small
 * fixture. Pure reads: `legibleMeasures(world, now)`.
 */
import { describe, expect, it } from "vitest";
import { buildingQueue, createBuilding, createResident, forkManager, markSeen, newId, nowIso, retireFork, updateBuilding } from "../src/index.ts";
import { createAsk, decideAsk, retireAsks } from "../src/asks.ts";
import { legibleMeasures } from "../src/measures.ts";
import { creditBank, seededWorld } from "./helpers.ts";

const KR = { text: "A guest sees the banner", howToCheck: "Open the lab as a guest" };
const REPORT = "## What I did\nx\n## Findings\ny\n## What I need from you\nNothing needed.";
const STEPS = [
  { size: "S" as const, title: "Check the banner", description: "Open the lab as a guest" },
  { size: "M" as const, title: "Build the banner", description: "Ship the banner PR" },
  { size: "L" as const, title: "Build the board", description: "Ship the board PR" },
];
const HOUR = 3_600_000;
const ago = (h: number) => new Date(Date.now() - h * HOUR).toISOString();

function lab() {
  const s = seededWorld();
  const { world, seed, admin } = s;
  const b = createBuilding(world, { name: "Gated", headcount: 3, model: "claude-opus-5-5", cheapModel: "claude-haiku-5-5" }, seed.admin.id);
  const pix = createResident(world, { buildingId: b.id, name: "Pix" });
  updateBuilding(world, b.id, { managerAgentId: pix.id });
  creditBank(world);
  const fund = () => world.grantDesk.decide(admin, world.grantDesk.propose(null, world.grantDesk.create(null, b.id, { keyResults: [KR], objective: "A banner", steps: STEPS, stopCondition: "s" }).id).id, { action: "fund" });
  const runStep = async (tokens: number) => {
    const a = buildingQueue(world, b.id)[0]!;
    const { fork } = forkManager(world, b.id, a.id);
    world.assignments.patch(a.id, { status: "active" });
    world.sessions.upsert({
      id: newId("se"), agentId: fork.id, assignmentId: a.id, meetingId: null, purpose: "work", backend: "host", status: "done", model: "m",
      sdkSessionId: null, output: tokens, costUsd: 0, turns: 0, reportId: null, error: null, startedAt: nowIso(), endedAt: nowIso(), funding: null, lane: "grant", grantId: a.grantId,
    } as never);
    await world.verbs.submit_report(fork, { title: `Report on ${a.title}`, body: REPORT, verdict: "continue" });
    retireFork(world, fork.id);
  };
  return { ...s, b, fund, runStep };
}

describe("legibleMeasures (docs/legible-delegation.md §9)", () => {
  it("asks: open asks, asks per distinct target with the folds, the oldest open ask, time to decision per type, retired before read", () => {
    const { world, admin } = lab();
    const two = (label: string) => [{ label }, { label: "Decline" }];
    // two live asks: one on a captain request (a second source folds in), one in words
    const a1 = createAsk(world, { type: "click", targetKind: "captain", targetId: "cr_one", buildingId: null, sourceDocId: "dc_first", title: "Make Noor captain", branches: two("Accept") }).ask;
    createAsk(world, { type: "click", targetKind: "captain", targetId: "cr_one", buildingId: null, sourceDocId: "dc_second", title: "Make Noor captain, again", branches: two("Accept") });
    world.asks.patch(a1.id, { createdAt: ago(10) });
    createAsk(world, { type: "meeting", buildingId: null, sourceDocId: null, title: "Talk about the map?", branches: two("Yes") });
    // a money ask filed 4 h ago and decided now
    const money = createAsk(world, { type: "money", buildingId: null, sourceDocId: null, title: "Fund it", branches: two("Fund") }).ask;
    world.asks.patch(money.id, { createdAt: ago(4) });
    decideAsk(world, admin, money.id, "Fund");
    // two asks retired by their events: a human opened one of them first
    const r1 = createAsk(world, { type: "click", targetKind: "access", targetId: "ar_one", buildingId: null, sourceDocId: null, title: "Let Ada in", branches: two("Let in") }).ask;
    createAsk(world, { type: "click", targetKind: "access", targetId: "ar_two", buildingId: null, sourceDocId: null, title: "Let Bo in", branches: two("Let in") });
    markSeen(world, admin.ownerUserId!, "ask", r1.id);
    retireAsks(world, "access", "ar_one", "Ada was let in");
    retireAsks(world, "access", "ar_two", "Bo was let in");

    const m = legibleMeasures(world);
    expect(m.openAsks).toBe(2);
    expect(m.asksPerTarget).toEqual({ targets: 2, ratio: 1, folds: 1 });
    expect(m.oldestOpenAskHours).toBeCloseTo(10, 0);
    expect(m.timeToDecision.money).toEqual({ medianHours: 4, sample: 1 });
    expect(m.timeToDecision.click).toBeUndefined();
    expect(m.retiredBeforeRead).toEqual({ retired: 2, unread: 1 });
    // a decision older than the window is not counted
    world.asks.patch(money.id, { decidedAt: ago(15 * 24) });
    expect(legibleMeasures(world).timeToDecision.money).toBeUndefined();
  });

  it("grants: top-up asks per funded grant, hold share, spent over size per size, sessions per completed step, tokens held at gates", async () => {
    const { world, fund, runStep, b } = lab();
    const g1 = fund();
    await runStep(40_000); // the S step: 0.8× its size
    await runStep(560_000); // the M step: 3.73× its size, and the grant reaches its ceiling
    world.grantDesk.checkpoints(b.id);
    expect(world.grants.require(g1.id).status).toBe("checkpoint");
    // the checkpoint's money ask (adjust / cut) is a top-up ask; raise the ceiling by hand so the gate holds 100k
    world.grants.patch(g1.id, { grantTokens: 700_000 });
    // two more funded grants close in the window: one held before it closed, one never held
    const g2 = fund(), g3 = fund();
    const held = world.grants.require(g2.id);
    world.grants.patch(g2.id, { status: "closed", outcome: "done", closedAt: nowIso(), history: [...held.history, { at: nowIso(), byId: "system", byKind: "user", action: "checkpoint", tokens: null, note: "held" }] });
    world.grants.patch(g3.id, { status: "closed", outcome: "done", closedAt: nowIso() });

    const m = legibleMeasures(world);
    expect(m.topUpsPerFundedGrant).toEqual({ topUps: 1, funded: 3, ratio: 0.33 });
    expect(m.holdShare).toEqual({ held: 1, closed: 2, share: 0.5 });
    expect(m.spentOverSize).toEqual({ S: { ratio: 0.8, sample: 1 }, M: { ratio: 3.73, sample: 1 }, L: { ratio: null, sample: 0 } });
    expect(m.sessionsPerStep).toEqual({ median: 1, steps: 2 });
    expect(m.heldAtGates).toMatchObject({ grants: 1, tokens: 100_000 });
    expect(m.heldAtGates.oldestHours).toBeCloseTo(0, 0);
    // a projected overrun on a grant with no hold ask counts as a top-up ask too
    world.events.append({ type: "grant.top-up-needed", buildingId: b.id, text: "projected past its ceiling", payload: { grantId: g3.id } });
    expect(legibleMeasures(world).topUpsPerFundedGrant).toEqual({ topUps: 2, funded: 3, ratio: 0.67 });
  });
});
