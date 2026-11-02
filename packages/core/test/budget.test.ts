import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createBuilding, createResident, HOUSE_BUDGET_TOKENS, HOUSE_LABEL, startOfLocalDay, World } from "../src/index.ts";
import { seededWorld, undoTokenCounters } from "./helpers.ts";

describe("budgets", () => {
  it("snapshot buildings carry their budget; charges resend the building with it", () => {
    const { world, by } = seededWorld();
    const snap = world.buildingsWithIntray().find((b) => b.id === "carbon-cycle")!;
    expect(snap.budget).toEqual({ allocatedTokens: HOUSE_BUDGET_TOKENS, spentTokens: 0, remainingTokens: HOUSE_BUDGET_TOKENS, bankTokens: 0, tokensToday: 0, tokensAllTime: 0 });
    const sent: unknown[] = [];
    world.changes.subscribe((m) => { if (m.type === "building") sent.push(m.building.budget); });
    world.budget.charge(by("Mei").id, 1000, 0.5);
    expect(sent.at(-1)).toEqual({ allocatedTokens: HOUSE_BUDGET_TOKENS, spentTokens: 1000, remainingTokens: HOUSE_BUDGET_TOKENS - 1000, bankTokens: 0, tokensToday: 1000, tokensAllTime: 1000 });
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

  it("no per-agent daily cap (1:1 mt_q10xf3bkoq): a resident past dailyTokensPerAgent keeps starting; resetDaily zeroes today", () => {
    const { world, seed } = seededWorld();
    const b = createBuilding(world, { name: "Tiny", dailyTokensPerAgent: 100 }, seed.admin.id);
    const a = createResident(world, { buildingId: b.id, name: "A", title: "t", direction: "d" });
    world.budget.donate(seed.admin.id, { tokens: 10_000, buildingId: b.id });
    const r = world.budget.charge(a.id, 150, 0.01);
    expect(r.exhausted).toBeNull();
    expect(world.agents.require(a.id).status).not.toBe("out-of-budget");
    expect(world.budget.canStart(a.id)).toBe(true);
    expect(world.events.list({ types: ["budget.exhausted"] })).toHaveLength(0);
    world.budget.resetDaily();
    expect(world.agents.require(a.id)).toMatchObject({ spentTokensToday: 0 });
  });

  it("naming a building's manager grants the manager role (so they can assign)", () => {
    const { world, seed } = seededWorld();
    const b = createBuilding(world, { name: "Mgd" }, seed.admin.id);
    const a = createResident(world, { buildingId: b.id, name: "A", title: "t", direction: "d" });
    const w = createResident(world, { buildingId: b.id, name: "W", title: "t", direction: "d" });
    world.ops.updateBuilding(null, b.id, { managerAgentId: a.id });
    expect(world.permissions.can(a, "building.assign", b.id)).toBe(true);
    expect(world.permissions.can(w, "building.assign", b.id)).toBe(false);
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

  it("a dismissed resident stays retired through a building running dry and being refilled (2026-10-31: Root, Sage, Keel, Lena came back)", () => {
    const { world, seed, admin } = seededWorld();
    const b = createBuilding(world, { name: "Dry" }, seed.admin.id);
    const a = createResident(world, { buildingId: b.id, name: "A", title: "t", direction: "d" });
    const gone = createResident(world, { buildingId: b.id, name: "Gone", title: "t", direction: "d" });
    world.budget.donate(seed.admin.id, { tokens: 100, buildingId: b.id });
    world.ops.dismissAgent(admin, gone.id);
    expect(world.agents.require(gone.id).status).toBe("retired");
    const r = world.budget.charge(a.id, 150, 0);
    expect(r.exhausted).toBe("building");
    expect(world.agents.require(a.id).status).toBe("out-of-budget");
    expect(world.agents.require(gone.id).status).toBe("retired");
    world.budget.donate(seed.admin.id, { tokens: 1000, buildingId: b.id });
    world.budget.resumeEligible(b.id);
    world.budget.resetDaily();
    expect(world.agents.require(a.id).status).toBe("idle");
    expect(world.agents.require(gone.id).status).toBe("retired");
    expect(world.events.list({ types: ["agent.status"] }).filter((e) => e.agentId === gone.id).map((e) => e.payload.status)).toEqual(["retired"]);
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
    expect(sent.at(-1)).toEqual({ allocatedTokens: 0, spentTokens: 0, remainingTokens: 0, bankTokens: 0, tokensToday: 1000, tokensAllTime: 1000 });
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

describe("token usage per building (today and all-time)", () => {
  it("counts every charge for the agent's home building; 'today' starts at local midnight", () => {
    const { world, by, seed } = seededWorld();
    const lab2 = createBuilding(world, { name: "Lab 2" }, seed.admin.id);
    const other = createResident(world, { buildingId: lab2.id, name: "O", title: "t", direction: "d" });
    world.budget.donate(seed.admin.id, { tokens: 10_000, buildingId: lab2.id });
    world.budget.charge(by("Mei").id, 1000, 0.5);
    world.budget.charge(by("Mei").id, 234.4, 0.1);
    world.budget.charge(other.id, 50, 0.01);
    expect(world.budget.usage("carbon-cycle")).toEqual({ tokensToday: 1234, tokensAllTime: 1234 });
    expect(world.budget.usage(lab2.id)).toEqual({ tokensToday: 50, tokensAllTime: 50 });
    // tomorrow: nothing used yet today, all-time unchanged
    const tomorrow = new Date(Date.now() + 86_400_000);
    expect(world.budget.usage("carbon-cycle", tomorrow)).toEqual({ tokensToday: 0, tokensAllTime: 1234 });
    // and the snapshot / summary carry it
    expect(world.buildingsWithIntray().find((b) => b.id === "carbon-cycle")!.budget).toMatchObject({ tokensToday: 1234, tokensAllTime: 1234 });
    expect(world.budget.summary().buildings.find((b) => b.buildingId === lab2.id)).toMatchObject({ tokensToday: 50, tokensAllTime: 50 });
  });

  it("recordUsage counts unfunded usage (no allocation drawn) and still bumps the agent's counters", () => {
    const { world, by } = seededWorld();
    const mei = by("Mei");
    const before = world.budget.of("carbon-cycle");
    const a = world.budget.recordUsage(mei.id, 300, 0.2);
    expect(a).toMatchObject({ spentTokensToday: 300, spentTokensTotal: 300 });
    expect(world.budget.of("carbon-cycle")).toEqual({ ...before, tokensToday: 300, tokensAllTime: 300 });
    expect(() => world.budget.recordUsage(mei.id, -1, 0)).toThrow();
  });

  it("startOfLocalDay is the local midnight at or before the instant", () => {
    const d = new Date(2026, 9, 21, 13, 45, 7);
    expect(new Date(startOfLocalDay(d)).getTime()).toBe(new Date(2026, 9, 21).getTime());
  });

  it("migration 024 back-fills the ledger from agents' counters (before today + today)", () => {
    const { world, dbPath, by } = seededWorld();
    const mei = by("Mei");
    world.close();
    const db = new Database(dbPath);
    undoTokenCounters(db); // 034 runs again after 024, and back-fills the ledger's counters
    db.exec("DROP TABLE usage");
    db.prepare("UPDATE agents SET spentTokensTotal = 5000, spentTokensToday = 700, spentUsdTotal = 2 WHERE id = ?").run(mei.id);
    db.prepare("DELETE FROM schema_version WHERE version = 24").run();
    db.close();
    const w = World.open(dbPath);
    try {
      // 037 books the ledger in adjusted output tokens: 700 raw today → 16 output + 684 cache read → 23; 4300 → 143
      expect(w.budget.usage("carbon-cycle")).toEqual({ tokensToday: 23, tokensAllTime: 166 });
      // 4300 before today, split by the back-fill rule (Opus): output = round(4300 × (1/30 − 0.01) / 0.99) = 101
      expect(w.db.prepare("SELECT input, output, cacheRead, rawTokens, tokens FROM usage WHERE id = ?").get(`us-backfill-${mei.id}`)).toMatchObject({ input: 0, output: 101, cacheRead: 4199, rawTokens: 4300, tokens: 143 });
    } finally {
      w.close();
    }
  });
});
