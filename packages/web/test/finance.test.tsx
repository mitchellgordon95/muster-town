import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Finance, FinanceFly, FinanceSources, FinanceSpend } from "../src/api";
import { approxUsd, dollars, donationNote, FINANCE_TERMS, mixLine, spendUsdCheckLine, USD_NOTE, flyCheckLine, flyWindowLabel, flyWindowTotals, HOSTED_FLY_NOTE, inputName, notFundedNote, overdrawnParts, sourcesCheckLine, pct, netPerDay, runwayText, spendCheckLine, sumCheckLine, type FinanceData } from "../src/panels/BankFinance";
import { BANK_TABS, type TokenMix } from "@muster-town/schema";
import { BankView } from "../src/panels/BankPanel";
import { BankFreeTokens, freeBreakdown } from "../src/panels/FreeTokens";
import { claimedTokens } from "../src/format";

// the live shape: 1,000 received, 1,100 used (200 overdrawn), 50 expired, 50 left
const f: Finance = {
  total: 1000, credited: 800, donated: 200, used: 1100, usedBank: 950, usedDonations: 150, expired: 50, left: 50, leftBank: 0, leftDonations: 50,
  overdrawn: 200, overdrawnBreakdown: { durableOvershoot: 120, subscriptionOverdrawn: 70, deletedCreditDebits: 0, allocationOverspent: 10 }, usageLedger: 1200, projection: { days: 30, trailingDailyBurn: 20, burnDays: 7, projectedUse30d: 600, dailyInflow: 5, netDailyBurn: 15, projectedInflow30d: 150, runwayDays: 3, runway: "days" },
  sumCheck: { ok: true, diff: 0, identity: "used + expired + left = total + overdrawn" }, at: "2026-10-27T19:00:00.000Z",
};
const noop = () => undefined;
/** One tab of the Bank page before GET /api/bank answers (a stranger, signed out), with these finance sections. */
const tabOf = (tab: string, fin: Partial<FinanceData>) => renderToStaticMarkup(<BankView tab={tab} bank={null} fin={{ f, spend: null, sources: null, fly: null, ...fin }} rev={0} onChange={noop} onReload={noop} />);
/** Every tab of the Bank page, in order. */
const page = (fin: Partial<FinanceData>) => BANK_TABS.map((t) => tabOf(t, fin)).join("");

