import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { BankPoolSummary, Finance, FinancePools, FinanceSources, FinanceSpend } from "../src/api";
import { donationNote, FinanceView, inputName, overdrawnParts, poolsBalanceLine, poolsDrawsLine, sourcesCheckLine, pct, poolDurable, runwayDays, spendCheckLine, sumCheckLine } from "../src/panels/FinancePanel";

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
    for (const s of ["overshoot debt", "120", "subscription credits drawn past their size", "switch to adj. tokens on 2026-10-27", "Fable sessions drew on credits sized in raw tokens", "spent past their size"]) expect(html).toContain(s);
    expect(html).not.toContain("credits since deleted");
  });
  it("renders total, used, expired, left, the projection and the pools", () => {
    const html = renderToStaticMarkup(<FinanceView f={f} pools={[pool("General", -256870), pool("Research", 5000)]} />);
    for (const s of ["the unit the town pays for AI model work in", "A ✓ line under a section means", "Total received", "1,000", "Used", "1,100", "Expired", "Left", "Overdrawn", "✓ Adds up", "20 / day", "average of the last 7 days", "600", "overdrawn by 256,870", "5,000"]) expect(html).toContain(s);
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
    for (const s of ["Spending", "Town Workshop", "900", "81.8%", "Refactor the Bank", "Step 1: the ledger", "No grant", "Manager sessions, no assignment", "Weight mismatch", "-30", "12 sessions", "The difference is pricing, not spend", "Not funded", "-20", "never charged to the Bank or a donation", "✓ Adds up: the rows sum to used", "/api/finance/spend"]) expect(html).toContain(s);
    expect(html).toContain("<details");
    expect(renderToStaticMarkup(<FinanceView f={f} pools={null} spend={{ ...sp, check: { ...sp.check, ok: false, diff: 3 } }} />)).toContain("✗ Does not add up (off by 3)");
  });
  it("leaves the section out when the spend can't be loaded", () => {
    expect(renderToStaticMarkup(<FinanceView f={f} pools={null} />)).not.toContain("Spending");
  });
});

// GET /api/finance/sources for the same 1,000 received: 800 credited by two inputs (one cancelled), 200 donated (one retired)
const src: FinanceSources = {
  inputs: [
    { id: "in_a", label: "Mitchell's Max plan", source: "subscription", recurrence: "daily", who: "Mitchell", createdAt: "2026-10-20T00:00:00.000Z", cancelledAt: null,
      tokens: 600, firstAt: "2026-10-20T00:00:00.000Z", lastAt: "2026-10-27T00:00:00.000Z", expiredTokens: 50, credits: [
        { id: "cr_1", createdAt: "2026-10-20T00:00:00.000Z", expiresAt: "2026-10-21T00:00:00.000Z", tokens: 300, expiredTokens: 50 },
        { id: "cr_2", createdAt: "2026-10-27T00:00:00.000Z", expiresAt: "2026-10-28T00:00:00.000Z", tokens: 300, expiredTokens: 0 }] },
    { id: "in_b", label: "", source: "api-key", recurrence: "once", who: "Kelly", createdAt: "2026-10-21T00:00:00.000Z", cancelledAt: "2026-10-25T09:00:00.000Z",
      tokens: 200, firstAt: "2026-10-21T00:00:00.000Z", lastAt: "2026-10-21T00:00:00.000Z", expiredTokens: 0, credits: [
        { id: "cr_3", createdAt: "2026-10-21T00:00:00.000Z", expiresAt: null, tokens: 200, expiredTokens: 0 }] },
  ],
  donations: [
    { id: "al_a", label: "For the map", who: "Lena", buildingId: "workshop", buildingName: "Town Workshop", createdAt: "2026-10-22T00:00:00.000Z", auth: "donor-key", retired: false, sizeTokens: 150, spentTokens: 20, tokens: 150 },
    { id: "al_b", label: "", who: "Ravi", buildingId: "bl_b", buildingName: "Bank Transparency", createdAt: "2026-10-23T00:00:00.000Z", auth: "api-key", retired: true, sizeTokens: 90, spentTokens: 50, tokens: 50 },
  ],
  creditedTokens: 800, donatedTokens: 200, totalReceived: 1000, expiredTokens: 50,
  sumCheck: { ok: true, diff: 0, identity: "credits + donations = total received" }, financeTotal: 1000, matchesFinance: true, at: "2026-10-29T00:00:00.000Z",
};

