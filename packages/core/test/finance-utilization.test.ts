import { describe, expect, it } from "vitest";
import { financeDaily, financeUtilization, utilizationAgainstDaily } from "../src/index.ts";

const NOW = new Date("2026-11-20T01:40:00.000Z");
const credit = (id: string, day: string, tokens: number, expires: string | null) =>
  ({ id, tokens, createdAt: `${day}T02:44:00.000Z`, expiresAt: expires });

describe("financeUtilization (GET /api/finance utilization, gr_z13gmx54su)", () => {
  const credits = [
    credit("old", "2026-10-01", 9000, "2026-10-02T02:44:00.000Z"), // outside both windows
    credit("a", "2026-11-10", 1000, "2026-11-11T02:44:00.000Z"), // 30 d only
    credit("b", "2026-11-17", 1000, "2026-11-18T02:44:00.000Z"), // drawn 300, expired 700
    credit("c", "2026-11-18", 1000, "2026-11-19T02:44:00.000Z"), // drawn 1200: used 1000, 200 past its size
    credit("d", "2026-11-19", 1000, "2026-11-20T02:44:00.000Z"), // still live: drawn 100, left 900
    credit("k", "2026-11-19", 500, null), // durable
  ];
  const debits = [
    { creditId: "a", tokens: 1000 }, { creditId: "b", tokens: 300 }, { creditId: "c", tokens: 1200 },
    { creditId: "d", tokens: 100 }, { creditId: null, tokens: 40 },
  ];
  const u = financeUtilization({ credits, debits }, NOW);

  it("splits the 7-day credit into used, expired and left that add up per credit", () => {
    expect(u.d7).toMatchObject({
      days: 7, from: "2026-11-14", to: "2026-11-20", credits: 3, credited: 3000, used: 1400, expired: 700, left: 900,
      usedShare: 0.4667, expiredShare: 0.2333, drawnPastSize: 200, durable: 500,
    });
    expect(u.d30).toMatchObject({ days: 30, from: "2026-10-22", credits: 4, credited: 4000, used: 2400, expired: 700, left: 900 });
    expect(u.check).toMatchObject({ ok: true, diff: 0 });
  });

  it("matches the daily rows' credited over the same days", () => {
    const { daily } = financeDaily({ debits: [], credits, usedBank: 0, usedDonations: 0 }, NOW);
    expect(utilizationAgainstDaily(u, daily.rows).check).toMatchObject({ ok: true, dailyDiff: 0 });
    const short = daily.rows.map((r) => (r.day === "2026-11-19" ? { ...r, credited: r.credited - 1 } : r));
    expect(utilizationAgainstDaily(u, short).check).toMatchObject({ ok: false, dailyDiff: 2 });
  });

  it("is all zeros with an ok check when nothing was credited", () => {
    const e = financeUtilization({ credits: [], debits: [] }, NOW);
    expect(e.d7).toMatchObject({ credited: 0, used: 0, usedShare: 0 });
    expect(e.check.ok).toBe(true);
  });
});