describe("finance page", () => {
  it("says the four figures add up, overdrawn included", () => {
    expect(sumCheckLine(f)).toEqual({ ok: true, text: "The server checked that used 1,100 + expired 50 + left 50 equals total 1,000 + overdrawn 200 (1,200)." });
  });
  it("says clearly when the sum check fails", () => {
    const bad = sumCheckLine({ ...f, left: 70, sumCheck: { ...f.sumCheck, ok: false, diff: 20 } });
    expect(bad.ok).toBe(false);
    expect(bad.text).toBe("Does not add up (off by 20): used 1,100 + expired 50 + left 70 comes to 1,220, but total 1,000 + overdrawn 200 comes to 1,200.");
  });
  it("nets the daily inflow against the burn: short, covered, no usage (gr_rdzg83m0al)", () => {
    const p = f.projection;
    expect([netPerDay(p), runwayText(p)]).toEqual(["−15 / day shortfall", "3 days"]);
    const covered = { ...p, dailyInflow: 30, netDailyBurn: -10, projectedInflow30d: 900, runwayDays: null, runway: "covered" as const };
    expect([netPerDay(covered), runwayText(covered)]).toEqual(["+10 / day surplus", "covered by the daily inflow"]);
    const idle = { ...p, trailingDailyBurn: 0, netDailyBurn: -5, runwayDays: null, runway: "no-usage" as const };
    expect(runwayText(idle)).toBe("nothing used lately");
    const ov = tabOf("Overview", { f: { ...f, projection: covered } });
    for (const s of ["Coming in (expected from recurring inputs)", "30 / day", "+10 / day surplus", "covered by the daily inflow", "one-off donations"]) expect(ov).toContain(s);
    expect(ov).not.toContain(">0 days<");
  });
  it("lists overdrawn's non-zero parts, which sum to it, with the pre-conversion note on the subscription part", () => {
    const parts = overdrawnParts(f);
    expect(parts.map((p) => p.key)).toEqual(["durableOvershoot", "subscriptionOverdrawn", "allocationOverspent"]);
    expect(parts.reduce((s, p) => s + p.tokens, 0)).toBe(f.overdrawn);
    const html = page({});
    for (const s of ["sessions that ran past the permanent tokens the Bank had", "120", "subscription credits drawn past their size", "switch to adj. tokens on 2026-10-27", "Fable sessions drew on credits sized in raw tokens", "spent past their size"]) expect(html).toContain(s);
    expect(html).not.toContain("drawn from credits since deleted");
  });
  it("renders the unit line, total, used, expired, left and the projection on the Bank page, with the footer", () => {
    const html = page({});
    for (const s of ["the unit the town pays for AI model work in", "A ✓ line under a section means", "Balance", "Total received", "1,000", "Used", "1,100", "Expired", "Left", "Overdrawn", "✓ The server checked that used 1,100", "20 / day", "average of the last 7 days", "600", "As of 2026-10-27 19:00 UTC", "GET /api/bank", "/api/finance"]) expect(html).toContain(s);
    expect(page({ f: { ...f, sumCheck: { ...f.sumCheck, ok: false, diff: 5 } } })).toContain("✗ Does not add up (off by 5)");
  });
  it("splits the page into tabs, each a thing in the Bank's room, each ending with its sources (1:1 mt_ew2d0mm7h9)", () => {
    expect([...BANK_TABS]).toEqual(["Overview", "Tokens & sources", "Free tokens", "Spending", "Hosting"]);
    const all = { spend: sp, sources: src, fly };
    const has: Record<string, string[]> = {
      Overview: ["Balance", "Next 30 days"], "Tokens & sources": ["Tokens", "Sources"], "Free tokens": ["Free tokens by goal"], Spending: ["Spending"], Hosting: ["Hosting (Fly.io)"],
    };
    for (const t of BANK_TABS) {
      const html = tabOf(t, all);
      for (const s of has[t]) expect(html, `${t} has ${s}`).toContain(`>${s}<`);
      for (const [o, ss] of Object.entries(has)) if (o !== t) for (const s of ss) expect(html, `${t} lacks ${s}`).not.toContain(`>${s}<`);
      expect(html, t).toContain("As of 2026-10-27");
    }
    const ov = tabOf("Overview", all);
    expect(ov.indexOf(">Balance<")).toBeLessThan(ov.indexOf(">Next 30 days<"));
  });
  it("ends every tab with the Terms block, above the footer, defining each term the page uses (kr_zjawesqcyp)", () => {
    const all = { spend: sp, sources: src, fly };
    expect(FINANCE_TERMS.map(([t]) => t)).toEqual(["Adjusted token (adj. token)", "Expiring and permanent", "Overdrawn", "Held", "Claimed", "Free tokens", "Earmark", "Exploration cap", "Not funded", "≈ $ (API list price)", "Grant"]);
    for (const t of BANK_TABS) {
      const html = tabOf(t, all);
      expect(html, t).toContain("Terms used on this page");
      for (const [term] of FINANCE_TERMS) expect(html, `${t}: ${term}`).toContain(`<dt><b>${term}</b></dt>`);
      expect(html.indexOf("Terms used on this page"), t).toBeLessThan(html.indexOf("As of 2026-10-27"));
    }
    expect(tabOf("Overview", {})).toContain("What one is made of (the share of input, cache read, cache write and output over the last 7 days, updated daily) is under Tokens &amp; sources.");
  });
  it("Tokens & sources says what 1 adj. token is made of, from the stored mix, with the formula (1:1 mt_rbc3exb393)", () => {
    const mix: TokenMix = {
      unitModel: "claude-opus-5-5", weights: { input: 0.2, output: 1, cacheRead: 0.01, cacheWrite5m: 0.25, cacheWrite1h: 0.4 },
      formula: "adj. tokens = output + 0.2 × input + 0.01 × cache read + 0.25 × cache write (5 min) + 0.4 × cache write (1 h)",
      windowDays: 7, from: "2026-10-25T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z", computedAt: "2026-11-01T00:00:12.000Z", source: "usage", sessions: 412,
      counts: { input: 100_000, output: 10_000, cacheRead: 1_000_000, cacheWrite5m: 40_000, cacheWrite1h: 0 }, rawTokens: 1_150_000, adjustedTokens: 50_000, rawPerAdjusted: 23,
      rawShare: { input: 100 / 1150, output: 10 / 1150, cacheRead: 1000 / 1150, cacheWrite5m: 40 / 1150, cacheWrite1h: 0 },
      costShare: { input: 0.4, output: 0.2, cacheRead: 0.2, cacheWrite5m: 0.2, cacheWrite1h: 0 },
    };
    const m = mixLine(mix);
    expect(m.line).toBe("1 adj. token ≈ 23.0 raw tokens: 8.7% input, 87.0% cache read, 3.5% cache write, 0.87% output (from the last 7 days of usage, 412 sessions, updated daily; last 2026-11-01 00:00 UTC).");
    expect(m.formula).toContain("adj. tokens = output + 0.2 × input + 0.01 × cache read");
    expect(m.formula).toContain("Of what those tokens cost: 40.0% input, 20.0% cache read, 20.0% cache write, 20.0% output.");
    const html = renderToStaticMarkup(<BankView tab="Tokens & sources" bank={null} fin={{ f: { ...f, mix }, spend: null, sources: null, fly: null }} rev={0} onChange={noop} onReload={noop} />);
    expect(html).toContain("1 adj. token ≈ 23.0 raw tokens: 8.7% input");
    expect(tabOf("Tokens & sources", {})).not.toContain("1 adj. token ≈");
    expect(mixLine({ ...mix, source: "calibration", sessions: 0 }).line).toContain("no usage in the last 7 days yet, so the first calibration");
  });
  it("uses no internal names anywhere on the page", () => {
    const html = page({ spend: sp, sources: src, fly });
    for (const s of ["Weight mismatch", "weight mismatch", "Opus weights", "migration", "overshoot"]) expect(html).not.toContain(s);
    expect(html).not.toMatch(/\blanes?\b/i);
  });
});

