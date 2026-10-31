import { describe, expect, it } from "vitest";
import { createBuilding, createResident, HOSTED_KEY_ONLY_HOLD, NoCredential } from "../src/index.ts";
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
    expect(world.bank.summary().inputs.find((i) => i.id === inp.id)).toMatchObject({ userName: "Donor" });
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
    const sub = { label: "Max plan", source: "subscription" as const, token: "sk-ant-oat01-test-token", model: "m", tokens: 400, recurrence: "daily" as const, weeklyCapTokens: 1000 };
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

  it("every building draws the one general balance: expiring subscription credits first, then durable; expiring ones don't roll over", () => {
    const { world, seed } = seededWorld();
    const lab2 = createBuilding(world, { name: "Lab 2" }, seed.admin.id);
    world.bank.addInput(seed.admin.id, { label: "Max plan", source: "subscription", token: "sk-ant-oat01-test-token", model: "m", tokens: 4000, recurrence: "daily", weeklyCapTokens: 100_000 }, T0);
    world.bank.addInput(seed.admin.id, { label: "Key", source: "api-key", model: "m", tokens: 8000, apiKey: "sk" }, T0);
    const now = at(0.5);
    expect(world.bank.available("carbon-cycle", now)).toEqual({ expiring: 4000, durable: 8000 });
    expect(world.bank.available(lab2.id, now)).toEqual({ expiring: 4000, durable: 8000 });
    expect(world.bank.available("no-such-building", now)).toEqual({ expiring: 0, durable: 0 });
    expect(world.bank.fundingFor("carbon-cycle", now)).toEqual({ kind: "expiring" });
    const mei = world.agents.first("name = 'Mei'")!;
    expect(world.bank.draw("carbon-cycle", mei.id, 5000, { now })).toBe(0);
    expect(world.bank.available(lab2.id, now)).toEqual({ expiring: 0, durable: 7000 });
    const key = world.bank.summary().inputs.find((i) => i.label === "Key")!;
    expect(world.bank.fundingFor("carbon-cycle", now)).toEqual({ kind: "durable", inputId: key.id });
    // no hard stop: an overshoot goes negative and is paid back from later credits
    expect(world.bank.draw("carbon-cycle", mei.id, 7500, { now })).toBe(500);
    expect(world.bank.draw("carbon-cycle", mei.id, 500, { now, overshoot: true })).toBe(0);
    expect(world.bank.available("carbon-cycle", now)).toEqual({ expiring: 0, durable: -500 });
    expect(world.bank.remaining("carbon-cycle", now)).toBe(0);
    expect(world.bank.fundingFor("carbon-cycle", now)).toBeNull();
    // the day-0 subscription credit expires at the next renewal; the next day's credit is new
    world.bank.creditDue(at(1));
    expect(world.bank.available(lab2.id, at(1.5))).toEqual({ expiring: 4000, durable: -500 });
  });

  it("buildings share the balance first come first served; the Town Hall draws like any building", () => {
    const { world, seed } = seededWorld();
    const lab2 = createBuilding(world, { name: "Lab 2" }, seed.admin.id);
    world.bank.addInput(seed.admin.id, { label: "Key", source: "api-key", model: "m", tokens: 1000, apiKey: "sk" }, T0);
    expect(world.bank.available("carbon-cycle")).toEqual({ expiring: 0, durable: 1000 });
    expect(world.bank.available(lab2.id)).toEqual({ expiring: 0, durable: 1000 });
    expect(world.bank.available("town-hall")).toEqual({ expiring: 0, durable: 1000 });
    expect(world.bank.draw("town-hall", "x", 100)).toBe(0);
    const mei = world.agents.first("name = 'Mei'")!;
    expect(world.bank.draw("carbon-cycle", mei.id, 600)).toBe(0);
    expect(world.bank.available(lab2.id)).toEqual({ expiring: 0, durable: 300 });
    expect(world.bank.draw(lab2.id, mei.id, 500)).toBe(200);
    expect(world.bank.remaining("carbon-cycle")).toBe(0);
  });

  it("the summary shows each building's view of the one balance", () => {
    const { world, seed } = seededWorld();
    const lab2 = createBuilding(world, { name: "Lab 2" }, seed.admin.id);
    world.bank.addInput(seed.admin.id, { label: "Key", source: "api-key", model: "m", tokens: 1000, apiKey: "sk" }, T0);
    const s = world.bank.summary();
    expect(s).not.toHaveProperty("pools");
    expect(s.buildings.find((b) => b.buildingId === lab2.id)).toEqual({ buildingId: lab2.id, name: "Lab 2", expiringTokens: 0, durableTokens: 1000, heldTokens: 0, heldByAuth: { subscription: 0, apiKey: 0, donorKey: 0 } });
    expect(s.free).toMatchObject({ goalId: "gl_town", generalTokens: 1000, freeTokens: 1000 });
  });

  it("charge draws from the general balance before the building's allocations and keeps the building able to start", () => {
    const { world, seed } = seededWorld();
    const b = createBuilding(world, { name: "Banked" }, seed.admin.id);
    const a = createResident(world, { buildingId: b.id, name: "A", title: "t", direction: "d" });
    expect(world.budget.canStart(a.id)).toBe(false);
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
    world.allocations.upsert({ ...placeholder, spentOutput: 250, spentTokens: 250 });
    world.budget.retire(placeholder.id);
    world.budget.donate(u.id, { tokens: 400, buildingId: lab.id, auth: "api-key" });
    expect(world.bank.contributors().find((c) => c.userId === u.id)).toMatchObject({ tokens: 650, donatedTokens: 650 });
  });
});

