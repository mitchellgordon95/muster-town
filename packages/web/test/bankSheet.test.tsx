// gr_567tikzitl step 1 (kr_9xozv5d8gh): the Bank as a centered sheet: tabs on the left, the tab's tables in the centre,
// every explanation in the right sidebar
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BANK_TABS } from "@muster-town/schema";
import type { Finance, FinanceSpend } from "../src/api";
import { BankSheetView, bankSheetTab } from "../src/panels/BankSheet";

const f: Finance = {
  total: 1000, credited: 800, donated: 200, used: 1100, usedBank: 950, usedDonations: 150, expired: 50, left: 50, leftBank: 0, leftDonations: 50,
  overdrawn: 200, overdrawnBreakdown: { durableOvershoot: 120, subscriptionOverdrawn: 70, deletedCreditDebits: 0, allocationOverspent: 10 }, usageLedger: 1200,
  projection: { days: 30, trailingDailyBurn: 20, burnDays: 7, projectedUse30d: 600, dailyInflow: 5, netDailyBurn: 15, projectedInflow30d: 150, runwayDays: 3, runway: "days" },
  sumCheck: { ok: true, diff: 0, identity: "used + expired + left = total + overdrawn" }, at: "2026-10-27T19:00:00.000Z",
  usd: { used: 22, left: 1, burnPerDay: 0.4, inflowPerDay: 0.1, pricedAt: "api-list" },
};
const sp: FinanceSpend = {
  used: 1100, sessionsTotal: 1150, unattributed: 0, weightMismatch: 30, convertedAt: "2026-10-27T00:00:24.000Z", notFunded: 20, at: "2026-10-28T16:31:50.056Z",
  notFundedSplit: [{ buildingId: "workshop", buildingName: "Town Workshop", usageRows: 2, tokens: 20 }], notFundedLastAt: "2026-10-28T10:00:00.000Z",
  notFundedAllocationPaid: 0, notFundedSplitCheck: { sum: 20, notFunded: 20, ok: true },
  weightMismatchNote: "Sessions that ended before the Bank switched to adjusted tokens are priced here at their own model's rate. The difference is pricing, not spend.",
  rows: [
    { kind: "building", id: "workshop", name: "Town Workshop", tokens: 1150, share: 1.0455, sessions: 9 },
    { kind: "weight-mismatch", id: null, name: "Priced differently before the switch to adjusted tokens (nothing went unpaid)", tokens: -30, share: -0.0273, sessions: 12 },
    { kind: "not-funded", id: null, name: "Not funded: work sessions the Bank never charged", tokens: -20, share: -0.0182, sessions: 0 },
  ],
  check: { ok: true, diff: 0, identity: "buildings + unattributed − weight mismatch − not funded = used" },
};
const noop = () => undefined;
const sheet = (tab: string) => renderToStaticMarkup(
  <BankSheetView tab={tab} onTab={noop} onClose={noop} sideW={null} onSideW={noop}
    view={{ bank: null, fin: { f, spend: sp, sources: null, fly: null }, rev: 0, onChange: noop, onReload: noop }} />,
);
/** the centre column's markup and the sidebar's */
const columns = (html: string) => {
  const main = html.indexOf('class="bank-main"'), side = html.indexOf('<aside class="bank-side"');
  expect(main).toBeGreaterThan(0);
  expect(side).toBeGreaterThan(main);
  return { centre: html.slice(main, side), sidebar: html.slice(side) };
};
/** explanatory blocks: a muted paragraph or div, or a foot-note */
const prose = (html: string) => html.match(/<(p|div) class="(muted[^"]*|foot-note[^"]*)"/g) ?? [];

describe("the Bank sheet", () => {
  it("lists every tab on the left, the asked one selected", () => {
    const html = sheet("Spending");
    expect(html).toContain('role="tablist"');
    for (const t of BANK_TABS) expect(html).toContain(`>${t.replace("&", "&amp;")}</button>`);
    expect(html).toContain('aria-selected="true" class="bank-tab on">Spending</button>');
    expect([bankSheetTab("Hosting"), bankSheetTab("nope"), bankSheetTab()]).toEqual(["Hosting", BANK_TABS[0], BANK_TABS[0]]);
  });
  it("opens on Donate: the form (signed out: the sign-in line) at the top of the centre, what funds the town under it, the explanations in the sidebar (gr_567tikzitl step 2, kr_00lym2zmif)", () => {
    expect(BANK_TABS[0]).toBe("Donate");
    expect(bankSheetTab()).toBe("Donate");
    const html = sheet(bankSheetTab());
    expect(html).toContain('aria-selected="true" class="bank-tab on">Donate</button>');
    const { centre, sidebar } = columns(html);
    expect(centre.indexOf("Sign in to donate")).toBeGreaterThan(0);
    expect(centre.indexOf("Sign in to donate")).toBeLessThan(centre.indexOf("Funding the town now"));
    expect(sidebar).toContain("Donate to the Bank to fund every building");
    expect(prose(centre)).toEqual([]);
  });
  it("puts the Balance tab's unit line and notes in the sidebar, none in the centre", () => {
    const { centre, sidebar } = columns(sheet("Balance"));
    expect(sidebar).toContain("the unit the town pays for AI model work in");
    expect(sidebar).toContain("About this tab");
    expect(sidebar).toContain("Terms used on this page");
    expect(sidebar).toContain("one-off donations and one-time inputs are not counted");
    expect(centre).toContain("Next 30 days");
    expect(centre).not.toContain("the unit the town pays for AI model work in");
    expect(prose(centre)).toEqual([]);
  });
  it("puts Spending's reading guide and the synthetic rows' notes in the sidebar, the tree in the centre", () => {
    const { centre, sidebar } = columns(sheet("Spending"));
    expect(centre).toContain("Town Workshop");
    expect(centre).toContain("Not funded: work sessions the Bank never charged");
    for (const s of ["Open a row for its parts", "The difference is pricing, not spend", "Usage the Bank never debited"]) {
      expect(sidebar).toContain(s);
      expect(centre).not.toContain(s);
    }
    expect(prose(centre)).toEqual([]);
  });
  it("leaves no muted paragraph in the centre on any tab", () => {
    for (const t of BANK_TABS) expect(prose(columns(sheet(t)).centre)).toEqual([]);
  });
});
