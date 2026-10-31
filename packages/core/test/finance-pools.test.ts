import { describe, expect, it } from "vitest";
import { createBuilding, DELETED_BUILDING, DELETED_POOL, financePools, type PoolsInputs } from "../src/index.ts";
import { fundBuilding, seededWorld } from "./helpers.ts";

const T0 = new Date("2026-10-20T12:00:00.000Z");
const iso = (days: number) => new Date(T0.getTime() + days * 86_400_000).toISOString();

// General (auto 60%) holds the Town Hall and b1; Labs (explicit 40%) holds b2 and is overdrawn on durable
const fixture: PoolsInputs = {
  pools: [
    { id: "labs", name: "Labs", createdAt: iso(-1) },
    { id: "general", name: "General", createdAt: iso(-2) },
  ],
  buildings: [
    { id: "town-hall", name: "Town Hall", kind: "town-hall", poolId: null },
    { id: "b1", name: "Workshop", kind: "lab", poolId: null },
    { id: "b2", name: "Prod", kind: "lab", poolId: "labs" },
  ],
  shares: new Map([["general", { pct: 60, explicit: false }], ["labs", { pct: 40, explicit: true }]]),
  credits: [
    { id: "s0", tokens: 500, expiresAt: iso(0) }, // expired
    { id: "s1", tokens: 1000, expiresAt: iso(1) }, // live subscription
    { id: "d1", tokens: 1000, expiresAt: null }, // durable
  ],
  debits: [
    { buildingId: "b1", poolId: "general", creditId: "s0", grantId: null, tokens: 200 },
    { buildingId: "b1", poolId: "general", creditId: "s1", grantId: null, tokens: 300 },
    { buildingId: "b1", poolId: "general", creditId: "s1", grantId: "g1", tokens: 50 }, // member funding
    { buildingId: "b1", poolId: "general", creditId: "d1", grantId: null, tokens: 100 },
    { buildingId: "b2", poolId: "labs", creditId: null, grantId: null, tokens: 600 }, // overshoot: Labs' durable share is 400
  ],
  allocations: [
    { buildingId: "b1", tokens: 500, spentTokens: 100, retired: false },
    { buildingId: "b1", tokens: 300, spentTokens: 200, retired: true },
  ],
  dailyInflowTokens: 1000,
  allowance: (id) => (id === "b1" ? 70 : id === "town-hall" ? 0 : 30), // like Grants.exploration: the Town Hall has no exploration
};

