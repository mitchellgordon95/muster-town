import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { BankPoolSummary, Finance } from "../src/api";
import { FinanceView, poolDurable, runwayDays, sumCheckLine } from "../src/panels/FinancePanel";

// the live shape: 1,000 received, 1,100 used (200 overdrawn), 50 expired, 50 left
const f: Finance = {
  total: 1000, credited: 800, donated: 200, used: 1100, usedBank: 950, usedDonations: 150, expired: 50, left: 50, leftBank: 0, leftDonations: 50,
  overdrawn: 200, usageLedger: 1200, projection: { days: 30, trailingDailyBurn: 20, burnDays: 7, projectedUse30d: 600 },
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
  it("renders total, used, expired, left, the projection and the pools", () => {
    const html = renderToStaticMarkup(<FinanceView f={f} pools={[pool("General", -256870), pool("Research", 5000)]} />);
    for (const s of ["Total received", "1,000", "Used", "1,100", "Expired", "Left", "Overdrawn", "✓ Adds up", "20 / day", "average of the last 7 days", "600", "overdrawn by 256,870", "5,000"]) expect(html).toContain(s);
    expect(renderToStaticMarkup(<FinanceView f={{ ...f, sumCheck: { ...f.sumCheck, ok: false, diff: 5 } }} pools={null} />)).toContain("✗ Does not add up (off by 5)");
  });
});