// the live shape of GET /api/finance/spend: sessions counted 1,150 against 1,100 used: a weight-mismatch row of −30
// (pre-conversion pricing) and a not-funded row of −20
const sp: FinanceSpend = {
  used: 1100, sessionsTotal: 1150, unattributed: 0, weightMismatch: 30, convertedAt: "2026-10-27T00:00:24.000Z", notFunded: 20, at: "2026-10-28T16:31:50.056Z",
  notFundedSplit: [{ buildingId: "workshop", buildingName: "Town Workshop", usageRows: 2, tokens: 20 }], notFundedLastAt: "2026-10-28T10:00:00.000Z",
  notFundedAllocationPaid: 0, notFundedSplitCheck: { sum: 20, notFunded: 20, ok: true },
  weightMismatchNote: "Sessions that ended before the Bank switched to adjusted tokens (2026-10-27 00:00Z) are priced here at their own model's rate and in the Bank at one rate for every model. The difference is pricing, not spend: nothing went unpaid.",
  rows: [
    { kind: "building", id: "workshop", name: "Town Workshop", tokens: 900, share: 0.8182, sessions: 9, children: [
      { kind: "grant", id: "gr_a", name: "Refactor the Bank…", objective: "Refactor the Bank: one ledger for every debit", tokens: 500, share: 0.4545, sessions: 4, children: [
        { kind: "assignment", id: "as_a", name: "Step 1: the ledger", tokens: 500, share: 0.4545, sessions: 4 }] },
      { kind: "no-grant", id: null, name: "Not under a grant: work a human asked for, work a building took up on its own, and sessions from before grants existed", tokens: 300, share: 0.2727, sessions: 3, children: [
        { kind: "assignment", id: "as_b", name: "Explore the map", tokens: 300, share: 0.2727, sessions: 3 }] },
      { kind: "no-assignment", id: null, name: "The manager's own sessions: reading reports, running meetings and replying (no assignment)", tokens: 100, share: 0.0909, sessions: 2 },
    ] },
    { kind: "building", id: "bl_b", name: "Bank Transparency", tokens: 250, share: 0.2273, sessions: 2 },
    { kind: "weight-mismatch", id: null, name: "Priced differently before the switch to adjusted tokens (nothing went unpaid)", tokens: -30, share: -0.0273, sessions: 12 },
    { kind: "not-funded", id: null, name: "Not funded: work sessions the Bank never charged", tokens: -20, share: -0.0182, sessions: 0 },
  ],
  check: { ok: true, diff: 0, identity: "buildings + unattributed − weight mismatch − not funded = used" },
};

