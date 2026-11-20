import { describe, expect, it } from "vitest";
import { financeDaily } from "../src/index.ts";

const NOW = new Date("2026-11-17T03:40:00.000Z");
const d = (day: string, buildingId: string, tokens: number) => ({ buildingId, tokens, createdAt: `${day}T10:00:00.000Z` });

describe("financeDaily (GET /api/finance daily, gr_epbcgb0hvs)", () => {
  it("is one zero row for today with an ok check on an empty ledger", () => {
    const { daily, dailyCheck } = financeDaily({ debits: [], credits: [], usedBank: 0, usedDonations: 0 }, NOW);
    expect(daily).toMatchObject({ days: 1, from: "2026-11-17", to: "2026-11-17", rows: [{ day: "2026-11-17", used: 0, credited: 0, byBuilding: {} }], buildings: [] });
    expect(dailyCheck).toMatchObject({ ok: true, diff: 0 });
  });

  it("starts at the ledger's first day when it is younger than 30 days, with a row for every day", () => {
    const debits = [d("2026-11-14", "b1", 100), d("2026-11-14", "b2", 50), d("2026-11-16", "b1", 30), d("2026-11-17", "b2", 5)];
    const credits = [{ tokens: 1000, createdAt: "2026-11-14T00:00:01.000Z" }, { tokens: 1000, createdAt: "2026-11-16T00:00:01.000Z" }];
    const { daily, dailyCheck } = financeDaily({ debits, credits, usedBank: 185, usedDonations: 0, buildingNames: new Map([["b1", "Bank"]]) }, NOW);
    expect(daily.rows.map((r) => [r.day, r.used, r.credited])).toEqual([
      ["2026-11-14", 150, 1000], ["2026-11-15", 0, 0], ["2026-11-16", 30, 1000], ["2026-11-17", 5, 0],
    ]);
    expect(daily.rows[0]!.byBuilding).toEqual({ b1: 100, b2: 50 });
    expect(daily.buildings).toEqual([{ id: "b1", name: "Bank", tokens: 130 }, { id: "b2", name: "b2", tokens: 55 }]);
    expect(dailyCheck).toMatchObject({ ok: true, diff: 0, rowsUsed: 185, usedSinceStart: 185, buildingDiff: 0 });
  });

  it("keeps the last 30 days and counts older debits as usedBefore", () => {
    const debits = [d("2026-10-01", "b1", 400), d("2026-10-19", "b1", 7), d("2026-10-18", "b1", 3)];
    const { daily, dailyCheck } = financeDaily({ debits, credits: [], usedBank: 410, usedDonations: 25 }, NOW);
    expect(daily).toMatchObject({ days: 30, from: "2026-10-19", to: "2026-11-17", usedBefore: 403, undatedUsed: 25 });
    expect(daily.rows[0]).toMatchObject({ day: "2026-10-19", used: 7 });
    expect(dailyCheck).toMatchObject({ ok: true, rowsUsed: 7, usedSinceStart: 7 });
  });

  it("fails the check when the rows miss Bank use (a debit dated after today, or a usedBank the debits don't make)", () => {
    const future = financeDaily({ debits: [d("2026-11-17", "b1", 10), d("2026-11-18", "b1", 4)], credits: [], usedBank: 14, usedDonations: 0 }, NOW);
    expect(future.dailyCheck).toMatchObject({ ok: false, diff: -4 });
    const off = financeDaily({ debits: [d("2026-11-17", "b1", 10)], credits: [], usedBank: 11, usedDonations: 0 }, NOW);
    expect(off.dailyCheck).toMatchObject({ ok: false, diff: -1 });
  });

  it("reports the usage ledger over the window next to the rows", () => {
    const usage = [{ tokens: 12, createdAt: "2026-11-17T01:00:00.000Z" }, { tokens: 99, createdAt: "2026-09-01T01:00:00.000Z" }];
    const { daily } = financeDaily({ debits: [d("2026-11-17", "b1", 10)], credits: [], usage, usedBank: 10, usedDonations: 0 }, NOW);
    expect(daily.usageLedgerInWindow).toBe(12);
  });

  it("dates each expired subscription credit by its expiresAt day and closes on the Bank's expired (gr_z13gmx54su)", () => {
    const credits = [
      { id: "c0", tokens: 500, createdAt: "2026-10-01T03:00:00.000Z", expiresAt: "2026-10-02T03:00:00.000Z" }, // before the window
      { id: "c1", tokens: 1000, createdAt: "2026-11-15T03:00:00.000Z", expiresAt: "2026-11-16T03:00:00.000Z" },
      { id: "c2", tokens: 1000, createdAt: "2026-11-16T03:00:00.000Z", expiresAt: "2026-11-17T03:00:00.000Z" }, // overdrawn: floor 0
      { id: "c3", tokens: 1000, createdAt: "2026-11-17T03:00:00.000Z", expiresAt: "2026-11-18T03:00:00.000Z" }, // not yet expired
      { id: "k", tokens: 300, createdAt: "2026-11-16T03:00:00.000Z", expiresAt: null }, // durable: never expires
    ];
    const debits = [
      { buildingId: "b1", tokens: 100, createdAt: "2026-10-01T10:00:00.000Z", creditId: "c0" },
      { buildingId: "b1", tokens: 250, createdAt: "2026-11-15T10:00:00.000Z", creditId: "c1" },
      { buildingId: "b1", tokens: 1200, createdAt: "2026-11-16T10:00:00.000Z", creditId: "c2" },
    ];
    const { daily, dailyCheck } = financeDaily({ debits, credits, usedBank: 1550, usedDonations: 0, expired: 400 + 750 }, NOW);
    expect(daily.expiredBefore).toBe(400);
    expect(daily.rows.filter((r) => r.expired).map((r) => [r.day, r.expired])).toEqual([["2026-11-16", 750]]);
    expect(dailyCheck).toMatchObject({ ok: true, expiredDiff: 0, rowsExpired: 750 });
    const off = financeDaily({ debits, credits, usedBank: 1550, usedDonations: 0, expired: 1000 }, NOW);
    expect(off.dailyCheck).toMatchObject({ ok: false, expiredDiff: 150 });
  });
});
