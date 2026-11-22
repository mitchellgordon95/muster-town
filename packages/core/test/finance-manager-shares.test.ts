/**
 * What managing each job cost (gr_064fmkq31s step 1, kr_xvnxm4kqwy): each manage session's tokens split equally over the
 * jobs it decided inside the wake; a wake with none → its building's upkeep; a 1:1 → oneOnOnes; the parts sum to the whole.
 */
import { describe, expect, it } from "vitest";
import { applyDecision, buildingQueue, createBuilding, createResident, forkManager, jobManaging, managerShares, retireFork, townManagerShares, updateBuilding } from "../src/index.ts";
import { sessionTokens } from "../src/bank.ts";
import { creditBank, seededWorld } from "./helpers.ts";

const NOW = new Date("2026-11-05T18:00:00.000Z");
const OPUS = "claude-opus-5-5";
type S = Parameters<typeof managerShares>[0]["sessions"][number];
let k = 0;
const ses = (over: Partial<S>): S => ({
  id: `se_${k++}`, agentId: "ag_m", purpose: "manage", meetingId: null, model: OPUS, bankModel: OPUS, byModel: null,
  startedAt: "2026-11-05T10:00:00.000Z", endedAt: "2026-11-05T10:05:00.000Z",
  input: 0, output: 1_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...over,
});
const agents = [{ id: "ag_m", buildingId: "bank" }, { id: "ag_w", buildingId: "lab" }];
const act = (key: string, jobId: string, at: string, agentId = "ag_m") => ({ key, jobId, at, agentId });

describe("managerShares (gr_064fmkq31s step 1)", () => {
  it("a wake deciding two jobs' reports splits in half; the shares sum to each session's tokens", () => {
    const r = managerShares({
      sessions: [ses({ output: 3_000 })],
      acts: [act("dc_a", "jb_gr_a", "2026-11-05T10:01:00.000Z"), act("dc_b", "jb_gr_b", "2026-11-05T10:02:00.000Z")],
      agents,
    }, NOW);
    expect(r.jobs).toEqual({ jb_gr_a: { tokens: 1_500, wakes: 1, decisions: 1 }, jb_gr_b: { tokens: 1_500, wakes: 1, decisions: 1 } });
    expect(r.totals).toEqual({ jobs: 3_000, upkeep: 0, oneOnOnes: 0 });
    expect(r.tiedShare).toBe(1);
    expect(r.check).toMatchObject({ ok: true, diff: 0 });
  });

  it("splits by job, not by decision; a doc and its answer entry are one decision; acts outside every wake count nowhere", () => {
    const r = managerShares({
      sessions: [ses({ output: 2_000 })],
      acts: [
        act("dc_a", "jb_gr_a", "2026-11-05T10:01:00.000Z"),
        act("dc_a", "jb_gr_a", "2026-11-05T10:01:01.000Z"), // the review's answer entry
        act("ak_1", "jb_gr_a", "2026-11-05T10:02:00.000Z"),
        act("dc_b", "jb_bank", "2026-11-05T10:03:00.000Z"),
        act("dc_late", "jb_gr_c", "2026-11-05T11:00:00.000Z"),
        act("dc_other", "jb_gr_c", "2026-11-05T10:02:00.000Z", "ag_w"), // someone else's
      ],
      agents,
    }, NOW);
    expect(r.jobs).toEqual({ jb_gr_a: { tokens: 1_000, wakes: 1, decisions: 2 }, jb_bank: { tokens: 1_000, wakes: 1, decisions: 1 } });
    expect(r.jobs.jb_gr_c).toBeUndefined();
  });

  it("a wake with no act is its building's upkeep, a 1:1 is oneOnOnes, work sessions are ignored; the parts close on the whole", () => {
    const r = managerShares({
      sessions: [
        ses({ output: 1_000 }),
        ses({ agentId: "ag_w", output: 700 }),
        ses({ meetingId: "mt_x", output: 4_000, startedAt: "2026-11-05T12:00:00.000Z", endedAt: "2026-11-05T12:30:00.000Z" }),
        ses({ purpose: "work", output: 90_000 }),
        ses({ output: 999, startedAt: "2026-11-05T13:00:00.000Z", endedAt: "2026-11-05T13:10:00.000Z" }),
      ],
      // decided in the 1:1: still the 1:1's
      acts: [act("dc_m", "jb_gr_a", "2026-11-05T12:10:00.000Z"), act("dc_z", "jb_gr_z", "2026-11-05T13:05:00.000Z")],
      agents,
    }, NOW);
    expect(r.sessions).toBe(4);
    expect(r.upkeep).toEqual({ bank: { tokens: 1_000, wakes: 1 }, lab: { tokens: 700, wakes: 1 } });
    expect(r.oneOnOnes).toEqual({ tokens: 4_000, wakes: 1 });
    expect(r.jobs).toEqual({ jb_gr_z: { tokens: 999, wakes: 1, decisions: 1 } });
    expect(r.totals.jobs + r.totals.upkeep + r.totals.oneOnOnes).toBe(r.manageTokens);
    expect(r.manageTokens).toBe(6_699);
    expect(r.check.ok).toBe(true);
  });

  it("three jobs: thirds still close on the session within a token; an act counts in the first wake that holds it; a running wake runs to now", () => {
    const r = managerShares({
      sessions: [
        ses({ output: 1_000, startedAt: "2026-11-05T17:00:00.000Z", endedAt: null }),
        ses({ output: 500, startedAt: "2026-11-05T16:50:00.000Z", endedAt: "2026-11-05T17:10:00.000Z" }),
      ],
      acts: [
        act("dc_1", "jb_a", "2026-11-05T17:05:00.000Z"), // both wakes hold it: the earlier one (16:50) takes it
        act("dc_2", "jb_b", "2026-11-05T17:30:00.000Z"),
        act("dc_3", "jb_c", "2026-11-05T17:40:00.000Z"),
        act("dc_4", "jb_d", "2026-11-05T17:50:00.000Z"),
      ],
      agents,
    }, NOW);
    expect(r.jobs.jb_a).toEqual({ tokens: 500, wakes: 1, decisions: 1 });
    expect(r.jobs.jb_b!.tokens + r.jobs.jb_c!.tokens + r.jobs.jb_d!.tokens).toBeGreaterThanOrEqual(999);
    expect(r.check.ok).toBe(true);
  });
});

