import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { BankPoolSummary, Finance, FinanceSpend } from "../src/api";
import { FinanceView, overdrawnParts, pct, poolDurable, runwayDays, spendCheckLine, sumCheckLine } from "../src/panels/FinancePanel";

// the live shape: 1,000 received, 1,100 used (200 overdrawn), 50 expired, 50 left
const f: Finance = {
  total: 1000, credited: 800, donated: 200, used: 1100, usedBank: 950, usedDonations: 150, expired: 50, left: 50, leftBank: 0, leftDonations: 50,
  overdrawn: 200, overdrawnBreakdown: { durableOvershoot: 120, subscriptionOverdrawn: 70, deletedCreditDebits: 0, allocationOverspent: 10 }, usageLedger: 1200, projection: { days: 30, trailingDailyBurn: 20, burnDays: 7, projectedUse30d: 600 },
  sumCheck: { ok: true, diff: 0, identity: "used + expired + left = total + overdrawn" }, at: "2026-10-27T19:00:00.000Z",
};
const pool = (name: string, durableTokens: number): BankPoolSummary => ({ id: name, name, pct: 50, explicit: false, isDefault: name === "General", buildings: [], expiringTokens: 10, durableTokens });

describe("finance page", () => {
  it("says the four figures add up, overdrawn included", () => {
    expect(sumCheckLine(f)).toEqual({ ok: true, text: "Adds up: used 1,100 + expired 50 + left 50 = 1,200; total 1,000 + overdrawn 200 = 1,200" });
  });
  it("says clearly when the sum check fails", () => {
    const bad = sumCheckLine({ ...f, left: 70, sumCheck: { ...f.sumCheck, ok: false, diff: 20 } });
    expect(bad.ok).toBe(false);
    expect(bad.text).toMatch(/^Does not add up \(off by 20\)/);
  });
  it("shows an overdrawn pool as 0 with the debt on its own line", () => {
    expect(poolDurable({ durableTokens: -256870 })).toEqual({ shown: 0, overdrawnBy: 256870 });
    expect(poolDurable({ durableTokens: 42 })).toEqual({ shown: 42, overdrawnBy: 0 });
  });
  it("gives the runway at the trailing burn, none without a burn", () => {
    expect(runwayDays(f)).toBe(2);
    expect(runwayDays({ ...f, projection: { ...f.projection, trailingDailyBurn: 0 } })).toBeNull();
  });
  it("lists overdrawn's non-zero parts, which sum to it, with the pre-conversion note on the subscription part", () => {
    const parts = overdrawnParts(f);
    expect(parts.map((p) => p.key)).toEqual(["durableOvershoot", "subscriptionOverdrawn", "allocationOverspent"]);
    expect(parts.reduce((s, p) => s + p.tokens, 0)).toBe(f.overdrawn);
    const html = renderToStaticMarkup(<FinanceView f={f} pools={null} />);
    for (const s of ["overshoot debt", "120", "subscription credits drawn past their size", "Pre-conversion Fable draw", "migration 037", "spent past their size"]) expect(html).toContain(s);
    expect(html).not.toContain("credits since deleted");
  });
  it("renders total, used, expired, left, the projection and the pools", () => {
    const html = renderToStaticMarkup(<FinanceView f={f} pools={[pool("General", -256870), pool("Research", 5000)]} />);
    for (const s of ["Total received", "1,000", "Used", "1,100", "Expired", "Left", "Overdrawn", "✓ Adds up", "20 / day", "average of the last 7 days", "600", "overdrawn by 256,870", "5,000"]) expect(html).toContain(s);
    expect(renderToStaticMarkup(<FinanceView f={{ ...f, sumCheck: { ...f.sumCheck, ok: false, diff: 5 } }} pools={null} />)).toContain("✗ Does not add up (off by 5)");
  });
});

