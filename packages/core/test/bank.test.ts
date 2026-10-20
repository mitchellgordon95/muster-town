import { describe, expect, it } from "vitest";
import { createBuilding, createResident } from "../src/index.ts";
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

  it("labs split the Bank equally unless an admin sets a share; explicit shares can't pass 100%", () => {
    const { world, seed } = seededWorld();
    const other = world.ops.createUser("Other").user;
    const lab2 = createBuilding(world, { name: "Lab 2" }, seed.admin.id);
    const pct = (id: string) => world.bank.shares().get(id)!;
    expect(pct("carbon-cycle")).toEqual({ pct: 50, explicit: false });
    expect(pct(lab2.id)).toEqual({ pct: 50, explicit: false });
    expect(pct("town-hall").pct).toBe(0);
    expect(() => world.bank.setShare(other.id, lab2.id, { pct: 10 })).toThrow(/admin/);
    world.bank.setShare(seed.admin.id, lab2.id, { pct: 70 });
    expect(pct(lab2.id)).toEqual({ pct: 70, explicit: true });
    expect(pct("carbon-cycle").pct).toBe(30);
    expect(() => world.bank.setShare(seed.admin.id, "town-hall", { pct: 40 })).toThrow(/30%/);
    world.bank.setShare(seed.admin.id, lab2.id, { pct: null });
    expect(pct(lab2.id)).toEqual({ pct: 50, explicit: false });
  });

  it("a building draws its share: expiring subscription credits first, then durable; expiring ones don't roll over", () => {
    const { world, seed } = seededWorld();
    const lab2 = createBuilding(world, { name: "Lab 2" }, seed.admin.id);
    world.bank.setShare(seed.admin.id, "carbon-cycle", { pct: 25 });
    world.bank.addInput(seed.admin.id, { label: "Max plan", source: "subscription", model: "m", tokens: 4000, recurrence: "daily", weeklyCapTokens: 100_000 }, T0);
    world.bank.addInput(seed.admin.id, { label: "Key", source: "api-key", model: "m", tokens: 8000, apiKey: "sk" }, T0);
    const now = at(0.5);
    expect(world.bank.available("carbon-cycle", now)).toEqual({ expiring: 1000, durable: 2000 });
    expect(world.bank.available(lab2.id, now)).toEqual({ expiring: 3000, durable: 6000 });
    expect(world.bank.fundingFor("carbon-cycle", now)).toEqual({ kind: "expiring" });
    const mei = world.agents.first("name = 'Mei'")!;
    expect(world.bank.draw("carbon-cycle", mei.id, 1500, { now })).toBe(0);
    expect(world.bank.available("carbon-cycle", now)).toEqual({ expiring: 0, durable: 1500 });
    const key = world.bank.summary().inputs.find((i) => i.label === "Key")!;
    expect(world.bank.fundingFor("carbon-cycle", now)).toEqual({ kind: "durable", inputId: key.id });
    // no hard stop: an overshoot goes negative and the share is paid back from later credits
    expect(world.bank.draw("carbon-cycle", mei.id, 2000, { now })).toBe(500);
    expect(world.bank.draw("carbon-cycle", mei.id, 500, { now, overshoot: true })).toBe(0);
    expect(world.bank.available("carbon-cycle", now)).toEqual({ expiring: 0, durable: -500 });
    expect(world.bank.remaining("carbon-cycle", now)).toBe(0);
    expect(world.bank.fundingFor("carbon-cycle", now)).toBeNull();
    // the day-0 subscription credit expires at the next renewal; lab 2's unused 3000 is gone
    expect(world.bank.available(lab2.id, at(1))).toEqual({ expiring: 0, durable: 6000 });
    expect(world.bank.balance(at(1))).toBe(5500); // 8000 durable less carbon-cycle's 2500
    world.bank.creditDue(at(1));
    expect(world.bank.available(lab2.id, at(1.5))).toEqual({ expiring: 3000, durable: 6000 });
  });

  it("charge draws from the Bank share before the building's allocations and keeps the building able to start", () => {
    const { world, seed } = seededWorld();
    const b = createBuilding(world, { name: "Banked" }, seed.admin.id);
    const a = createResident(world, { buildingId: b.id, name: "A", title: "t", direction: "d" });
    expect(world.budget.canStart(a.id)).toBe(false);
    world.bank.setShare(seed.admin.id, b.id, { pct: 100 });
    world.bank.addInput(seed.admin.id, { label: "Key", source: "api-key", model: "m", tokens: 1000, apiKey: "sk" });
    expect(world.budget.of(b.id)).toMatchObject({ remainingTokens: 1000, bankTokens: 1000 });
    expect(world.budget.canStart(a.id)).toBe(true);
    world.budget.donate(seed.admin.id, { tokens: 500, buildingId: b.id });
    const r = world.budget.charge(a.id, 1200, 1.2);
    expect(r.allocation).toMatchObject({ spentTokens: 200 });
    expect(world.budget.of(b.id)).toMatchObject({ remainingTokens: 300, bankTokens: 0 });
    expect(world.bank.summary()).toMatchObject({ balanceTokens: 0, durableTokens: 0 });
    expect(world.bank.summary().buildings.find((s) => s.buildingId === b.id)).toMatchObject({ heldTokens: 300 });
  });

  it("with no inputs the Bank is empty, but the summary counts tokens donated straight to buildings", () => {
    const { world, seed } = seededWorld();
    const before = world.bank.summary().heldTokens;
    const b = createBuilding(world, { name: "Held" }, seed.admin.id);
    world.budget.donate(seed.admin.id, { tokens: 700, buildingId: b.id });
    const s = world.bank.summary();
    expect(s).toMatchObject({ balanceTokens: 0, heldTokens: before + 700, townTokens: before + 700 });
    expect(s.buildings.find((r) => r.buildingId === b.id)).toMatchObject({ heldTokens: 700 });
  });

  it("ranks contributors by Bank credits plus direct donations, most first", () => {
    const { world, seed } = seededWorld();
    const a = world.ops.createUser("Ada").user, b = world.ops.createUser("Bo").user;
    world.ops.createUser("Idle");
    world.bank.addInput(a.id, { label: "Ada key", source: "api-key", model: "m", tokens: 3000, apiKey: "k" }, T0);
    world.bank.addInput(b.id, { label: "Bo key", source: "api-key", model: "m", tokens: 2000, apiKey: "k" }, T0);
    const lab = createBuilding(world, { name: "Lab 2" }, seed.admin.id);
    world.budget.donate(b.id, { tokens: 1500, buildingId: lab.id });
    // the seeded admin's donation to the imported lab ranks too; check our two relative to each other
    expect(world.bank.summary().contributors.filter((c) => c.userId === a.id || c.userId === b.id)).toEqual([
      { userId: b.id, name: "Bo", tokens: 3500, bankTokens: 2000, donatedTokens: 1500 },
      { userId: a.id, name: "Ada", tokens: 3000, bankTokens: 3000, donatedTokens: 0 },
    ]);
    expect(world.bank.contributors(1)).toHaveLength(1);
  });

  it("counts a retired allocation only for what was spent from it", () => {
    const { world, seed } = seededWorld();
    const u = world.ops.createUser("Cy").user;
    const lab = createBuilding(world, { name: "Lab 3" }, seed.admin.id);
    const placeholder = world.budget.donate(u.id, { tokens: 1000, buildingId: lab.id, auth: "api-key" });
    world.allocations.upsert({ ...placeholder, spentTokens: 250 });
    world.budget.retire(placeholder.id);
    world.budget.donate(u.id, { tokens: 400, buildingId: lab.id, auth: "api-key" });
    expect(world.bank.contributors().find((c) => c.userId === u.id)).toMatchObject({ tokens: 650, donatedTokens: 650 });
  });
});
