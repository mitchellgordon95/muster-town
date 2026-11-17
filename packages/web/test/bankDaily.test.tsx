// gr_epbcgb0hvs step 1 (kr_86jpcp8x0w, kr_l0zj80iz8z): the Balance tab's "Day by day" chart over GET /api/finance `daily`
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Finance, FinanceDaily } from "../src/api";
import { DailyChart, axisLabel, dailyCheckLine, dailyStacks, daySegments, niceMax } from "../src/panels/BankDaily";

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
