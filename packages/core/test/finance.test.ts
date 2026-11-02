import { describe, expect, it } from "vitest";
import { dailyInflowOf, financeSummary, type FinanceInputs } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const T0 = new Date("2026-10-20T12:00:00.000Z");
const at = (days: number) => new Date(T0.getTime() + days * 86_400_000);
const iso = (days: number) => at(days).toISOString();
const none: FinanceInputs = { credits: [], debits: [], allocations: [], usage: [] };

describe("financeSummary (GET /api/finance)", () => {
  it("is all zeros with an ok sum check on an empty town", () => {
    const f = financeSummary(none, T0);
    expect(f).toMatchObject({ total: 0, used: 0, expired: 0, left: 0, overdrawn: 0, sumCheck: { ok: true, diff: 0 } });
    expect(f.projection).toEqual({ days: 30, trailingDailyBurn: 0, burnDays: 1, projectedUse30d: 0, dailyInflow: 0, netDailyBurn: 0, projectedInflow30d: 0, runwayDays: null, runway: "no-usage" });
  });

  it("a subscription credit partly drawn is left until it expires, then its undrawn rest is expired", () => {
    const inp: FinanceInputs = { ...none, credits: [{ id: "c1", tokens: 1000, expiresAt: iso(1) }], debits: [{ creditId: "c1", tokens: 300 }] };
    const live = financeSummary(inp, at(0.5));
    expect(live).toMatchObject({ total: 1000, used: 300, expired: 0, left: 700, sumCheck: { ok: true } });
    const after = financeSummary(inp, at(1));
    expect(after).toMatchObject({ total: 1000, used: 300, expired: 700, left: 0, sumCheck: { ok: true } });
  });

  it("adds direct donations: a live one's unspent rest is left, a retired one counts only what it spent", () => {
    const f = financeSummary({ ...none, allocations: [
      { tokens: 500, spentTokens: 200, retired: false },
      { tokens: 400, spentTokens: 100, retired: true },
    ] }, T0);
    expect(f).toMatchObject({ credited: 0, donated: 600, total: 600, usedDonations: 300, used: 300, leftDonations: 300, left: 300, sumCheck: { ok: true } });
  });

  it("an overdrawn durable pool keeps left at 0 and books the debt as overdrawn, so the identity balances", () => {
    const f = financeSummary({ ...none,
      credits: [{ id: "k", tokens: 1000, expiresAt: null }],
      debits: [{ creditId: null, tokens: 1250 }],
      allocations: [{ tokens: 100, spentTokens: 130, retired: false }],
    }, T0);
    expect(f).toMatchObject({ total: 1100, used: 1380, expired: 0, left: 0, leftBank: 0, overdrawn: 280, sumCheck: { ok: true, diff: 0 } });
    // used + expired + left = total + overdrawn
    expect(f.used + f.expired + f.left).toBe(f.total + f.overdrawn);
  });

  it("breaks overdrawn into durable overshoot, subscription credits drawn past size, deleted-credit debits and allocation overspend, summing to it", () => {
    const f = financeSummary({ ...none,
      credits: [
        { id: "k", tokens: 1000, expiresAt: null },
        { id: "s1", tokens: 500, expiresAt: iso(-1) }, // expired, drawn 70 past its size
        { id: "s2", tokens: 400, expiresAt: iso(1) }, // live, drawn 100
      ],
      debits: [
        { creditId: null, tokens: 1250 },
        { creditId: "s1", tokens: 570 },
        { creditId: "s2", tokens: 100 },
        { creditId: "gone", tokens: 40 },
      ],
      allocations: [{ tokens: 100, spentTokens: 130, retired: false }, { tokens: 200, spentTokens: 205, retired: true }],
    }, T0);
    expect(f.overdrawnBreakdown).toEqual({ durableOvershoot: 250, subscriptionOverdrawn: 70, deletedCreditDebits: 40, allocationOverspent: 35 });
    const b = f.overdrawnBreakdown;
    expect(b.durableOvershoot + b.subscriptionOverdrawn + b.deletedCreditDebits + b.allocationOverspent).toBe(f.overdrawn);
    expect(f).toMatchObject({ overdrawn: 395, left: 300, sumCheck: { ok: true, diff: 0 } });
    // nothing overdrawn: every part 0
    expect(financeSummary(none, T0).overdrawnBreakdown).toEqual({ durableOvershoot: 0, subscriptionOverdrawn: 0, deletedCreditDebits: 0, allocationOverspent: 0 });
  });

  it("projects 30 days from the trailing 7-day burn, over fewer days while the ledger is younger than a week", () => {
    // 2.5 days of history: averaged over 3 whole days
    const young = financeSummary({ ...none, usage: [
      { tokens: 600, createdAt: iso(-2.5) }, { tokens: 300, createdAt: iso(-1) },
    ] }, T0);
    expect(young.projection).toMatchObject({ days: 30, trailingDailyBurn: 300, burnDays: 3, projectedUse30d: 9000 });
    // older history: only the last 7 days count, averaged over 7
    const old = financeSummary({ ...none, usage: [
      { tokens: 99_999, createdAt: iso(-20) }, { tokens: 700, createdAt: iso(-6) }, { tokens: 700, createdAt: iso(-0.1) },
    ] }, T0);
    expect(old.projection).toMatchObject({ trailingDailyBurn: 200, burnDays: 7, projectedUse30d: 6000 });
    expect(old.usageLedger).toBe(101_399);
  });

  describe("runway nets the daily inflow against the burn (gr_rdzg83m0al)", () => {
    type In = NonNullable<FinanceInputs["bankInputs"]>[number];
    const inp = (o: Partial<In>): In => ({ tokens: 0, recurrence: "daily", weeklyCapTokens: null, cancelledAt: null, ...o });
    // 7 days of 1,000/day burn, 10,000 left in a durable credit
    const base: FinanceInputs = {
      ...none,
      credits: [{ id: "c1", tokens: 10_000, expiresAt: null }],
      usage: Array.from({ length: 7 }, (_, d) => ({ tokens: 1000, createdAt: iso(-d - 0.5) })),
    };

    it("covered: inflow above the burn leaves runwayDays null and netDailyBurn negative", () => {
      const p = financeSummary({ ...base, bankInputs: [inp({ tokens: 1500 })] }, T0).projection;
      expect(p).toMatchObject({ trailingDailyBurn: 1000, dailyInflow: 1500, netDailyBurn: -500, projectedInflow30d: 45_000, runwayDays: null, runway: "covered" });
      // inflow exactly equal to the burn is covered too
      expect(financeSummary({ ...base, bankInputs: [inp({ tokens: 1000 })] }, T0).projection.runway).toBe("covered");
    });

    it("short: inflow below the burn lasts floor(left / (burn − inflow)) days", () => {
      const p = financeSummary({ ...base, bankInputs: [inp({ tokens: 700 })] }, T0).projection;
      expect(p).toMatchObject({ dailyInflow: 700, netDailyBurn: 300, runwayDays: 33, runway: "days" }); // floor(10000 / 300)
      expect(financeSummary(base, T0).projection).toMatchObject({ dailyInflow: 0, netDailyBurn: 1000, runwayDays: 10, runway: "days" });
    });

    it("no usage in the window: runway \"no-usage\", whatever comes in", () => {
      const p = financeSummary({ ...base, usage: [], bankInputs: [inp({ tokens: 700 })] }, T0).projection;
      expect(p).toMatchObject({ trailingDailyBurn: 0, dailyInflow: 700, netDailyBurn: -700, runwayDays: null, runway: "no-usage" });
    });

    it("counts active recurring inputs only, monthly as 30 days, a subscription at most its weekly cap / 7", () => {
      expect(dailyInflowOf([
        inp({ tokens: 700, recurrence: "weekly" }),                   // 100
        inp({ tokens: 3000, recurrence: "monthly" }),                 // 100
        inp({ tokens: 9999, recurrence: "once" }),                    // 0
        inp({ tokens: 9999, cancelledAt: iso(-1) }),                  // 0
        inp({ tokens: 1000, weeklyCapTokens: 2100 }),                 // min(1000, 300) = 300
      ])).toBe(500);
    });
  });

  it("balances on a real Bank: subscription credit, overshoot past the durable share, a donation", () => {
    const { world } = seededWorld();
    const u = world.ops.createUser("U").user;
    world.bank.addInput(u.id, { label: "Key", source: "api-key", model: "m", tokens: 1000, apiKey: "k" }, T0);
    const bid = world.buildings.all().find((x) => x.kind !== "town-hall")!.id;
    const agent = world.agents.all().find((a) => a.homeBuildingId === bid) ?? world.agents.all()[0]!;
    world.bank.draw(bid, agent.id, 1500, { overshoot: true, now: T0 });
    const before = world.bank.finance(T0); // the seed's own donations
    world.budget.donate(u.id, { tokens: 400, buildingId: bid, auth: "api-key" });
    const f = world.bank.finance(T0);
    expect(f).toMatchObject({ credited: 1000, usedBank: 1500, leftBank: 0, overdrawn: 500, sumCheck: { ok: true } });
    const b = f.overdrawnBreakdown;
    expect(b.durableOvershoot).toBe(500);
    expect(b.durableOvershoot + b.subscriptionOverdrawn + b.deletedCreditDebits + b.allocationOverspent).toBe(f.overdrawn);
    expect(f.donated - before.donated).toBe(400);
    expect(f.leftDonations - before.leftDonations).toBe(400);
    expect(f.total).toBe(1000 + f.donated);
  });
});
