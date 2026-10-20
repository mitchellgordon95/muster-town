import { describe, expect, it } from "vitest";
import { createBuilding, createResident, HOUSE_BUDGET_TOKENS, HOUSE_LABEL } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

describe("budgets", () => {
  it("snapshot buildings carry their budget; charges resend the building with it", () => {
    const { world, by } = seededWorld();
    const snap = world.buildingsWithIntray().find((b) => b.id === "carbon-cycle")!;
    expect(snap.budget).toEqual({ allocatedTokens: HOUSE_BUDGET_TOKENS, spentTokens: 0, remainingTokens: HOUSE_BUDGET_TOKENS, bankTokens: 0 });
    const sent: unknown[] = [];
    world.changes.subscribe((m) => { if (m.type === "building") sent.push(m.building.budget); });
    world.budget.charge(by("Mei").id, 1000, 0.5);
    expect(sent.at(-1)).toEqual({ allocatedTokens: HOUSE_BUDGET_TOKENS, spentTokens: 1000, remainingTokens: HOUSE_BUDGET_TOKENS - 1000, bankTokens: 0 });
  });

  it("seed creates the house allocation; charge hits agent + oldest allocation", () => {
    const { world, by, seed } = seededWorld();
    expect(world.budget.remaining("carbon-cycle")).toBe(HOUSE_BUDGET_TOKENS);
    expect(world.users.require(seed.admin.id).donatedTokens).toBe(HOUSE_BUDGET_TOKENS);
    const mei = by("Mei");
    const r = world.budget.charge(mei.id, 1000, 0.5);
    expect(r.exhausted).toBeNull();
    expect(r.agent).toMatchObject({ spentTokensToday: 1000, spentTokensTotal: 1000, spentUsdTotal: 0.5 });
    expect(r.allocation).toMatchObject({ spentTokens: 1000, spentUsd: 0.5 });
    expect(world.budget.summary().buildings.find((b) => b.buildingId === "carbon-cycle")).toMatchObject({ spentTokens: 1000, remainingTokens: HOUSE_BUDGET_TOKENS - 1000, bankTokens: 0 });
    expect(world.budget.canStart(mei.id)).toBe(true);
  });

  it("daily exhaustion → out-of-budget + event; resetDaily resumes", () => {
    const { world, seed } = seededWorld();
    const b = createBuilding(world, { name: "Tiny", dailyTokensPerAgent: 100 }, seed.admin.id);
    const a = createResident(world, { buildingId: b.id, name: "A", title: "t", direction: "d" });
    world.budget.donate(seed.admin.id, { tokens: 10_000, buildingId: b.id });
    const r = world.budget.charge(a.id, 150, 0.01);
    expect(r.exhausted).toBe("agent-daily");
    expect(world.agents.require(a.id).status).toBe("out-of-budget");
    expect(world.budget.canStart(a.id)).toBe(false);
    expect(world.events.list({ types: ["budget.exhausted"] }).at(-1)!.payload).toMatchObject({ scope: "agent" });
    world.budget.resetDaily();
    expect(world.agents.require(a.id)).toMatchObject({ status: "idle", spentTokensToday: 0 });
  });

  it("building exhaustion stops all residents until a new donation; allocations are charged in draw order (donor key before the town key)", () => {
    const { world, seed } = seededWorld();
    const b = createBuilding(world, { name: "Broke" }, seed.admin.id);
    const a1 = createResident(world, { buildingId: b.id, name: "A1", title: "t", direction: "d" });
    const a2 = createResident(world, { buildingId: b.id, name: "A2", title: "t", direction: "d" });
    expect(world.budget.canStart(a1.id)).toBe(false); // no allocation yet
    const first = world.budget.donate(seed.admin.id, { tokens: 100, buildingId: b.id });
    const donor = world.ops.createUser("Donor").user;
    const second = world.budget.donate(donor.id, { tokens: 50, buildingId: b.id, apiKey: "sk-test" });
    expect(world.users.require(donor.id).hasApiKey).toBe(true);
    expect(JSON.stringify(world.users.require(donor.id))).not.toContain("sk-test");
    expect(first.auth).toBe("api-key");
    expect(second.auth).toBe("donor-key");
    expect(world.budget.pickAllocation(b.id)!.id).toBe(second.id);
    expect(world.budget.apiKeyFor(second)).toBe("sk-test");
    expect(world.budget.apiKeyFor(first)).toBeNull();
    world.budget.charge(a1.id, 50, 0);
    expect(world.budget.pickAllocation(b.id)!.id).toBe(first.id);
    const r = world.budget.charge(a2.id, 110, 0);
    expect(r.exhausted).toBe("building");
    expect(world.agents.require(a1.id).status).toBe("out-of-budget");
    expect(world.agents.require(a2.id).status).toBe("out-of-budget");
    world.budget.donate(donor.id, { tokens: 1000, buildingId: b.id });
    expect(world.agents.require(a1.id).status).toBe("idle");
    expect(world.budget.canStart(a1.id)).toBe(true);
  });

  it("funding order: subscription → donor-key → api-key; the fallback is the first donor-key / api-key allocation", () => {
    const { world, seed } = seededWorld();
    const b = createBuilding(world, { name: "Order" }, seed.admin.id);
    const town = world.budget.donate(seed.admin.id, { tokens: 1000, buildingId: b.id, auth: "api-key", label: "API-key buffer" });
    const donor = world.ops.createUser("Donor").user;
    const own = world.budget.donate(donor.id, { tokens: 500, buildingId: b.id, apiKey: "sk-donor", label: "Donor's key" });
    const sub = world.budget.donate(seed.admin.id, { tokens: 2000, buildingId: b.id, auth: "subscription", label: "Mitchell's Claude subscription, October" });
    expect(sub).toMatchObject({ auth: "subscription", label: "Mitchell's Claude subscription, October", retired: false });
    expect(world.budget.pickAllocation(b.id)!.id).toBe(sub.id);
    expect(world.budget.apiKeyFor(sub)).toBeNull();
    expect(world.budget.fallbackAllocation(b.id)!.id).toBe(own.id);
    world.budget.charge(createResident(world, { buildingId: b.id, name: "R", title: "t", direction: "d" }).id, 2000, 0);
    expect(world.budget.pickAllocation(b.id)!.id).toBe(own.id);
    world.budget.retire(own.id);
    expect(world.budget.pickAllocation(b.id)!.id).toBe(town.id);
    expect(world.budget.fallbackAllocation(b.id)!.id).toBe(town.id);
    expect(world.events.list({ types: ["allocation.created"] }).at(-1)!.text).toContain("(Mitchell's Claude subscription, October)");
  });

  it("donate without a key infers api-key; a donor-key allocation needs a key", () => {
    const { world, seed } = seededWorld();
    const b = createBuilding(world, { name: "Infer" }, seed.admin.id);
    expect(world.budget.donate(seed.admin.id, { tokens: 10, buildingId: b.id })).toMatchObject({ auth: "api-key", label: "" });
    expect(() => world.budget.donate(seed.admin.id, { tokens: 10, buildingId: b.id, auth: "donor-key" })).toThrow(/needs your Anthropic API key/);
  });

  it("retired allocations leave the budget and are never picked; their spend history stays", () => {
    const { world, by, seed } = seededWorld();
    const house = world.allocations.first("buildingId = 'carbon-cycle'")!;
    expect(house.label).toBe(HOUSE_LABEL);
    world.budget.charge(by("Mei").id, 1000, 0.5);
    const sent: unknown[] = [];
    world.changes.subscribe((m) => { if (m.type === "building") sent.push(m.building.budget); });
    const r = world.budget.retire(house.id, "Mitchell");
    expect(r).toMatchObject({ retired: true, spentTokens: 1000, spentUsd: 0.5 });
    expect(sent.at(-1)).toEqual({ allocatedTokens: 0, spentTokens: 0, remainingTokens: 0, bankTokens: 0 });
    expect(world.budget.remaining("carbon-cycle")).toBe(0);
    expect(world.budget.pickAllocation("carbon-cycle")).toBeNull();
    expect(world.budget.canStart(by("Mei").id)).toBe(false);
    expect(world.events.list({ types: ["system"] }).at(-1)!.text).toMatch(/Mitchell retired House budget \(placeholder\)/);
    expect(world.budget.retire(house.id)).toMatchObject({ retired: true }); // idempotent
    expect(world.bank.summary().heldTokens).toBe(0);
    const sub = world.budget.donate(seed.admin.id, { tokens: 3000, buildingId: "carbon-cycle", auth: "subscription", label: "Sub" });
    world.budget.donate(seed.admin.id, { tokens: 700, buildingId: "carbon-cycle", auth: "api-key", label: "Buffer" });
    expect(world.budget.remaining("carbon-cycle")).toBe(3700);
    const bank = world.bank.summary();
    expect(bank.heldByAuth).toEqual({ subscription: 3000, apiKey: 700, donorKey: 0 });
    expect(bank.buildings.find((x) => x.buildingId === "carbon-cycle")!.heldByAuth).toEqual({ subscription: 3000, apiKey: 700, donorKey: 0 });
    expect(world.budget.allocationsOf("carbon-cycle").map((a) => a.id)).toContain(sub.id);
  });

  it("retirePlaceholders retires house/placeholder labels, given ids and (opt-in) unlabelled non-donor allocations", () => {
    const { world, seed } = seededWorld();
    const b = createBuilding(world, { name: "Legacy" }, seed.admin.id);
    const legacy = world.budget.donate(seed.admin.id, { tokens: 10, buildingId: b.id });
    const donor = world.ops.createUser("Donor").user;
    const gift = world.budget.donate(donor.id, { tokens: 10, buildingId: b.id, apiKey: "sk-x" });
    const real = world.budget.donate(seed.admin.id, { tokens: 10, buildingId: b.id, auth: "subscription", label: "Mitchell's subscription" });
    const named = world.budget.donate(seed.admin.id, { tokens: 10, buildingId: b.id, auth: "api-key", label: "Old buffer" });
    const dry = world.budget.retirePlaceholders({ dryRun: true });
    expect(dry.map((a) => a.label)).toEqual([HOUSE_LABEL]);
    expect(world.allocations.require(dry[0].id).retired).toBe(false);
    const done = world.budget.retirePlaceholders({ ids: [named.id], unlabelled: true });
    expect(done.map((a) => a.id).sort()).toEqual([dry[0].id, legacy.id, named.id].sort());
    expect(world.allocations.require(gift.id).retired).toBe(false);
    expect(world.allocations.require(real.id).retired).toBe(false);
    expect(world.budget.retirePlaceholders({ unlabelled: true })).toEqual([]);
  });
});
