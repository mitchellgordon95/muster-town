import { describe, expect, it } from "vitest";
import { financeDaily, financeSplit } from "../src/index.ts";

const NOW = new Date("2026-11-19T15:00:00.000Z");
const OPUS = "claude-opus-5-5";
type S = Parameters<typeof financeSplit>[0]["sessions"][number];
const ses = (day: string, over: Partial<S>): S => ({
  assignmentId: null, purpose: "work", lane: null, model: OPUS, bankModel: OPUS, byModel: null,
  startedAt: `${day}T10:00:00.000Z`, endedAt: `${day}T10:05:00.000Z`,
  input: 0, output: 1_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...over,
});
const assignments = [{ id: "as_g", lane: "grant" as const }, { id: "as_d", lane: "directed" as const }];

describe("financeSplit (GET /api/finance split, gr_3ougmyubdm)", () => {
  const sessions = [
    ses("2026-11-19", { assignmentId: "as_g" }),                    // work: grant via its assignment
    ses("2026-11-19", { purpose: "manage", output: 3_000 }),        // coordination
    ses("2026-11-18", { lane: "exploration", output: 2_000 }),      // work: its own lane
    ses("2026-11-17", { purpose: "review", output: 500 }),          // other
    ses("2026-11-13", { purpose: "manage", output: 4_000 }),        // 7 d window starts 11-13: in
    ses("2026-11-12", { assignmentId: "as_d", output: 10_000 }),    // only in 30 d
    ses("2026-10-21", { purpose: "manage", output: 100_000 }),      // 30 d starts 10-21: in
    ses("2026-10-20", { purpose: "manage", output: 999_000 }),      // outside both
    ses("2026-11-19", { startedAt: "2026-11-19T14:59:00.000Z", endedAt: null }), // running, no lane: other, today
  ];
  const { split, byDay } = financeSplit({ sessions, assignments }, NOW);

  it("splits 7 d into work, coordination and other that sum to the window's sessions", () => {
    const w = split.d7;
    expect(w).toMatchObject({ days: 7, from: "2026-11-13", to: "2026-11-19" });
    expect(w.total).toMatchObject({ tokens: 11_500, sessions: 6 });
    expect(w.work).toMatchObject({ tokens: 3_000, sessions: 2 });
    expect(w.coordination).toMatchObject({ tokens: 7_000, sessions: 2, share: 0.6087 });
    expect(w.other).toMatchObject({ tokens: 1_500, sessions: 2 });
    expect(w.byLane.grant.tokens).toBe(1_000);
    expect(w.byLane.exploration.tokens).toBe(2_000);
    expect(w.work.share + w.coordination.share + w.other.share).toBeCloseTo(1, 3);
    expect(w.total.usd).toBeGreaterThan(0);
  });

  it("30 d covers the chart's 30 rows; the check is ok", () => {
    expect(split.d30).toMatchObject({ days: 30, from: "2026-10-21", to: "2026-11-19" });
    expect(split.d30.total.tokens).toBe(121_500);
    expect(split.d30.work.tokens).toBe(13_000);
    expect(split.d30.coordination.tokens).toBe(107_000);
    expect(split.check).toMatchObject({ ok: true, diff: 0, dailyDiff: 0 });
    expect(split.groups.work).toEqual(["grant", "exploration", "directed", "retainer"]);
  });

  it("gives each day its lanes, and the daily rows carry them with an ok check", () => {
    expect(byDay.size).toBe(30);
    expect(byDay.get("2026-11-19")).toEqual({ byLane: { grant: 1_000, exploration: 0, directed: 0, retainer: 0, manager: 3_000, other: 1_000 }, sessionsTokens: 5_000 });
    const { daily, dailyCheck } = financeDaily({ debits: [{ buildingId: "b", tokens: 9, createdAt: "2026-10-01T00:00:00.000Z" }], credits: [], usedBank: 9, usedDonations: 0, lanesByDay: byDay }, NOW);
    expect(daily.rows).toHaveLength(30);
    expect(daily.rows.at(-1)).toMatchObject({ day: "2026-11-19", sessionsTokens: 5_000, byLane: { manager: 3_000 } });
    expect(daily.rows.reduce((n, r) => n + r.sessionsTokens, 0)).toBe(split.d30.total.tokens);
    expect(dailyCheck).toMatchObject({ ok: true, laneDiff: 0 });
  });

  it("is all zeros with an ok check when there are no sessions", () => {
    const r = financeSplit({ sessions: [], assignments: [] }, NOW);
    expect(r.split.d7.total.tokens).toBe(0);
    expect(r.split.d7.work.share).toBe(0);
    expect(r.split.check.ok).toBe(true);
  });
});
