import { describe, expect, it } from "vitest";
import { cashCheck, financeCash, sessionListUsd, type CashInputs } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

// gr_qggxximtru step 2 (kr_ruh7apqptm): what the last 30 days cost in cash. "now" is 12:00Z on 11-04; the window starts 10-05 12:00Z.
const NOW = new Date("2026-11-04T12:00:00.000Z");
const sess = (startedAt: string, output: number, credentialInputId: string | null = null) =>
  ({ model: "claude-opus-5-5", bankModel: "claude-opus-5-5", byModel: null, output, startedAt, credentialInputId });
const day = (d: string, totalUsd: number) => ({ day: d, deskMs: 0, deskUsd: 0, townUsd: totalUsd, totalUsd, sessions: 0, buildings: [] });

const base: CashInputs = { fees: [], sessions: [], inputs: [{ id: "in_key", source: "api-key" }, { id: "in_sub", source: "subscription" }], fly: { days: [] } };

describe("financeCash (Paid in cash, last 30 days)", () => {
  it("is all zero with no plan, no API-key session and no hosting; perDollar is null", () => {
    const c = financeCash({ ...base, sessions: [sess("2026-11-01T00:00:00Z", 1_000_000)] }, NOW);
    expect(c).toMatchObject({ windowDays: 30, from: "2026-10-05T12:00:00.000Z", to: NOW.toISOString(), plans: 0, apiKeys: 0, hosting: 0, total: 0, listUsd: 20, perDollar: null });
    expect(cashCheck(c).ok).toBe(true);
  });

  it("prorates each plan by the part of the window it was active, across from/to edges", () => {
    const c = financeCash({ ...base, fees: [
      { id: "f_all", label: "Max 20x", usdPerMonth: 200, fromDate: "2026-09-01", toDate: null }, // all 30 days: $200
      { id: "f_late", label: "Pro", usdPerMonth: 30, fromDate: "2026-11-02", toDate: null }, // 11-02 00:00 → now: 2.5 days = $2.50
      { id: "f_early", label: "Old", usdPerMonth: 60, fromDate: "2026-09-01", toDate: "2026-10-05" }, // to the end of 10-05: 0.5 day = $1
      { id: "f_gone", label: "Gone", usdPerMonth: 60, fromDate: "2026-09-01", toDate: "2026-10-04" }, // ended before the window
      { id: "f_future", label: "Next", usdPerMonth: 60, fromDate: "2026-11-05", toDate: null }, // not started
    ] }, NOW);
    expect(c.plans).toBe(203.5);
    expect(c.planRows.map((r) => [r.id, r.activeDays, r.usd])).toEqual([["f_all", 30, 200], ["f_late", 2.5, 2.5], ["f_early", 0.5, 1]]);
  });

  it("counts only API-key sessions started in the window as API-key cash; listUsd counts every session in the window", () => {
    const c = financeCash({ ...base, sessions: [
      sess("2026-11-03T00:00:00Z", 1_000_000, "in_key"), // $20 API key
      sess("2026-11-03T00:00:00Z", 2_000_000, "in_sub"), // $40 subscription: list value only
      sess("2026-11-03T00:00:00Z", 500_000, null), // $10 no credential recorded
      sess("2026-10-01T00:00:00Z", 1_000_000, "in_key"), // before the window
      sess("2026-11-03T00:00:00Z", 1_000_000, "in_deleted"), // an input no longer there: not counted as a key
    ] }, NOW);
    expect(c).toMatchObject({ apiKeys: 20, apiKeySessions: 1, listUsd: 90, total: 20, perDollar: 4.5 });
    expect(sessionListUsd(sess("x", 1_000_000))).toBe(20);
  });

  it("takes hosting from the Fly days, the first day by its share inside the window", () => {
    const days = [day("2026-11-04", 0.5), ...Array.from({ length: 29 }, (_, i) => day(new Date(Date.UTC(2026, 10, 3 - i)).toISOString().slice(0, 10), 1)), day("2026-10-05", 1), day("2026-10-04", 9)];
    const c = financeCash({ ...base, fly: { days } }, NOW);
    expect(c.hosting).toBe(30); // 0.5 (today so far) + 29 full days + half of 10-05; 10-04 is outside
    const ck = cashCheck({ ...c, total: c.total + 0.05 });
    expect(ck).toMatchObject({ ok: false, diff: -0.05 });
  });

  it("Bank.cash reads the fees, sessions and inputs of a world", () => {
    const { world, seed } = seededWorld();
    world.bank.addFee(seed.admin.id, { label: "Max 20x", usdPerMonth: 300, from: "2026-01-01" });
    const { cash, cashCheck: ck } = world.bank.cash({ backend: "docker" }, false, {}, NOW);
    expect(cash).toMatchObject({ plans: 300, hosting: 0, total: 300 + cash.apiKeys });
    expect(ck.ok).toBe(true);
  });
});
