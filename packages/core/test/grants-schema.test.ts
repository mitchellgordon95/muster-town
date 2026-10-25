import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { World, buildingRoleId, migrateRoles, newId, nowIso, townRoleId } from "../src/index.ts";
import { freshWorld, seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";

describe("goal-directed budgets, step 1 foundation", () => {
  it("building.fund: admins and human building managers hold it; agents never do, whatever their roles", () => {
    const { world, seed, admin } = seededWorld();
    expect(world.permissions.can({ kind: "user", id: seed.admin.id }, "building.fund", LAB)).toBe(true);
    expect(world.permissions.can(admin, "building.fund", LAB)).toBe(true); // a human avatar acts as its user
    const mgr = world.ops.createUser("Mgr").user;
    world.permissions.grant({ kind: "user", id: mgr.id }, buildingRoleId(LAB, "manager"));
    expect(world.permissions.can({ kind: "user", id: mgr.id }, "building.fund", LAB)).toBe(true);
    expect(world.permissions.can({ kind: "user", id: mgr.id }, "building.fund", "elsewhere")).toBe(false);
    // an agent manager owned by the admin, inheriting: still no
    const v = world.ops.registerVisitor(seed.admin.id, { name: "Admin's Claude" }).agent;
    world.permissions.grant(v, buildingRoleId(LAB, "manager"));
    world.permissions.grant(v, townRoleId("admin"));
    expect(world.permissions.can(v, "building.manage", LAB)).toBe(true);
    expect(world.permissions.can(v, "building.fund", LAB)).toBe(false);
    expect(world.permissions.can({ kind: "agent", id: v.id }, "building.fund", LAB)).toBe(false);
    expect(world.permissions.effective(v, LAB)).not.toContain("building.fund");
  });

  it("migrateRoles gives existing built-in managers building.fund (idempotent)", () => {
    const { world, dbPath } = freshWorld();
    world.seedDefaults({});
    const id = buildingRoleId("workshop-x", "manager");
    world.db.prepare("INSERT INTO roles (id, name, scope, buildingId, permissions, builtin) VALUES (?, 'manager', 'building', 'workshop-x', ?, 1)")
      .run(id, JSON.stringify(["building.manage", "building.dismiss"]));
    world.close();
    const db = new Database(dbPath);
    expect(migrateRoles(db).updated).toBe(1);
    expect(migrateRoles(db).updated).toBe(0);
    expect(JSON.parse((db.prepare("SELECT permissions FROM roles WHERE id = ?").get(id) as { permissions: string }).permissions)).toContain("building.fund");
    db.close();
  });

  it("grants, key results, and the new building/session columns round-trip; spend derives from sessions", () => {
    const { world } = seededWorld();
    const b = world.buildings.require(LAB);
    expect(b.budgetMode).toBe("goal-directed"); // the default for new buildings (town hall 2026-10-25)
    expect(b.explorationTokensPerDay).toBeNull();
    const now = nowIso();
    const g = world.grants.upsert({
      id: newId("gr"), buildingId: LAB, objective: "Visitors can tell what the lab is for", stopCondition: "two failed attempts",
      askTokens: 10_000_000, status: "draft", proposedBy: "ag_x", history: [{ at: now, byId: "ag_x", byKind: "agent", action: "propose", tokens: 10_000_000, note: "" }],
      createdAt: now, updatedAt: now,
    } as never);
    world.keyResults.upsert({ id: newId("kr"), grantId: g.id, position: 0, text: "Banner shows purpose", howToCheck: "Open the lab", updatedAt: now } as never);
    expect(world.grants.require(g.id).history[0].action).toBe("propose");
    expect(world.keyResults.where("grantId = ?", [g.id])[0].status).toBe("not-started");
    const agent = world.agents.first("homeBuildingId = ?", [LAB])!;
    for (const tokens of [1000, 2500]) {
      world.sessions.upsert({ id: newId("se"), agentId: agent.id, assignmentId: null, purpose: "work", status: "done", model: "m", tokens, startedAt: now, lane: "grant", grantId: g.id } as never);
    }
    expect(world.sessions.sum("tokens", "grantId = ?", [g.id])).toBe(3500);
  });

  it("a pool's daily inflow is its share of the Bank's recurring inputs", () => {
    const { world, seed } = seededWorld();
    world.bank.addInput(seed.admin.id, { label: "Sub", source: "subscription", model: "m", tokens: 20_000_000, recurrence: "daily", weeklyCapTokens: 140_000_000 });
    expect(world.bank.dailyInflow()).toBe(20_000_000);
    expect(world.bank.poolDailyInflow("general")).toBe(20_000_000);
  });
});

describe("building budget settings", () => {
  it("a new building is goal-directed with the default exploration allowance; the Town Hall stays open", () => {
    const { world, admin } = seededWorld();
    const b = world.ops.createBuilding(admin, { name: "New lab" });
    expect(b.budgetMode).toBe("goal-directed");
    expect(b.explorationTokensPerDay).toBeNull();
    expect(world.buildings.first("kind = 'town-hall'")!.budgetMode).toBe("open");
  });

  it("explorationTokensPerDay and budgetMode need building.fund: a human manager yes, an agent manager no", () => {
    const { world, by } = seededWorld();
    const mgr = world.ops.createUser("Mgr").user;
    world.permissions.grant({ kind: "user", id: mgr.id }, buildingRoleId(LAB, "manager"));
    const avatar = world.ops.ensureAvatar(mgr.id);
    const b = world.ops.updateBuilding(avatar, LAB, { explorationTokensPerDay: 1_500_000, budgetMode: "goal-directed" });
    expect(b.explorationTokensPerDay).toBe(1_500_000);
    expect(b.budgetMode).toBe("goal-directed");
    const resident = world.agents.first("homeBuildingId = ? AND kind = 'resident'", [LAB])!;
    world.permissions.grant(resident, buildingRoleId(LAB, "manager"));
    expect(() => world.ops.updateBuilding(resident, LAB, { explorationTokensPerDay: 9_000_000 })).toThrow(/building.fund/);
    expect(world.ops.updateBuilding(resident, LAB, { goal: "new goal" }).goal).toBe("new goal");
    void by; void World;
  });
});