describe("finance page: spending", () => {
  it("says the top-level rows sum to used, and by how much they miss when they don't", () => {
    expect(spendCheckLine(sp)).toEqual({ ok: true, text: "The server checked that the building rows, plus usage no session recorded, less the pricing difference and the unfunded part, equal used 1,100." });
    expect(sp.rows.reduce((s, r) => s + r.tokens, 0)).toBe(sp.used);
    const bad = spendCheckLine({ ...sp, check: { ...sp.check, ok: false, diff: 7 } });
    expect(bad.ok).toBe(false);
    expect(bad.text).toBe("Does not add up (off by 7): the rows come to 1,100, but used is 1,100.");
  });
  it("formats shares as percentages, negative for not funded", () => {
    expect(pct(0.8182)).toBe("81.8%");
    expect(pct(-0.0455)).toBe("-4.5%");
  });
  it("renders building → grant → assignment with the synthetic rows, collapsible", () => {
    const html = page({ spend: sp });
    for (const s of ["Spending", "Town Workshop", "900", "81.8%", "Refactor the Bank…", "Step 1: the ledger", "Not under a grant", "The manager&#x27;s own sessions", "Priced differently before the switch to adjusted tokens", "-30", "12 sessions", "The difference is pricing, not spend", "Not funded", "-20", "Usage the Bank never debited", "Written off: not charged to any building", "✓ The server checked that the building rows", "/api/finance/spend"]) expect(html).toContain(s);
    expect(html).toContain("<details");
    // a grant row links to its grant page, with the full objective on hover
    expect(html).toContain(`<a class="spend-grant" href="#/grant/gr_a" title="Refactor the Bank: one ledger for every debit">Refactor the Bank…</a>`);
    // no lane names in the section itself (the Terms block names exploration: free tokens are what it may claim)
    const section = html.slice(html.indexOf("<h3>Spending</h3>"), html.indexOf("</section>", html.indexOf("<h3>Spending</h3>")));
    for (const s of ["Weight mismatch", "Opus weights", "exploration", "directed", "migration"]) expect(section).not.toContain(s);
    expect(page({ spend: { ...sp, check: { ...sp.check, ok: false, diff: 3 } } })).toContain("✗ Does not add up (off by 3)");
  });
  it("explains the Not funded row from the live fields: cause, stop date, split by building, write-off", () => {
    // the live shape on 2026-10-31: the split by the 2-second rule does not sum to notFunded
    const live = { ...sp, notFunded: 195957, notFundedLastAt: "2026-10-26T22:52:13.738Z", notFundedAllocationPaid: 4269596,
      notFundedSplit: [
        { buildingId: "bl_xvgnd1fvh6", buildingName: "Prod", usageRows: 3, tokens: 123238 },
        { buildingId: "workshop", buildingName: "Town Workshop", usageRows: 5, tokens: 4269596 },
        { buildingId: null, buildingName: "unattributed", usageRows: 1, tokens: 7 },
      ],
      notFundedSplitCheck: { sum: 4392841, notFunded: 195957, ok: false } };
    const note = notFundedNote(live);
    expect(note.split).toEqual([
      { name: "Town Workshop", tokens: 4269596, usageRows: 5 }, { name: "Prod", tokens: 123238, usageRows: 3 }, { name: "unattributed", tokens: 7, usageRows: 1 }]);
    expect(note.lines.join(" ")).toContain("before PR #131 (chargeUsage) the runtime left some sessions' usage recorded but not charged. Fixed on 2026-10-31.");
    expect(note.lines).toContain("No new unpaid usage since 2026-10-26.");
    expect(note.differ).toBe("These differ: the rows by building come to 4,392,841 adj. tokens, but Not funded is 195,957 adj. tokens. Not funded is exact (what sessions counted, less what was paid); the split by building is an estimate by the 2-second rule.");
    expect(note.after).toEqual([
      "Written off: not charged to any building. The Bank's balance already reflects the real spend.",
      "Donations straight to those buildings paid 4,269,596 adj. tokens of their undebited usage (a donation is spent without a Bank debit); that part is left out of the rows by building."]);
    const html = page({ spend: live });
    for (const s of ["Town Workshop: 4,269,596 adj. tokens (5 usage rows)", "Prod: 123,238 adj. tokens (3 usage rows)", "unattributed: 7 adj. tokens (1 usage row)", "No new unpaid usage since 2026-10-26.", "These differ", "Written off: not charged to any building", "left out of the rows by building"]) expect(html).toContain(s);
    expect(html.indexOf("Town Workshop: 4,269,596")).toBeLessThan(html.indexOf("Prod: 123,238"));
    // when the split adds up and no donation could have paid: no "differ" line, no allocation line
    const ok = notFundedNote(sp);
    expect(ok.differ).toBeNull();
    expect(ok.after).toEqual(["Written off: not charged to any building. The Bank's balance already reflects the real spend."]);
    expect(ok.lines).toContain("No new unpaid usage since 2026-10-28.");
    expect(page({ spend: sp })).not.toContain("These differ");
    // with the server's reason: a plain line instead of the red one
    const why = notFundedNote({ ...live, notFundedSplitCheck: { sum: 658807, notFunded: 195957, ok: false, reason: "Because." } });
    expect(why.differ).toBeNull();
    expect(why.reason).toBe("The rows by building come to 658,807 adj. tokens and Not funded to 195,957 adj. tokens. Because.");
  });
  it("leaves the section out when the spend can't be loaded", () => {
    expect(page({})).not.toContain("Spending");
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

describe("finance page: dollars at API list price (gr_gmzli3f96j)", () => {
  const usd = { used: 1234.5, left: 1, burnPerDay: 0.4, inflowPerDay: 0.1, pricedAt: "api-list" as const };
  // the Spending rows' dollars: Workshop $18.00, Bank $5.00, less $0.60 and $0.40 = $22.00
  const spUsd: FinanceSpend = { ...sp, usd: { used: 22, sessionsTotal: 23, unattributed: 0, weightMismatch: 0.6, notFunded: 0.4 },
    usdSumCheck: { ok: true, diff: 0, identity: "buildings + unattributed − weight mismatch − not funded = used, in dollars at API list price" },
    rows: sp.rows.map((r, i) => ({ ...r, usd: [18, 5, -0.6, -0.4][i] })) };
  it("formats dollars with separators and a minus sign", () => {
    expect([dollars(1234.5), dollars(-0.4), approxUsd(0.1)]).toEqual(["$1,234.50", "−$0.40", "≈ $0.10"]);
  });
  it("shows ≈ $ next to used, left, burn and coming in on the Overview, with one footnote", () => {
    const ov = tabOf("Overview", { f: { ...f, usd } });
    for (const s of ["Used so far", "≈ $1,234.50", "≈ $1.00", "≈ $0.40", "≈ $0.10", USD_NOTE]) expect(ov).toContain(s);
    expect(ov.split(USD_NOTE).length - 1).toBe(1);
    // a server without dollars: no ≈ $ and no footnote
    const old = tabOf("Overview", {});
    expect(old).not.toMatch(/≈ \$\d/);
    expect(old).not.toContain(USD_NOTE);
  });
  it("shows each building's dollars on Spending with a ✓ line that they add up to the used dollars", () => {
    expect(spendUsdCheckLine(spUsd)).toEqual({ ok: true, text: "The server checked that the rows' dollars add up to the used dollars, $22.00 at API list price." });
    expect(spendUsdCheckLine(sp)).toBeNull();
    const html = tabOf("Spending", { spend: spUsd });
    for (const s of ["$18.00", "$5.00", "−$0.60", "✓ The server checked that the rows&#x27; dollars add up", "(≈ $22.00)", USD_NOTE]) expect(html).toContain(s);
    const bad = spendUsdCheckLine({ ...spUsd, usdSumCheck: { ...spUsd.usdSumCheck!, ok: false, diff: 0.05 } })!;
    expect(bad).toEqual({ ok: false, text: "Dollars do not add up (off by $0.05): the rows come to $22.00, but used is $22.00." });
  });
});

describe("finance page: sources", () => {
  it("names inputs and notes donations counted under their size", () => {
    expect(inputName(src.inputs[0])).toBe("Mitchell's Max plan");
    expect(inputName(src.inputs[1])).toBe("API key from Kelly");
    expect(donationNote(src.donations[0])).toBeNull();
    expect(donationNote(src.donations[1])).toBe("counted at what it spent (size 90)");
  });
  it("checks the subtotals against total received and the Tokens total", () => {
    expect(sourcesCheckLine(src)).toEqual({ ok: true, text: "The server checked that credited 800 + donated 200 equals total received 1,000, the same as the Tokens total." });
    expect(sourcesCheckLine({ ...src, sumCheck: { ...src.sumCheck, ok: false, diff: 4 } }).text).toMatch(/^Does not add up \(off by 4\)/);
    const off = sourcesCheckLine({ ...src, financeTotal: 990, matchesFinance: false });
    expect(off).toEqual({ ok: false, text: "Does not match the Tokens total (off by 10): credited 800 + donated 200 comes to 1,000, but the Tokens total is 990." });
  });
  it("renders each input with its dated credits behind a toggle, each donation, the subtotals and the checked total, above Spending", () => {
    const html = page({ spend: sp, sources: src });
    for (const s of ["Sources", "What the town received and from whom", "Mitchell&#x27;s Max plan", "subscription · daily", '<span class="day">2026-10-20 →</span> <span class="day">2026-10-27</span>', "600",
      "API key from Kelly", "cancelled", "Cancelled 2026-10-25", "permanent", "expires 2026-10-21 00:00", "50 expired undrawn",
      "For the map", "to Town Workshop", "from Ravi", "to Bank Transparency", "counted at what it spent (size 90)", "2026-10-23",
      "Credited through the Bank", "800", "Donated to buildings", "Total received", "✓ The server checked that credited 800 + donated 200 equals total received 1,000", "/api/finance/sources"]) expect(html).toContain(s);
    // the credits sit inside the input's <details>, after its <summary>
    const at = html.indexOf("<details", html.indexOf(">Sources<")), first = html.slice(at, html.indexOf("</details>", at));
    expect(first).toContain("<summary>");
    expect(first.slice(first.indexOf("</summary>"))).toContain("expires 2026-10-21 00:00");
    expect(html.indexOf("Sources")).toBeLessThan(html.indexOf("Spending"));
    expect(page({ sources: { ...src, financeTotal: 990, matchesFinance: false } })).toContain("✗ Does not match the Tokens total (off by 10)");
  });
  it("leaves the section out when the sources can't be loaded", () => {
    expect(page({})).not.toContain("Credited through the Bank");
  });
});

// GET /api/bank's town-wide free tokens: 900 general + 100 earmarked, less 500 funded remaining, 200 asked, 50 reserved
const free = { goalId: "gl_town", generalTokens: 900, earmarkTokens: 100, fundedRemainingTokens: 500, openAsksTokens: 200, reservedTokens: 50, freeTokens: 250 };
describe("finance page: free tokens", () => {
  it("writes the free-tokens sum, leaving out terms that are zero", () => {
    expect(freeBreakdown(free)).toBe("general balance 900 + earmarks at or above 100 − funded grants' remaining 500 − open proposals' asks 200 − reservations 50");
    expect(freeBreakdown({ ...free, earmarkTokens: 0, reservedTokens: 0 })).toBe("general balance 900 − funded grants' remaining 500 − open proposals' asks 200");
  });
  it("shows the town-wide free tokens with each term", () => {
    const html = renderToStaticMarkup(<BankFreeTokens free={free} />);
    expect(claimedTokens(free)).toBe(750);
    for (const s of [">Free tokens<", "general balance", "earmarks at or above", "less funded grants&#x27; remaining", "−500", "less reservations", "<b>250</b>"]) expect(html).toContain(s);
  });
});

// GET /api/finance/fly: a 10-day window, two buildings; the desk Machine at shared-cpu-2x, the town Machine always on
const rate = { preset: "shared-cpu-2x", memoryMb: 2048, usdPerMonth: 13.39, usdPerHour: 0.018597 };
const flyDay = (day: string, deskMs: number, townUsd: number, buildings: FinanceFly["buildings"] = []): FinanceFly["days"][number] =>
  ({ day, deskMs, deskUsd: Math.round(deskMs / 3_600_000 * rate.usdPerHour * 1e6) / 1e6, townUsd, totalUsd: Math.round((deskMs / 3_600_000 * rate.usdPerHour + townUsd) * 1e6) / 1e6, sessions: buildings.reduce((s, b) => s + b.sessions, 0), buildings });
const fly: FinanceFly = {
  windowDays: 10, from: "2026-10-20", to: "2026-10-29",
  rates: { desk: rate, town: rate, extraRamUsdPerGbMonth: 6, region: "iad", source: "https://docs.fly.io/about/pricing", pricedAt: "2026-10-29" },
  desksBackend: "fly", townOnFly: true, townPaidBy: "self", createdAt: null, capUsdPerDay: 10,
  today: { day: "2026-10-29", deskUsd: 1.2, townUsd: 0.11, totalUsd: 1.31, capUsdPerDay: 10, underCap: true },
  days: [
    { ...flyDay("2026-10-29", 0, 0.11), deskUsd: 1.2, totalUsd: 1.31, deskMs: 64.5 * 3_600_000, sessions: 12 },
    ...Array.from({ length: 9 }, (_, i) => flyDay(`2026-10-${28 - i}`, 2 * 3_600_000, 0.446328)),
  ],
  buildings: [{ id: "workshop", name: "Town Workshop", deskMs: 60 * 3_600_000, deskUsd: 1.11582, sessions: 20 }, { id: "bl_b", name: "Bank Transparency", deskMs: 22.5 * 3_600_000, deskUsd: 0.418432, sessions: 5 }],
  totals: { deskMs: 82.5 * 3_600_000, deskHours: 82.5, deskUsd: 1.534252, townUsd: 4.126952, totalUsd: 5.661204, sessions: 25, unmeasuredSessions: 3 },
  notCounted: ["Volume storage: $0.15 per GB-month for each desk volume"],
  assumptions: ["Every desk session is priced at the desk Machine size the town runs today"],
  sumCheck: { ok: true, diff: 0, identity: "per day desk + town = total; Σ days desk time = Σ buildings desk time", daysOk: true, buildingsOk: true },
  at: "2026-10-29T12:00:00.000Z",
};

describe("finance page: hosting (Fly.io)", () => {
  it("sums the newest days of the window", () => {
    const week = flyWindowTotals(fly, 7);
    expect(week.days).toBe(7);
    expect(week.townUsd).toBeCloseTo(0.11 + 6 * 0.446328, 6);
    expect(week.deskUsd).toBeCloseTo(1.2 + 6 * 2 * rate.usdPerHour, 5);
    expect(flyWindowTotals(fly, 99).days).toBe(10);
  });
  it("says the Fly figures add up, and what misses when they don't", () => {
    expect(flyCheckLine(fly)).toEqual({ ok: true, text: "The server checked that each day's desks + town Machine equals that day's total, and that the buildings' desk time adds up to the days' (83 h)." });
    expect(flyCheckLine({ ...fly, sumCheck: { ...fly.sumCheck, ok: false, buildingsOk: false, diff: 1_800_000 } }).text).toBe("Does not add up: the buildings' desk time misses the days' by 30 min");
    expect(flyCheckLine({ ...fly, sumCheck: { ...fly.sumCheck, ok: false, daysOk: false, diff: 0.000002 } }).text).toContain("misses its total by $0.000002");
  });
  it("renders today, the week, the window, the rates, the cap, each building and the ✓ line, in dollars", () => {
    const html = page({ fly });
    for (const s of ["Hosting (Fly.io)", "in US dollars", "not Fly&#x27;s bill", "Today (so far)", "$1.20", "$0.11", "$1.31", "Last 7 days", "Last 10 days (2026-10-20 → 2026-10-29)", "Daily desk cap", "$10.00 per day · today under the cap",
      "shared-cpu-2x, 2 GB: $0.0186/h ($13.39 per 30 days)", "Desk time, last 10 days", "83 h over 25 sessions", "3 timed from start and end", "Town Workshop", "60 h · 20 sessions", "$1.12", "Bank Transparency", "$0.42", "Desks, last 10 days", "$1.53",
      "Not counted: Volume storage", "How this is estimated", "✓ The server checked that each day", "(Hosting in US dollars)", "/api/finance/fly", "Hosting (Fly.io), in its own tab, is in US dollars"]) expect(html).toContain(s);
  });
  it("says so when nothing is on Fly or no cap is set", () => {
    const html = page({ fly: { ...fly, rates: { ...fly.rates, desk: null, town: null }, desksBackend: "docker", townOnFly: false, today: { ...fly.today, capUsdPerDay: null, underCap: null } } });
    for (const s of ["desks are not on Fly (docker)", "the server is not on a Fly Machine: $0", "none set"]) expect(html).toContain(s);
  });
  it("a self-hosted town shows its own Town Machine", () => {
    const html = page({ fly });
    for (const s of ["Town Machine</th>", "Town Machine size", "the town Machine runs all day"]) expect(html).toContain(s);
    expect(html).not.toContain(HOSTED_FLY_NOTE);
  });
  it("a hosted collective: no Town Machine column or size, the muster.town line, the window from its creation", () => {
    const zero = (d: FinanceFly["days"][number]) => ({ ...d, townUsd: 0, totalUsd: d.deskUsd });
    const days = fly.days.slice(0, 3).map(zero);
    const hosted: FinanceFly = {
      ...fly, townOnFly: false, townPaidBy: "host", createdAt: "2026-10-27T15:04:00.000Z", windowDays: 3, from: "2026-10-27", to: "2026-10-29",
      rates: { ...fly.rates, town: null }, today: { ...fly.today, townUsd: 0, totalUsd: fly.today.deskUsd }, days,
      totals: { ...fly.totals, townUsd: 0, totalUsd: fly.totals.deskUsd },
    };
    const html = page({ fly: hosted });
    for (const s of [HOSTED_FLY_NOTE, "Since it was created (2026-10-27 → 2026-10-29)", "Desks</th><th>Total</th>", "✓ The server checked that each day&#x27;s desks equal that day&#x27;s total"]) expect(html).toContain(s);
    for (const s of ["Town Machine</th>", "Town Machine size", "the town Machine runs all day", "$0.11"]) expect(html).not.toContain(s);
    expect(flyWindowLabel(hosted)).toBe("Since it was created (2026-10-27 → 2026-10-29)");
    // a hosted collective older than the window: the usual label
    expect(flyWindowLabel({ ...hosted, createdAt: "2026-09-01T00:00:00.000Z" })).toBe("Last 3 days (2026-10-27 → 2026-10-29)");
  });
  it("leaves the section out when the endpoint can't be loaded", () => {
    expect(page({})).not.toContain("Hosting (Fly.io)");
  });
});
