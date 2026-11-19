// gr_epbcgb0hvs step 1 (kr_86jpcp8x0w, kr_l0zj80iz8z): the Balance tab's "Day by day" chart over GET /api/finance `daily`
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Finance, FinanceDaily, FinanceSplit, SplitWindow } from "../src/api";
import { DailyChart, axisLabel, dailyCheckLine, dailyStacks, daySegments, niceMax, splitCheckLine, splitSegments, splitSentence } from "../src/panels/BankDaily";

const ids = ["a", "b", "c", "d", "e", "f"];
const daily: FinanceDaily = {
  days: 2, from: "2026-11-16", to: "2026-11-17", usedBefore: 0, undatedUsed: 0, usageLedgerInWindow: 210,
  rows: [
    { day: "2026-11-16", used: 150, credited: 1000, byBuilding: { a: 60, b: 40, c: 20, d: 10, e: 15, f: 5 } },
    { day: "2026-11-17", used: 60, credited: 0, byBuilding: { a: 30, b: 30 } },
  ],
  buildings: ids.map((id, i) => ({ id, name: `B ${id}`, tokens: [90, 70, 20, 10, 15, 5][i]! })).sort((x, y) => y.tokens - x.tokens),
};
const check = { ok: true, diff: 0, rowsUsed: 210, usedSinceStart: 210, buildingDiff: 0, identity: "Σ daily used = Bank used since the window start; each day's buildings sum to its used" };

describe("Day by day chart", () => {
  it("stacks the 4 largest buildings and groups the rest as Other, and each day's segments sum to its used", () => {
    const stacks = dailyStacks(daily);
    expect(stacks.map((s) => s.name)).toEqual(["B a", "B b", "B c", "B e", "Other (2 buildings)"]);
    const segs = daySegments(daily.rows[0]!, stacks);
    expect(segs.find((s) => s.key === "other")!.tokens).toBe(15);
    expect(segs.reduce((s, x) => s + x.tokens, 0)).toBe(150);
  });

  it("has no Other with 4 buildings or fewer", () => {
    expect(dailyStacks({ ...daily, buildings: daily.buildings.slice(0, 3) }).map((s) => s.key)).toEqual(["a", "b", "c"]);
  });

  it("says ✓ when the rows add up, and by how much they are off when not", () => {
    expect(dailyCheckLine({ daily, dailyCheck: check })).toEqual({ ok: true, text: "Σ daily used 210 = Bank used since 2026-11-16 210; each day's buildings add up to its used" });
    expect(dailyCheckLine({ daily, dailyCheck: { ...check, ok: false, diff: -4, rowsUsed: 206 } })!.text).toContain("off by -4");
    expect(dailyCheckLine({})).toBeNull();
  });

  it("rounds the axis top and labels ticks without hiding halves", () => {
    expect(niceMax(21_428_571)).toBe(25_000_000);
    expect(niceMax(0)).toBe(1);
    expect(axisLabel(12_500_000)).toBe("12.5M");
    expect(axisLabel(500)).toBe("500");
  });

  it("renders the legend, a hover target per day, the ✓ line and a table", () => {
    const html = renderToStaticMarkup(<DailyChart f={{ daily, dailyCheck: check } as Finance} />);
    expect(html).toContain("Credited");
    expect(html).toContain("Other (2 buildings)");
    expect(html.match(/tabindex="0"/g)).toHaveLength(2);
    expect(html).toContain("2026-11-16: used 150, credited 1,000");
    expect(html).toContain("✓ Σ daily used 210");
    expect(html).toContain("The numbers as a table");
  });
});

// gr_3ougmyubdm step 2 (kr_6fwxvjormh, kr_sw61dw3a04): work vs coordination on the chart and its sentences
describe("Work versus coordination", () => {
  const lanes = { grant: 50, exploration: 10, directed: 10, retainer: 10, manager: 15, other: 5 };
  const laned: FinanceDaily = { ...daily, rows: [{ ...daily.rows[0]!, byLane: lanes, sessionsTokens: 100 }, { ...daily.rows[1]!, byLane: { grant: 0, exploration: 0, directed: 0, retainer: 0, manager: 0, other: 0 }, sessionsTokens: 0 }] };
  const part = (tokens: number, total: number) => ({ tokens, usd: 0, sessions: 1, share: tokens / total });
  const win = (days: number, w: number, c: number, o: number): SplitWindow => {
    const t = w + c + o;
    return { days, from: "2026-11-16", to: "2026-11-17", total: { tokens: t, usd: 0, sessions: 3 }, work: part(w, t), coordination: part(c, t), other: part(o, t),
      byLane: { grant: part(w, t), exploration: part(0, t), directed: part(0, t), retainer: part(0, t), manager: part(c, t), other: part(o, t) } };
  };
  const split: FinanceSplit = { d7: win(7, 600, 350, 50), d30: win(30, 6000, 4000, 0), groups: { work: ["grant", "exploration", "directed", "retainer"], coordination: ["manager"], other: ["other"] },
    check: { ok: true, diff: 0, dailyDiff: 0, identity: "x" } };

  it("splits a day's used by its lane shares, the parts summing to used", () => {
    const segs = splitSegments(laned.rows[0]!);
    expect(segs).toEqual([{ key: "work", tokens: 120 }, { key: "coordination", tokens: 23 }, { key: "other", tokens: 7 }]);
    expect(segs.reduce((s, x) => s + x.tokens, 0)).toBe(150);
    expect(splitSegments(laned.rows[1]!)).toEqual([{ key: "work", tokens: 0 }, { key: "coordination", tokens: 0 }, { key: "other", tokens: 60 }]);
  });

  it("says the 7 and 30 day sentences and their ✓ line", () => {
    expect(splitSentence(split.d7)).toBe("Last 7 days: 1,000 adj. tokens; 60% bought work (grants, requests, exploration, retainers), 35% went to managers and the Secretary coordinating; 5% other (reviews, meetings, summaries).");
    expect(splitSentence(split.d30)).toBe("Last 30 days: 10,000 adj. tokens; 60% bought work (grants, requests, exploration, retainers), 40% went to managers and the Secretary coordinating.");
    expect(splitCheckLine({ split })).toEqual({ ok: true, text: "7 days: 600 + 350 + 50 = 1,000; 30 days: 6,000 + 4,000 + 0 = 10,000. Work + coordination + other = the sessions' total, which equals the chart's daily session spend" });
    expect(splitCheckLine({ split: { ...split, check: { ...split.check, ok: false, diff: 4 } } })!.text).toContain("off by 4");
    expect(splitCheckLine({})).toBeNull();
  });

  it("renders two-tone bars with a work/coordination legend and the sentences by default", () => {
    const html = renderToStaticMarkup(<DailyChart f={{ daily: laned, dailyCheck: check, split } as Finance} />);
    expect(html).toContain("Work (grants, requests, exploration, retainers)");
    expect(html).toContain("Coordination (manager and Secretary wakes)");
    expect(html).toContain("Split by:");
    expect(html).toContain("Last 7 days: 1,000 adj. tokens");
    expect(html).toContain("✓ 7 days: 600 + 350 + 50");
    expect(html).not.toContain("Other (2 buildings)");
    expect(html).toContain('fill="#d95926"');
  });

  it("keeps the building view with no toggle when the server sends no byLane", () => {
    const html = renderToStaticMarkup(<DailyChart f={{ daily, dailyCheck: check } as Finance} />);
    expect(html).not.toContain("Split by:");
    expect(html).toContain("Other (2 buildings)");
  });
});