describe("finance page: sources", () => {
  it("names inputs and notes donations counted under their size", () => {
    expect(inputName(src.inputs[0])).toBe("Mitchell's Max plan");
    expect(inputName(src.inputs[1])).toBe("API key from Kelly");
    expect(donationNote(src.donations[0])).toBeNull();
    expect(donationNote(src.donations[1])).toBe("counted at what it spent (size 90)");
  });
  it("checks the subtotals against total received and the Tokens total", () => {
    expect(sourcesCheckLine(src)).toEqual({ ok: true, text: "Adds up: credited 800 + donated 200 = 1,000, the Tokens section's total" });
    expect(sourcesCheckLine({ ...src, sumCheck: { ...src.sumCheck, ok: false, diff: 4 } }).text).toMatch(/^Does not add up \(off by 4\)/);
    const off = sourcesCheckLine({ ...src, financeTotal: 990, matchesFinance: false });
    expect(off).toEqual({ ok: false, text: "Does not match the Tokens total (off by 10): credited 800 + donated 200 = 1,000, Tokens total 990" });
  });
  it("renders each input with its dated credits behind a toggle, each donation, the subtotals and the checked total, above Spending", () => {
    const html = renderToStaticMarkup(<FinanceView f={f} pools={null} spend={sp} sources={src} />);
    for (const s of ["Sources", "What the town received and from whom", "Mitchell&#x27;s Max plan", "subscription · daily", '<span class="day">2026-10-20 →</span> <span class="day">2026-10-27</span>', "600",
      "API key from Kelly", "cancelled", "Cancelled 2026-10-25", "permanent", "expires 2026-10-21 00:00", "50 expired undrawn",
      "For the map", "to Town Workshop", "from Ravi", "to Bank Transparency", "counted at what it spent (size 90)", "2026-10-23",
      "Credited through the Bank", "800", "Donated to buildings", "Total received", "✓ Adds up: credited 800 + donated 200 = 1,000", "/api/finance/sources"]) expect(html).toContain(s);
    // the credits sit inside the input's <details>, after its <summary>
    const first = html.slice(html.indexOf("<details"), html.indexOf("</details>"));
    expect(first).toContain("<summary>");
    expect(first.slice(first.indexOf("</summary>"))).toContain("expires 2026-10-21 00:00");
    expect(html.indexOf("Sources")).toBeLessThan(html.indexOf("Spending"));
    expect(renderToStaticMarkup(<FinanceView f={f} pools={null} sources={{ ...src, financeTotal: 990, matchesFinance: false }} />)).toContain("✗ Does not match the Tokens total (off by 10)");
  });
  it("leaves the section out when the sources can't be loaded", () => {
    expect(renderToStaticMarkup(<FinanceView f={f} pools={null} />)).not.toContain("Credited through the Bank");
  });
});