describe("managerActs over the world: a manager reviewing a grant's report", () => {
  it("books the review wake's tokens to the grant's job (GET /api/grants/:id managing) and closes on the window's manage sessions", async () => {
    const { world, seed, admin } = seededWorld();
    const b = createBuilding(world, { name: "Jobby", headcount: 3, model: OPUS, cheapModel: "claude-haiku-5-5" }, seed.admin.id);
    const pix = createResident(world, { buildingId: b.id, name: "Pix" });
    updateBuilding(world, b.id, { managerAgentId: pix.id });
    creditBank(world);
    const steps = [{ size: "M" as const, title: "Build it", description: "Ship" }, { size: "M" as const, title: "Check it", description: "Look" }];
    const p = world.grantDesk.propose(null, world.grantDesk.create(null, b.id, { keyResults: [{ text: "A banner", howToCheck: "Open the lab" }], objective: "A banner", approach: "a", steps, stopCondition: "s", askTokens: 300_000 }).id);
    const g = world.grantDesk.decide(admin, p.id, { action: "fund" });
    const a = buildingQueue(world, b.id)[0]!;
    const { fork } = forkManager(world, b.id, a.id);
    world.assignments.patch(a.id, { status: "active" });
    const r = await world.verbs.submit_report(fork, { title: "Built it", body: "## What I did\nx\n## Findings\ny\n## What I need from you\nNothing needed.", verdict: "continue", left: "One step." });
    retireFork(world, fork.id);

    const wake = world.ops.startSession(pix.id, { purpose: "manage", model: OPUS });
    applyDecision(world, r.id, "approve", "", world.holderOf(pix));
    const ended = world.ops.endSession(wake.id, { status: "done", counts: { input: 0, output: 20_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } });
    const idle = world.ops.startSession(pix.id, { purpose: "manage", model: OPUS });
    world.ops.endSession(idle.id, { status: "done", counts: { input: 0, output: 5_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } });

    const tokens = Math.round(sessionTokens(ended));
    expect(tokens).toBeGreaterThan(0);
    expect(jobManaging(world, `jb_${g.id}`)).toEqual({ tokens, wakes: 1, decisions: 1 });
    const t = townManagerShares(world, new Date(Date.now() - 86_400_000).toISOString());
    expect(t.jobs[`jb_${g.id}`]).toEqual({ tokens, wakes: 1, decisions: 1 });
    expect(t.upkeep[b.id]?.wakes).toBe(1);
    expect(t.check.ok).toBe(true);
  });
});
