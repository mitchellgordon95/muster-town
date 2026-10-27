import { describe, expect, it } from "vitest";
import { financeSummary, type FinanceInputs } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const T0 = new Date("2026-10-20T12:00:00.000Z");
const at = (days: number) => new Date(T0.getTime() + days * 86_400_000);
const iso = (days: number) => at(days).toISOString();
const none: FinanceInputs = { credits: [], debits: [], allocations: [], usage: [] };

describe("financeSummary (GET /api/finance)", () => {
  it("is all zeros with an ok sum check on an empty town", () => {
    const f = financeSummary(none, T0);
    expect(f).toMatchObject({ total: 0, used: 0, expired: 0, left: 0, overdrawn: 0, sumCheck: { ok: true, diff: 0 } });
    expect(f.projection).toEqual({ days: 30, trailingDailyBurn: 0, burnDays: 1, projectedUse30d: 0 });
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

  it("projects 30 days from the trailing 7-day burn, over fewer days while the ledger is younger than a week", () => {
    // 2.5 days of history: averaged over 3 whole days
    const young = financeSummary({ ...none, usage: [
      { tokens: 600, createdAt: iso(-2.5) }, { tokens: 300, createdAt: iso(-1) },
    ] }, T0);
    expect(young.projection).toEqual({ days: 30, trailingDailyBurn: 300, burnDays: 3, projectedUse30d: 9000 });
    // older history: only the last 7 days count, averaged over 7
    const old = financeSummary({ ...none, usage: [
      { tokens: 99_999, createdAt: iso(-20) }, { tokens: 700, createdAt: iso(-6) }, { tokens: 700, createdAt: iso(-0.1) },
    ] }, T0);
    expect(old.projection).toMatchObject({ trailingDailyBurn: 200, burnDays: 7, projectedUse30d: 6000 });
    expect(old.usageLedger).toBe(101_399);
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
    expect(f.donated - before.donated).toBe(400);
    expect(f.leftDonations - before.leftDonations).toBe(400);
    expect(f.total).toBe(1000 + f.donated);
  });
});