// GET /api/finance/pools: General (70%) overdrawn by 120 permanent, Labs (30%), 10 unshared (rounding); 950 drawn, all of it by buildings
const fp: FinancePools = {
  pools: [
    { id: "general", name: "General", pct: 70, explicit: false, isDefault: true, buildings: [{ id: "workshop", name: "Town Workshop" }, { id: "town-hall", name: "Town Hall" }],
      expiringLeft: 30, durableLeft: 0, left: 30, overdrawn: 120, drawn: 800, dailyInflowTokens: 210 },
    { id: "pl_labs", name: "Labs", pct: 30, explicit: true, isDefault: false, buildings: [{ id: "bl_b", name: "Bank Transparency" }],
      expiringLeft: 20, durableLeft: 60, left: 80, overdrawn: 0, drawn: 150, dailyInflowTokens: 90 },
  ],
  buildings: [
    { id: "workshop", name: "Town Workshop", poolId: "general", poolName: "General", drawsFromBank: true, drawn: 800, drawnSubscription: 600, drawnDurable: 200, drawnMemberFunded: 0, donated: 150, donationsSpent: 20, held: 130, explorationTokensPerDay: 40000 },
    { id: "bl_b", name: "Bank Transparency", poolId: "pl_labs", poolName: "Labs", drawsFromBank: true, drawn: 150, drawnSubscription: 150, drawnDurable: 0, drawnMemberFunded: 0, donated: 50, donationsSpent: 50, held: 0, explorationTokensPerDay: 25000 },
    { id: "town-hall", name: "Town Hall", poolId: "general", poolName: "General", drawsFromBank: false, drawn: 0, drawnSubscription: 0, drawnDurable: 0, drawnMemberFunded: 0, donated: 0, donationsSpent: 0, held: 0, explorationTokensPerDay: 0 },
  ],
  sharedPct: 100, balanceTokens: 120, overshootTokens: 120, poolsLeftTokens: 110, poolsOverdrawnTokens: 120, unsharedTokens: 10,
  usedBank: 950, donatedTokens: 200, heldTokens: 130,
  sumCheck: { drawsOk: true, drawsDiff: 0, balanceOk: true, balanceDiff: 0, ok: true, identities: { draws: "Σ building draws = Σ pool draws = Bank debits", balance: "Σ pools left − Σ pools overdrawn + unshared = Bank balance − overshoot" } },
  at: "2026-10-29T04:00:00.000Z",
};

describe("finance page: pools", () => {
  it("checks the pools against the Bank balance and the building draws against the Bank debits", () => {
    expect(poolsBalanceLine(fp)).toEqual({ ok: true, text: "Adds up: pools left 110 − overdrawn 120 + unshared 10 = 0; Bank balance 120 − overshoot 120 = 0" });
    expect(poolsDrawsLine(fp)).toEqual({ ok: true, text: "Adds up: building draws = pool draws = Bank debits = 950" });
  });
  it("says by how much a failing check misses", () => {
    const bad: FinancePools = { ...fp, usedBank: 960, sumCheck: { ...fp.sumCheck, drawsOk: false, drawsDiff: 20, balanceOk: false, balanceDiff: 7, ok: false } };
    expect(poolsDrawsLine(bad)).toEqual({ ok: false, text: "Does not add up (off by 20): building draws 950, pool draws 950, Bank debits 960" });
    expect(poolsBalanceLine(bad).text).toMatch(/^Does not add up \(off by 7\): pools left 110/);
    const html = renderToStaticMarkup(<FinanceView f={f} pools={null} poolsFin={bad} />);
    expect(html).toContain("✗ Does not add up (off by 20)");
    expect(html).toContain("✗ Does not add up (off by 7)");
  });
  it("renders each pool with its share and left, an overdrawn pool's debt on its own row, then each building, between Sources and Spending", () => {
    const html = renderToStaticMarkup(<FinanceView f={f} pools={[pool("General", -256870)]} spend={sp} sources={src} poolsFin={fp} />);
    for (const s of ["Pools", "General", "70%", "Labs", "30%", "Town Workshop, Town Hall", "General overdrawn: permanent tokens drawn past its share", "−120", "Unshared", "Bank balance less overshoot",
      "✓ Adds up: pools left 110", "Drawn from pools", "800", "drawn all time 800", "permanent 60", "donated 150", "held 130", "exploration 40,000 / day", "25,000", "draws nothing from the Bank", "✓ Adds up: building draws = pool draws = Bank debits = 950", "/api/finance/pools"]) expect(html).toContain(s);
    expect(html).toContain('class="spend-row finance-overdrawn pool-overdrawn"');
    expect(html.indexOf("Credited through the Bank")).toBeLessThan(html.indexOf("Bank balance less overshoot"));
    expect(html.indexOf("Bank balance less overshoot")).toBeLessThan(html.indexOf("Spending"));
    // the pools endpoint replaces the older /api/bank pools table
    expect(html).not.toContain("overdrawn by 256,870");
    expect(renderToStaticMarkup(<FinanceView f={f} pools={null} poolsFin={{ ...fp, pools: [{ ...fp.pools[1] }] }} />)).not.toContain("pool-overdrawn");
  });
  it("leaves the section out when the pools can't be loaded", () => {
    expect(renderToStaticMarkup(<FinanceView f={f} pools={null} />)).not.toContain("Drawn from pools");
  });
});
