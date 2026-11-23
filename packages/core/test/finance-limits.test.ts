import { describe, expect, it } from "vitest";
import { financeLimits, financeSplit, limitsCheck, windowLimits } from "../src/index.ts";

const NOW = new Date("2026-11-19T12:00:00.000Z");
const OPUS = "claude-opus-5-5";
type S = Parameters<typeof financeLimits>[0]["sessions"][number];
const ses = (day: string, over: Partial<S>): S => ({
  assignmentId: null, purpose: "work", lane: null, backend: "docker", status: "done", model: OPUS, bankModel: OPUS, byModel: null,
  startedAt: `${day}T10:00:00.000Z`, endedAt: `${day}T11:00:00.000Z`, wallMs: null,
  input: 0, output: 1_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...over,
});
const days = ["2026-11-17", "2026-11-18", "2026-11-19"];
const assignments = [
  { id: "as_g", lane: "grant" as const, status: "done" as const, heldReason: null, createdAt: "2026-11-18T09:00:00.000Z" },
  { id: "as_h", lane: "exploration" as const, status: "pending" as const, heldReason: "held: exploration cap reached", createdAt: "2026-11-19T09:00:00.000Z" },
  { id: "as_q", lane: "grant" as const, status: "pending" as const, heldReason: null, createdAt: "2026-11-18T10:00:00.000Z" },
];
const buildings = [{ headcount: 2 }, { headcount: 3 }];
const goals = [
  { id: "gl_town", parentId: null, exploreCapTokensPerDay: 2_000 },
  { id: "gl_sub", parentId: "gl_town", exploreCapTokensPerDay: 500 }, // not a root: not the town's cap
];
const sessions: S[] = [
  ses("2026-11-17", { lane: "exploration", output: 1_500, endedAt: "2026-11-17T11:00:00.000Z" }),
  ses("2026-11-17", { lane: "exploration", output: 1_000, startedAt: "2026-11-17T12:00:00.000Z", endedAt: "2026-11-17T13:30:00.000Z" }), // cap reached here
  ses("2026-11-17", { startedAt: "2026-11-17T23:00:00.000Z", endedAt: "2026-11-18T01:00:00.000Z", assignmentId: "as_g" }), // 1 h each day; tokens on 11-18
  ses("2026-11-18", { purpose: "manage", backend: "host", output: 9_000 }), // host: no desk; manager lane
  ses("2026-11-18", { lane: "exploration", output: 700 }), // under the cap
  ses("2026-11-19", { status: "running", startedAt: "2026-11-19T11:30:00.000Z", endedAt: null }), // 0.5 h so far
  ses("2026-11-19", { endedAt: null, wallMs: 3_600_000 }), // no end, wallMs: 1 h
  ses("2026-11-19", { endedAt: null, startedAt: "2026-11-19T08:00:00.000Z", status: "error" }), // no end, no wallMs: 0 h, noEnd
];

describe("financeLimits (GET /api/finance limits, gr_6c24p5uy01)", () => {
  const { byDay, noEnd } = financeLimits({ sessions, assignments, buildings, goals, days }, NOW);

  it("counts desk-hours busy of available, clipped to each day, host sessions left out", () => {
    expect(byDay.get("2026-11-17")).toMatchObject({ deskHoursBusy: 3.5, deskHours: 120, desks: 5 }); // 1 + 1.5 + 1 (to midnight)
    expect(byDay.get("2026-11-18")).toMatchObject({ deskHoursBusy: 2, deskHours: 120 }); // 1 (from midnight) + 1
    expect(byDay.get("2026-11-19")).toMatchObject({ deskHoursBusy: 1.5, deskHours: 60 }); // today: 12 h so far
    expect(noEnd).toBe(1);
  });

  it("says when exploration reached the town's (root) cap", () => {
    expect(byDay.get("2026-11-17")!.exploration).toEqual({ tokens: 2_500, cap: 2_000, capGoalId: "gl_town", reachedAt: "2026-11-17T13:30:00.000Z" });
    expect(byDay.get("2026-11-18")!.exploration).toMatchObject({ tokens: 700, reachedAt: null });
  });

  it("counts grant tokens and grant work queued by day, and held work today only", () => {
    expect(byDay.get("2026-11-18")).toMatchObject({ grantTokens: 1_000, grantsQueued: 2, held: null });
    expect(byDay.get("2026-11-17")).toMatchObject({ grantTokens: 0, grantsQueued: 0, held: null });
    expect(byDay.get("2026-11-19")!.held).toBe(1);
  });

  it("agrees with finance-split's byLane, and sums windows", () => {
    const { byDay: lanes } = financeSplit({ sessions, assignments }, NOW, 3);
    const rows = days.map((day) => ({ day, byLane: lanes.get(day)!.byLane, limits: byDay.get(day) }));
    expect(limitsCheck(rows, noEnd)).toMatchObject({ ok: true, diff: 0, overDays: 0, noEnd: 1 });
    expect(windowLimits(rows, "2026-11-17", "2026-11-19", 3)).toEqual({
      days: 3, from: "2026-11-17", to: "2026-11-19", deskHoursBusy: 7, deskHours: 300, deskShare: 0.0233, capDays: 1, grantDays: 1,
    });
    // a day whose exploration differs from byLane fails the check
    const bad = rows.map((r, i) => (i === 0 ? { ...r, byLane: { ...r.byLane, exploration: r.byLane.exploration + 5 } } : r));
    expect(limitsCheck(bad, 0)).toMatchObject({ ok: false, diff: 5 });
  });

  it("an uncapped town has no cap and never reaches it", () => {
    const { byDay: d } = financeLimits({ sessions, assignments, buildings, goals: [{ id: "gl_town", parentId: null, exploreCapTokensPerDay: null }], days }, NOW);
    expect(d.get("2026-11-17")!.exploration).toMatchObject({ cap: null, capGoalId: null, reachedAt: null });
  });
});

describe("Bank.finance carries the limits (gr_6c24p5uy01)", () => {
  it("every daily row has limits, both windows a summary, and the check holds", async () => {
    const { seededWorld } = await import("./helpers.ts");
    const { world } = seededWorld();
    const f = world.bank.finance();
    expect(f.daily.rows.length).toBeGreaterThan(0);
    for (const r of f.daily.rows) expect(r.limits).toMatchObject({ desks: expect.any(Number), exploration: expect.any(Object) });
    expect(f.daily.rows.at(-1)!.limits!.held).toEqual(expect.any(Number));
    expect(f.utilization.d7.limits).toMatchObject({ days: 7, capDays: expect.any(Number), grantDays: expect.any(Number) });
    expect(f.utilization.d30.limits).toMatchObject({ days: 30 });
    expect(f.limitsCheck).toMatchObject({ ok: true, diff: 0 });
    expect(f.limitsNote).toMatch(/today's/);
  });
});