// the live shape of GET /api/finance/spend: sessions counted 1,150 against 1,100 used: a weight-mismatch row of −30
// (pre-conversion pricing) and a not-funded row of −20
const sp: FinanceSpend = {
  used: 1100, sessionsTotal: 1150, unattributed: 0, weightMismatch: 30, convertedAt: "2026-10-27T00:00:24.000Z", notFunded: 20, at: "2026-10-28T16:31:50.056Z",
  weightMismatchNote: "Sessions ended before the Bank's conversion to adjusted tokens (2026-10-27 00:00Z) are counted here at their own model's weights; the Bank booked them with no model, at Opus weights. The difference is pricing, not spend: nothing went unpaid.",
  rows: [
    { kind: "building", id: "workshop", name: "Town Workshop", tokens: 900, share: 0.8182, sessions: 9, children: [
      { kind: "grant", id: "gr_a", name: "Refactor the Bank", tokens: 500, share: 0.4545, sessions: 4, children: [
        { kind: "assignment", id: "as_a", name: "Step 1: the ledger", tokens: 500, share: 0.4545, sessions: 4 }] },
      { kind: "no-grant", id: null, name: "No grant (exploration, directed and earlier work)", tokens: 300, share: 0.2727, sessions: 3, children: [
        { kind: "assignment", id: "as_b", name: "Explore the map", tokens: 300, share: 0.2727, sessions: 3 }] },
      { kind: "no-assignment", id: null, name: "Manager sessions, no assignment", tokens: 100, share: 0.0909, sessions: 2 },
    ] },
    { kind: "building", id: "bl_b", name: "Bank Transparency", tokens: 250, share: 0.2273, sessions: 2 },
    { kind: "weight-mismatch", id: null, name: "Weight mismatch: sessions before the Bank's conversion to adjusted tokens, counted here at their own model's weights but booked by the Bank at Opus weights", tokens: -30, share: -0.0273, sessions: 12 },
    { kind: "not-funded", id: null, name: "Not funded: session spend beyond what the Bank and donations paid for", tokens: -20, share: -0.0182, sessions: 0 },
  ],
  check: { ok: true, diff: 0, identity: "buildings + unattributed − weight mismatch − not funded = used" },
};

describe("finance page: spending", () => {
  it("says the top-level rows sum to used, and by how much they miss when they don't", () => {
    expect(spendCheckLine(sp)).toEqual({ ok: true, text: "Adds up: the rows sum to used, 1,100" });
    expect(sp.rows.reduce((s, r) => s + r.tokens, 0)).toBe(sp.used);
    const bad = spendCheckLine({ ...sp, check: { ...sp.check, ok: false, diff: 7 } });
    expect(bad.ok).toBe(false);
    expect(bad.text).toBe("Does not add up (off by 7): the rows sum to 1,100, used is 1,100");
  });
  it("formats shares as percentages, negative for not funded", () => {
    expect(pct(0.8182)).toBe("81.8%");
    expect(pct(-0.0455)).toBe("-4.5%");
  });
  it("renders building → grant → assignment with the synthetic rows, collapsible", () => {
    const html = renderToStaticMarkup(<FinanceView f={f} pools={null} spend={sp} />);
    for (const s of ["Spending", "Town Workshop", "900", "81.8%", "Refactor the Bank", "Step 1: the ledger", "No grant", "Manager sessions, no assignment", "Weight mismatch", "-30", "12 sessions", "The difference is pricing, not spend", "Not funded", "-20", "Sessions counted more than", "✓ Adds up: the rows sum to used", "/api/finance/spend"]) expect(html).toContain(s);
    expect(html).toContain("<details");
    expect(renderToStaticMarkup(<FinanceView f={f} pools={null} spend={{ ...sp, check: { ...sp.check, ok: false, diff: 3 } }} />)).toContain("✗ Does not add up (off by 3)");
  });
  it("leaves the section out when the spend can't be loaded", () => {
    expect(renderToStaticMarkup(<FinanceView f={f} pools={null} />)).not.toContain("Spending");
  });
});
