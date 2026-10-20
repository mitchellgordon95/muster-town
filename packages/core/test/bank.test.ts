import { describe, expect, it } from "vitest";
import { seededWorld } from "./helpers.ts";

const T0 = new Date("2026-10-20T12:00:00.000Z");
const at = (days: number) => new Date(T0.getTime() + days * 86_400_000);

describe("bank", () => {
  it("a one-time api-key input credits once, keeps its key secret, and cancel forgets the key", () => {
    const { world } = seededWorld();
    const donor = world.ops.createUser("Donor").user;
    const inp = world.bank.addInput(donor.id, { label: "Donor key", source: "api-key", model: "claude-opus-5-5", tokens: 5000, apiKey: "sk-test" }, T0);
    expect(inp).toMatchObject({ creditedTokens: 5000, nextCreditAt: null, hasApiKey: true });
    expect(inp).not.toHaveProperty("apiKey");
    expect(world.bank.apiKeyFor(inp.id)).toBe("sk-test");
    expect(world.bank.creditDue(at(30))).toBe(0);
    expect(world.bank.summary()).toMatchObject({ balanceTokens: 5000, creditedTokens: 5000, dailyInflowTokens: 0 });
    expect(world.bank.summary().inputs[0]).toMatchObject({ userName: "Donor" });
    world.bank.cancelInput(donor.id, inp.id);
    expect(world.bank.apiKeyFor(inp.id)).toBeNull();
    expect(world.bank.balance()).toBe(5000);
    expect(world.events.list({ types: ["bank.credited"] })).toHaveLength(1);
  });

  it("a recurring input credits only on its renewal date, once per renewal", () => {
    const { world } = seededWorld();
    const u = world.ops.createUser("U").user;
    const inp = world.bank.addInput(u.id, { label: "Weekly", source: "api-key", model: "m", tokens: 7000, recurrence: "weekly", nextCreditAt: at(2).toISOString(), apiKey: "k" }, T0);
    expect(inp.creditedTokens).toBe(0);
    expect(world.bank.summary().dailyInflowTokens).toBe(1000);
    expect(world.bank.creditDue(at(1))).toBe(0);
    expect(world.bank.creditDue(at(2))).toBe(7000);
    expect(world.bank.creditDue(at(3))).toBe(0);
    // server down for three weeks: one credit, next renewal moves past now
    expect(world.bank.creditDue(at(30))).toBe(7000);
    expect(new Date(world.bank.summary().inputs[0]!.nextCreditAt!).getTime()).toBeGreaterThan(at(30).getTime());
    expect(world.bank.balance()).toBe(14_000);
    world.bank.cancelInput(u.id, inp.id);
    expect(world.bank.creditDue(at(60))).toBe(0);
    expect(world.bank.summary().dailyInflowTokens).toBe(0);
  });

  it("a subscription is admin-only and credits min(daily quota, weekly cap left) each day", () => {
    const { world, seed } = seededWorld();
    const other = world.ops.createUser("Other").user;
    const sub = { label: "Max plan", source: "subscription" as const, model: "m", tokens: 400, recurrence: "daily" as const, weeklyCapTokens: 1000 };
    expect(() => world.bank.addInput(other.id, sub, T0)).toThrow(/owner/);
    expect(() => world.bank.addInput(seed.admin.id, { ...sub, recurrence: "weekly" }, T0)).toThrow(/daily/);
    world.bank.addInput(seed.admin.id, sub, T0); // day 0: 400
    expect(world.bank.creditDue(at(1))).toBe(400);
    expect(world.bank.creditDue(at(2))).toBe(200); // cap 1000 reached
    expect(world.bank.creditDue(at(3))).toBe(0);
    expect(world.bank.creditDue(at(7.5))).toBe(400); // day-0 and day-1 credits fell out of the window
    expect(world.bank.summary().dailyInflowTokens).toBe(143); // min(400, 1000/7)
  });

  it("api-key inputs need a key; only the owner or an admin can cancel", () => {
    const { world } = seededWorld();
    const a = world.ops.createUser("A").user;
    const b = world.ops.createUser("B").user;
    expect(() => world.bank.addInput(a.id, { label: "x", source: "api-key", model: "m", tokens: 1 }, T0)).toThrow(/apiKey/);
    const inp = world.bank.addInput(a.id, { label: "x", source: "api-key", model: "m", tokens: 1, apiKey: "k" }, T0);
    expect(() => world.bank.cancelInput(b.id, inp.id)).toThrow(/owner/);
  });
});