describe("financePools (GET /api/finance/pools)", () => {
  it("each pool's share, left and overdrawn; each building's draws, donations and held; both identities hold", () => {
    const p = financePools(fixture, T0);
    expect(p.pools.map((x) => [x.id, x.pct, x.expiringLeft, x.durableLeft, x.left, x.overdrawn, x.drawn, x.dailyInflowTokens])).toEqual([
      ["general", 60, 250, 500, 750, 0, 650, 600],
      ["labs", 40, 400, 0, 400, 200, 600, 400],
    ]);
    expect(p.pools[0]!.buildings.map((b) => b.id)).toEqual(["town-hall", "b1"]);
    expect(p.buildings.every((b) => b.drawsFromBank)).toBe(true); // the Town Hall draws like any building
    expect(p.buildings.map((b) => [b.id, b.drawn, b.drawnSubscription, b.drawnDurable, b.drawnMemberFunded, b.donated, b.donationsSpent, b.held, b.explorationTokensPerDay])).toEqual([
      ["town-hall", 0, 0, 0, 0, 0, 0, 0, 0],
      ["b1", 650, 550, 100, 50, 700, 300, 400, 70],
      ["b2", 600, 0, 600, 0, 0, 0, 0, 30],
    ]);
    // Bank: expiring 1000 − 350 = 650, durable 1000 − 700 = 300; no Bank-level overshoot (General's room covers Labs' debt)
    expect(p).toMatchObject({ balanceTokens: 950, overshootTokens: 0, poolsLeftTokens: 1150, poolsOverdrawnTokens: 200, unsharedTokens: 0, usedBank: 1250, sharedPct: 100, donatedTokens: 700, heldTokens: 400 });
    expect(p.sumCheck).toMatchObject({ drawsOk: true, drawsDiff: 0, balanceOk: true, balanceDiff: 0, ok: true });
  });

  it("one overdrawn pool alone: the Bank carries the same debt as its overshoot; unshared share and deleted rows are accounted", () => {
    const p = financePools({
      ...fixture,
      pools: [{ id: "general", name: "General", createdAt: iso(-2) }],
      shares: new Map([["general", { pct: 70, explicit: true }]]),
      debits: [
        { buildingId: "b1", poolId: "general", creditId: null, grantId: null, tokens: 900 }, // share 700: 200 over
        { buildingId: "gone", poolId: "old", creditId: "s1", grantId: null, tokens: 100 },
      ],
    }, T0);
    expect(p.pools.map((x) => [x.name, x.expiringLeft, x.durableLeft, x.overdrawn, x.drawn])).toEqual([["General", 700, 0, 200, 900], [DELETED_POOL, 0, 0, 0, 100]]);
    expect(p.buildings.at(-1)).toMatchObject({ id: null, name: DELETED_BUILDING, drawn: 100, drawnSubscription: 100 });
    // b2's pool "labs" is gone, so it counts as General
    expect(p.buildings.find((b) => b.id === "b2")!.poolId).toBe("general");
    // unshared: 30% of s1 (300) and of d1 (300), less the deleted pool's 100 on s1; Bank: expiring 900, durable 100 left
    expect(p).toMatchObject({ unsharedTokens: 500, balanceTokens: 1000, overshootTokens: 0, usedBank: 1000 });
    expect(p.sumCheck).toMatchObject({ drawsOk: true, balanceOk: true, ok: true });
    // the Bank-level overshoot: past every durable credit, the debt shows on both sides
    const over = financePools({ ...fixture, pools: [{ id: "general", name: "General", createdAt: iso(-2) }], shares: new Map([["general", { pct: 100, explicit: false }]]),
      debits: [{ buildingId: "b1", poolId: "general", creditId: null, grantId: null, tokens: 1300 }] }, T0);
    expect(over).toMatchObject({ balanceTokens: 1000, overshootTokens: 300, poolsLeftTokens: 1000, poolsOverdrawnTokens: 300, sumCheck: { ok: true } });
  });

  it("over a world: matches /api/bank pools, heldTokens and balance, and /api/finance usedBank and overshoot", () => {
    const { world, seed } = seededWorld();
    const now = new Date();
    const lab2 = createBuilding(world, { name: "Lab 2" }, seed.admin.id);
    const labs = world.bank.createPool(seed.admin.id, { name: "Labs", pct: 25 });
    fundBuilding(world, "carbon-cycle", { poolId: labs.id });
    world.bank.addInput(seed.admin.id, { label: "Max plan", source: "subscription", token: "sk-ant-oat01-test-token", model: "m", tokens: 4000, recurrence: "daily", weeklyCapTokens: 100_000 }, now);
    world.bank.addInput(seed.admin.id, { label: "Key", source: "api-key", model: "m", tokens: 8000, apiKey: "sk" }, now);
    const mei = world.agents.first("name = 'Mei'")!;
    world.bank.draw("carbon-cycle", mei.id, 3500, { now, overshoot: true }); // 1000 expiring + 2000 durable + 500 over
    world.bank.draw(lab2.id, mei.id, 1000, { now });
    world.budget.donate(seed.admin.id, { tokens: 400, buildingId: lab2.id, auth: "api-key" });

    const p = world.bank.pools((id) => world.grantDesk.exploration(id).allowanceTokens, now);
    const bank = world.bank.summary(), fin = world.bank.finance(now);
    expect(p.pools.map((x) => [x.id, x.pct, x.expiringLeft, x.durableLeft - x.overdrawn])).toEqual(bank.pools.map((x) => [x.id, x.pct, x.expiringTokens, x.durableTokens]));
    expect(p.pools.find((x) => x.id === labs.id)).toMatchObject({ overdrawn: 500, drawn: 3500 });
    expect(p.buildings.find((b) => b.id === "carbon-cycle")).toMatchObject({ drawn: 3500, drawnSubscription: 1000, drawnDurable: 2500 });
    for (const b of bank.buildings) expect(p.buildings.find((x) => x.id === b.buildingId)!.held).toBe(b.heldTokens);
    expect(p.buildings.find((b) => b.id === lab2.id)).toMatchObject({ drawn: 1000, donated: 400, held: 400, explorationTokensPerDay: world.grantDesk.exploration(lab2.id).allowanceTokens });
    expect(p).toMatchObject({ balanceTokens: bank.balanceTokens, usedBank: fin.usedBank, overshootTokens: fin.overdrawnBreakdown.durableOvershoot, sumCheck: { ok: true } });
  });
});
