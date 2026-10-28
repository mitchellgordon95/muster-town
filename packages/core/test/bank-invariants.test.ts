import { describe, expect, it } from "vitest";
import { createBuilding, createResident } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

// Invariants of the Bank and budget (docs/invariants/bank.md): conservation, renewal catch-up, the floor at 0.
const T0 = new Date("2026-10-20T12:00:00.000Z");
const at = (days: number) => new Date(T0.getTime() + days * 86_400_000);

describe("bank invariants", () => {
  it("every charge is booked in full as Bank debits plus allocation spend, and the finance identity holds after each one", () => {
    const { world, seed } = seededWorld();
    const b = createBuilding(world, { name: "Banked" }, seed.admin.id);
    const a = createResident(world, { buildingId: b.id, name: "A", title: "t", direction: "d" });
    world.bank.setBuildingPool(seed.admin.id, b.id, world.bank.createPool(seed.admin.id, { name: "All", pct: 100 }).id);
    world.bank.addInput(seed.admin.id, { label: "Key", source: "api-key", model: "m", tokens: 1000, apiKey: "sk" });
    const alloc = world.budget.donate(seed.admin.id, { tokens: 500, buildingId: b.id });
    const sum = (sql: string) => (world.db.prepare(sql).get(b.id) as { t: number | null }).t ?? 0;
    const booked = () => sum("SELECT SUM(tokens) t FROM bank_debits WHERE buildingId = ?") + sum("SELECT SUM(spentTokens) t FROM allocations WHERE buildingId = ?");
    const usage = () => sum("SELECT SUM(tokens) t FROM usage WHERE buildingId = ?");
    // Bank share only; Bank then allocation; Bank empty, the allocation takes all of it; a charge naming its allocation
    const charges: [number, string | undefined][] = [[300, undefined], [600, undefined], [400, undefined], [500, undefined], [50, alloc.id]];
    for (const [tokens, allocationId] of charges) {
      const before = { booked: booked(), usage: usage() };
      world.budget.charge(a.id, tokens, 0, allocationId);
      expect(usage() - before.usage).toBe(tokens);
      expect(booked() - before.booked).toBe(tokens);
      expect(world.bank.finance().sumCheck).toMatchObject({ ok: true, diff: 0 });
    }
    expect(usage()).toBe(1850);
    // the Bank share paid its 1000; the allocation that took the rest of a charge took all of it, past its size (no hard stop)
    expect(world.bank.available(b.id)).toMatchObject({ durable: 0 });
    expect(world.allocations.require(alloc.id).spentTokens).toBe(850);
    expect(world.bank.finance()).toMatchObject({ usedBank: 1000 });
  });

  it("after downtime a renewal credits once, and a subscription's catch-up credit expires at the next renewal after now", () => {
    const { world, seed } = seededWorld();
    const inp = world.bank.addInput(seed.admin.id, { label: "Max plan", source: "subscription", model: "m", tokens: 400, recurrence: "daily", weeklyCapTokens: 100_000 }, T0);
    expect(world.bank.balance(at(0.5))).toBe(400);
    // the server is down from day 0.5 to day 5.5: five renewals are missed, one is paid
    expect(world.bank.creditDue(at(5.5))).toBe(400);
    expect(world.bank.creditDue(at(5.5))).toBe(0);
    const credits = world.db.prepare("SELECT createdAt, expiresAt FROM bank_credits WHERE inputId = ? ORDER BY createdAt").all(inp.id) as { createdAt: string; expiresAt: string }[];
    expect(credits).toHaveLength(2);
    expect(credits[1]!.expiresAt).toBe(at(6).toISOString());
    expect(world.bank.input(inp.id)!.nextCreditAt).toBe(at(6).toISOString());
    // the day-0 credit expired unspent and doesn't roll over
    expect(world.bank.balance(at(5.5))).toBe(400);
    expect(world.bank.finance(at(5.5))).toMatchObject({ credited: 800, expired: 400, leftBank: 400, sumCheck: { ok: true } });
    expect(world.bank.creditDue(at(6))).toBe(400);
  });

  it("balances shown are floored at 0 after an overshoot; the debt stays in the pool's durable share and the next credit pays it back first", () => {
    const { world, seed } = seededWorld();
    const b = createBuilding(world, { name: "Banked" }, seed.admin.id);
    const a = createResident(world, { buildingId: b.id, name: "A", title: "t", direction: "d" });
    world.bank.setBuildingPool(seed.admin.id, b.id, world.bank.createPool(seed.admin.id, { name: "All", pct: 100 }).id);
    world.bank.addInput(seed.admin.id, { label: "Key", source: "api-key", model: "m", tokens: 1000, apiKey: "sk" }, T0);
    expect(world.bank.draw(b.id, a.id, 1500, { overshoot: true, now: T0 })).toBe(0);
    expect(world.bank.available(b.id, T0)).toEqual({ expiring: 0, durable: -500 });
    expect(world.bank.remaining(b.id, T0)).toBe(0);
    expect(world.bank.balance(T0)).toBe(0);
    expect(world.bank.summary().balanceTokens).toBe(0);
    expect(world.bank.finance(T0)).toMatchObject({ leftBank: 0, overdrawn: 500, sumCheck: { ok: true } });
    expect(world.bank.fundingFor(b.id, T0)).toBeNull();
    // a new credit pays the debt back before anything is spendable
    world.bank.addInput(seed.admin.id, { label: "Key 2", source: "api-key", model: "m", tokens: 800, apiKey: "sk2" }, T0);
    expect(world.bank.available(b.id, T0)).toEqual({ expiring: 0, durable: 300 });
    expect(world.bank.balance(T0)).toBe(300);
    expect(world.bank.finance(T0)).toMatchObject({ leftBank: 300, overdrawn: 0, sumCheck: { ok: true } });
  });
});
