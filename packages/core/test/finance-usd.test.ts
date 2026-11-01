import { describe, expect, it } from "vitest";
import { financeSpend, financeSummary, sessionListUsd, type FinanceInputs, type SpendInputs } from "../src/index.ts";

// Dollars on the Bank (gr_gmzli3f96j): each session at its booking model's list output price, the rest at Opus 5.5's $20/M
const T0 = new Date("2026-11-01T12:00:00.000Z");
const day = (d: number) => new Date(T0.getTime() + d * 86_400_000).toISOString();
const zero = { input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, byModel: null };
// a pre-076 Fable session (no bankModel: booked in Fable output tokens, $50/M) and a post-076 Opus-booked one ($20/M)
const fable = { agentId: "ag_a", assignmentId: "a1", grantId: null, model: "claude-fable-5-1", bankModel: null, output: 1_000_000, endedAt: day(-3), ...zero };
const opus = { agentId: "ag_b", assignmentId: null, grantId: null, model: "claude-opus-5-5", bankModel: "claude-opus-5-5", output: 1_000_000, endedAt: day(-1), ...zero };
const spendIn: SpendInputs = {
  sessions: [fable, opus],
  assignments: [{ id: "a1", buildingId: "lab", grantId: null, title: "work" }],
  agents: [{ id: "ag_a", buildingId: "lab" }, { id: "ag_b", buildingId: "bank" }],
  buildings: [{ id: "lab", name: "Lab" }, { id: "bank", name: "Bank" }],
  grants: [],
  convertedAt: null,
};
const finIn = (usedTokens: number): FinanceInputs => ({
  credits: [{ id: "c1", tokens: 5_000_000, expiresAt: null }],
  debits: [{ creditId: null, tokens: usedTokens }],
  allocations: [],
  usage: [{ tokens: 0, createdAt: day(-20) }, { tokens: 7_000_000, createdAt: day(-1) }],
  bankInputs: [{ tokens: 500_000, recurrence: "daily", weeklyCapTokens: null, cancelledAt: null }],
  sessions: [fable, opus],
});

describe("usd at API list price (GET /api/finance and /api/finance/spend)", () => {
  it("prices a pre-076 Fable session at $50/M and an Opus-booked one at $20/M", () => {
    expect(sessionListUsd(fable)).toBe(50);
    expect(sessionListUsd(opus)).toBe(20);
  });

  it("finance usd: used is the sessions' list cost plus the rest at $20/M; left, burn and inflow at $20/M", () => {
    // used 2,100,000 tokens: sessions 2,000,000 ($70), 100,000 unattributed ($2)
    const f = financeSummary(finIn(2_100_000), T0);
    expect(f.usd).toEqual({ used: 72, left: 58, burnPerDay: 20, inflowPerDay: 10, pricedAt: "api-list" });
    expect(f.projection).toMatchObject({ trailingDailyBurn: 1_000_000, dailyInflow: 500_000 });
    // no sessions given: used is priced at $20/M (2.1M tokens = $42), not tokens × a guessed mix
    expect(financeSummary({ ...finIn(2_100_000), sessions: undefined }, T0).usd.used).toBe(42);
  });

  it("spend usd matches finance usd.used, the rows' dollars add up (unattributed case)", () => {
    const f = financeSpend(spendIn, 2_100_000, T0);
    expect(f.rows.map((r) => [r.kind, r.name, r.tokens, r.usd])).toEqual([
      ["building", "Lab", 1_000_000, 50],
      ["building", "Bank", 1_000_000, 20],
      ["unattributed", expect.any(String), 100_000, 2],
    ]);
    expect(f.rows[0].children![0]).toMatchObject({ kind: "no-grant", usd: 50 });
    expect(f.usd).toEqual({ used: 72, sessionsTotal: 70, unattributed: 2, weightMismatch: 0, notFunded: 0 });
    expect(f.usd.used).toBe(financeSummary(finIn(2_100_000), T0).usd.used);
    expect(f.usdSumCheck).toMatchObject({ ok: true, diff: 0 });
    expect(f.usdSumCheck.identity).toContain("in dollars");
  });

  it("not funded comes off in dollars too", () => {
    const f = financeSpend(spendIn, 1_900_000, T0);
    expect(f.rows.at(-1)).toMatchObject({ kind: "not-funded", tokens: -100_000, usd: -2 });
    expect(f.usd).toEqual({ used: 68, sessionsTotal: 70, unattributed: 0, weightMismatch: 0, notFunded: 2 });
    expect(f.usd.used).toBe(financeSummary(finIn(1_900_000), T0).usd.used);
    expect(f.usdSumCheck.ok).toBe(true);
  });

  it("rounds each row to the cent and still closes", () => {
    const odd = [1, 2, 3, 4, 5].map((i) => ({ ...opus, agentId: `ag_${i}`, output: 333 + i }));
    const f = financeSpend({ ...spendIn, sessions: odd, agents: odd.map((s, i) => ({ id: s.agentId, buildingId: `b${i}` })), buildings: [] }, 1_700, T0);
    expect(f.usdSumCheck.ok).toBe(true);
    expect(Math.abs(f.usdSumCheck.diff)).toBeLessThan(0.03);
  });
});
