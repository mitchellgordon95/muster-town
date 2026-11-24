// gr_upr4fteq0t step 1 (kr_suasm72aw5, kr_qb03kauhh7): the Balance tab's four glance tiles and the folded sum checks
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Finance, FinanceSplit, FinanceUtilization, SplitWindow, UtilizationWindow } from "../src/api";
import { glanceTiles } from "../src/panels/BankFinance";
import { BankView } from "../src/panels/BankPanel";
import { CheckFold } from "../src/panels/ui";

const uwin = (days: number, credited: number, used: number): UtilizationWindow => ({ days, from: "2026-11-17", to: "2026-11-24", credits: 1, credited, used, expired: credited - used, left: 0, usedShare: used / credited, expiredShare: 1 - used / credited, drawnPastSize: 0, durable: 0 });
const utilization: FinanceUtilization = { d7: uwin(7, 130_000_000, 87_391_606), d30: uwin(30, 400_000_000, 200_000_000), check: { ok: true, diff: 0, dailyDiff: 0, identity: "x" } };
const part = (tokens: number, total: number) => ({ tokens, usd: 0, sessions: 1, share: tokens / total });
const swin = (days: number, w: number, c: number): SplitWindow => ({ days, from: "2026-11-17", to: "2026-11-24", total: { tokens: w + c, usd: 0, sessions: 2 }, work: part(w, w + c), coordination: part(c, w + c), other: part(0, w + c), byLane: {} as SplitWindow["byLane"] });
const split = { d7: swin(7, 620, 380), d30: swin(30, 6000, 4000), groups: { work: [], coordination: [], other: [] }, check: { ok: true, diff: 0, dailyDiff: 0, identity: "x" } } as unknown as FinanceSplit;
const cash = { windowDays: 30, from: "2026-10-25T00:00:00.000Z", to: "2026-11-24T00:00:00.000Z", plans: 200, apiKeys: 5.31, hosting: 37.5, total: 242.81, listUsd: 2428.1, perDollar: 10, planRows: [], apiKeySessions: 0, pricedAt: "cash" } as unknown as NonNullable<Finance["cash"]>;
const f = {
  left: 21_812_345, used: 100, total: 200, usd: { used: 2, left: 436.25, burnPerDay: 79, inflowPerDay: 428, pricedAt: "api-list" },
  utilization, split, cash, cashCheck: { ok: true, diff: 0, text: "" },
  projection: { days: 30, trailingDailyBurn: 20, burnDays: 7, projectedUse30d: 600, dailyInflow: 5, netDailyBurn: 15, projectedInflow30d: 150, runwayDays: 3, runway: "days" },
  sumCheck: { ok: true, diff: 0, identity: "" }, at: "2026-11-24T21:00:00.000Z",
} as unknown as Finance;

describe("Balance glance tiles", () => {
  it("shows Left now, Used last 7 days, Work vs coordination and Cash paid last 30 days from /api/finance", () => {
    const t = glanceTiles(f);
    expect(t.map((x) => [x.label, x.value])).toEqual([
      ["Left now", "21,812,345"],
      ["Used last 7 days", "87,391,606"],
      ["Work vs coordination", "62% work"],
      ["Cash paid last 30 days", "$242.81"],
    ]);
    expect(t[0]!.sub).toBe("adj. tokens ≈ $436.25");
    expect(t[1]!.sub).toBe("adj. tokens, 67.2% of what came in");
    expect(t[2]!.sub).toBe("38% coordination, last 7 days");
    expect(t[3]!.sub).toBe("plans, API keys and hosting");
  });
  it("leaves out a tile whose figure an older server does not send", () => {
    const t = glanceTiles({ ...f, utilization: undefined, split: undefined, cash: undefined, usd: undefined });
    expect(t.map((x) => x.key)).toEqual(["left"]);
    expect(t[0]!.sub).toBe("adj. tokens");
  });
  it("each tile is a button that points at a section on the tab", () => {
    const html = renderToStaticMarkup(<BankView tab="Balance" bank={null} fin={{ f, spend: null, sources: null, fly: null }} rev={0} onChange={() => undefined} onReload={() => undefined} />);
    expect(html.match(/class="bank-glance-tile/g)).toHaveLength(4);
    expect(html.indexOf("bank-glance")).toBeLessThan(html.indexOf("Next 30 days"));
    // Left and Cash scroll to the Next 30 days section and the cash row; Used and Work to the chart's sentences (bankDaily.test.tsx)
    for (const id of ["bank-glance-left", "bank-glance-cash"]) expect(html).toContain(`id="${id}"`);
    expect(glanceTiles(f).map((x) => x.target)).toEqual(["bank-glance-left", "bank-glance-used", "bank-glance-split", "bank-glance-cash"]);
    // the cash check is folded: one summary line, the sum inside
    expect(html).toContain("✓ 1 check passes</summary>");
    expect(html).toContain("✓ The server checked that plans + API keys + hosting = $242.81.");
  });
});

describe("folded sum checks", () => {
  it("says ✓ N checks pass, closed, when all pass", () => {
    const html = renderToStaticMarkup(<CheckFold checks={[{ ok: true }, null, { ok: true }, false]}><div>sums</div></CheckFold>);
    expect(html).toContain("✓ 2 checks pass</summary>");
    expect(html).not.toContain('open=""');
    expect(html).toContain("<div>sums</div>");
  });
  it("says ✗ M of N checks fail and starts open when one fails", () => {
    const html = renderToStaticMarkup(<CheckFold checks={[{ ok: true }, { ok: false }, { ok: true }]}><div>sums</div></CheckFold>);
    expect(html).toContain("✗ 1 of 3 checks fails</summary>");
    expect(html).toContain('open=""');
  });
  it("renders nothing with no checks", () => {
    expect(renderToStaticMarkup(<CheckFold checks={[null, undefined]}><div>sums</div></CheckFold>)).toBe("");
  });
});
