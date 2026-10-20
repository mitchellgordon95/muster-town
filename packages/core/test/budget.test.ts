import { describe, expect, it } from "vitest";
import { createBuilding, createResident, HOUSE_BUDGET_TOKENS } from "../src/index.ts";
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

  it("building exhaustion stops all residents until a new donation; allocations are charged oldest first", () => {
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
    expect(world.budget.pickAllocation(b.id)!.id).toBe(first.id);
    world.budget.charge(a1.id, 100, 0);
    expect(world.budget.pickAllocation(b.id)!.id).toBe(second.id);
    expect(world.budget.apiKeyFor(second)).toBe("sk-test");
    const r = world.budget.charge(a2.id, 60, 0);
    expect(r.exhausted).toBe("building");
    expect(world.agents.require(a1.id).status).toBe("out-of-budget");
    expect(world.agents.require(a2.id).status).toBe("out-of-budget");
    world.budget.donate(donor.id, { tokens: 1000, buildingId: b.id });
    expect(world.agents.require(a1.id).status).toBe("idle");
    expect(world.budget.canStart(a1.id)).toBe(true);
  });
});