describe("pools deleted (migration 067)", () => {
  it("leaves the pools-era tables and columns in place, read by nothing; debits still get the old column's default", () => {
    const { world, seed } = seededWorld();
    world.bank.addInput(seed.admin.id, { label: "Key", source: "api-key", model: "m", tokens: 1000, apiKey: "sk" }, T0);
    world.bank.draw("carbon-cycle", world.agents.first("name = 'Mei'")!.id, 10);
    const cols = (t: string) => (world.db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols("goals")).toEqual(expect.arrayContaining(["poolId", "explorationTokensPerDay", "exploreCapTokensPerDay"]));
    expect(cols("buildings")).toEqual(expect.arrayContaining(["poolId", "explorationTokensPerDay"]));
    expect(world.db.prepare("SELECT COUNT(*) AS n FROM bank_pools").get()).toEqual({ n: 1 });
    expect(world.db.prepare("SELECT DISTINCT poolId FROM bank_debits").all()).toEqual([{ poolId: "general" }]);
    expect(world.bankReservations.all()).toEqual([]);
  });
});

// Mitchell, 1:1 mt_p3ge56kg03: only the Workshop and self-hosted towns run on a Claude subscription (Anthropic's terms)
describe("a hosted collective never runs on a subscription", () => {
  const sub = { label: "Max plan", source: "subscription" as const, model: "m", tokens: 5_000_000, recurrence: "daily" as const, weeklyCapTokens: 35_000_000, token: "sk-ant-oat01-stray" };
  it("refuses to fund a session on a stray subscription input and says to add an API key", () => {
    const { world, seed, by } = seededWorld(); // its Bank holds the test subscription input
    world.bank.addInput(seed.admin.id, sub); // credited: today's expiring share would pay
    world.host.hosted = true;
    const lab = by("Noor").buildingId!;
    expect(() => world.budget.fundingFor(lab)).toThrow(NoCredential);
    expect(() => world.budget.fundingFor(lab)).toThrow(HOSTED_KEY_ONLY_HOLD);
    expect(world.budget.credentialHold(lab)).toBe(HOSTED_KEY_ONLY_HOLD);
    expect(world.bank.subscriptionCredential()).toBeNull();
    expect(() => world.bank.townCredential()).toThrow(HOSTED_KEY_ONLY_HOLD);
    expect(() => world.bank.addInput(seed.admin.id, sub)).toThrow(HOSTED_KEY_ONLY_HOLD);
  });
  it("runs on the Bank's API key where the subscription would pay", () => {
    const { world, seed, by } = seededWorld();
    world.bank.addInput(seed.admin.id, sub);
    const key = world.bank.addInput(seed.admin.id, { label: "Owner key", source: "api-key", model: "m", tokens: 1_000_000, recurrence: "once", apiKey: "sk-ant-api03-owner" } as never);
    world.host.hosted = true;
    const lab = by("Noor").buildingId!;
    const f = world.budget.fundingFor(lab);
    expect(f.auth).toBe("api-key");
    expect(f.credential).toMatchObject({ kind: "api-key", inputId: key.id });
    expect(world.bank.townCredential().kind).toBe("api-key");
  });
  it("the Workshop (not hosted) is unchanged: it runs on its subscription", () => {
    const { world, seed, by } = seededWorld();
    world.bank.addInput(seed.admin.id, sub);
    const f = world.budget.fundingFor(by("Noor").buildingId!);
    expect(f.auth).toBe("subscription");
    expect(f.credential.kind).toBe("subscription");
  });
});
