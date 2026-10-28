import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
    expect(b.explorationTokensPerDay).toBeNull();
    const now = nowIso();
    const g = world.grants.upsert({
      id: newId("gr"), buildingId: LAB, objective: "Visitors can tell what the lab is for", stopCondition: "two failed attempts",
      askTokens: 10_000_000, status: "draft", proposedBy: "ag_x", history: [{ at: now, byId: "ag_x", byKind: "agent", action: "propose", tokens: 10_000_000, note: "" }],
      createdAt: now, updatedAt: now,
    } as never);
    world.keyResults.upsert({ id: newId("kr"), buildingId: LAB, position: 0, text: "Banner shows purpose", howToCheck: "Open the lab", updatedAt: now } as never);
    expect(world.grants.require(g.id)).toMatchObject({ keyResultId: null, approach: "", testingPlan: [] });
    expect(world.grants.require(g.id).history[0].action).toBe("propose");
    expect(world.keyResults.where("buildingId = ?", [LAB])[0].status).toBe("not-started");
    expect(b.blockedAt).toBeNull();
    const agent = world.agents.first("homeBuildingId = ?", [LAB])!;
    for (const tokens of [1000, 2500]) {
      world.sessions.upsert({ id: newId("se"), agentId: agent.id, assignmentId: null, purpose: "work", status: "done", model: "m", output: tokens, startedAt: now, lane: "grant", grantId: g.id } as never);
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
  it("a new building has the default exploration allowance", () => {
    const { world, admin } = seededWorld();
    const b = world.ops.createBuilding(admin, { name: "New lab" });
    expect(b.explorationTokensPerDay).toBeNull();
  });

  it("explorationTokensPerDay and forks need building.fund: a human manager yes, an agent manager no", () => {
    const { world, by } = seededWorld();
    const mgr = world.ops.createUser("Mgr").user;
    world.permissions.grant({ kind: "user", id: mgr.id }, buildingRoleId(LAB, "manager"));
    const avatar = world.ops.ensureAvatar(mgr.id);
    const b = world.ops.updateBuilding(avatar, LAB, { explorationTokensPerDay: 1_500_000, forks: true });
    expect(b.explorationTokensPerDay).toBe(1_500_000);
    expect(b.forks).toBe(true);
    const resident = world.agents.first("homeBuildingId = ? AND kind = 'resident'", [LAB])!;
    world.permissions.grant(resident, buildingRoleId(LAB, "manager"));
    expect(() => world.ops.updateBuilding(resident, LAB, { explorationTokensPerDay: 9_000_000 })).toThrow(/building.fund/);
    expect(world.ops.updateBuilding(resident, LAB, { goal: "new goal" }).goal).toBe("new goal");
    void by; void World;
  });
});

describe("migration 032: key results move onto the building goal", () => {
  it("a grant's old key results become its testing plan; assignments that named one keep it as a gap (exploration) or drop it", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE buildings (id TEXT PRIMARY KEY);
      CREATE TABLE grants (id TEXT PRIMARY KEY, buildingId TEXT NOT NULL);
      CREATE TABLE key_results (id TEXT PRIMARY KEY, grantId TEXT NOT NULL, position INTEGER NOT NULL, text TEXT NOT NULL, howToCheck TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'not-started', statusNote TEXT NOT NULL DEFAULT '', statusBy TEXT, updatedAt TEXT NOT NULL);
      CREATE TABLE assignments (id TEXT PRIMARY KEY, lane TEXT NOT NULL, grantId TEXT, keyResultId TEXT, gap TEXT);
      INSERT INTO buildings VALUES ('workshop');
      INSERT INTO grants VALUES ('gr_a', 'workshop'), ('gr_b', 'workshop');
      INSERT INTO key_results (id, grantId, position, text, howToCheck, status, updatedAt) VALUES
        ('kr_2', 'gr_a', 1, 'One explicit blocker', 'Open the board', 'on-track', 't'),
        ('kr_1', 'gr_a', 0, 'Works autonomously', 'Watch a day', 'not-started', 't');
      INSERT INTO assignments VALUES ('as_g', 'grant', 'gr_a', 'kr_1', NULL), ('as_e', 'exploration', NULL, 'kr_2', NULL), ('as_d', 'directed', NULL, NULL, NULL);`);
    db.exec(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "migrations", "032_goal_key_results.sql"), "utf8"));
    const grants = db.prepare("SELECT id, keyResultId, approach, testingPlan FROM grants ORDER BY id").all() as { id: string; keyResultId: string | null; approach: string; testingPlan: string }[];
    expect(grants.map((g) => ({ ...g, testingPlan: JSON.parse(g.testingPlan) }))).toEqual([
      { id: "gr_a", keyResultId: null, approach: "", testingPlan: [{ text: "Works autonomously", howToCheck: "Watch a day" }, { text: "One explicit blocker", howToCheck: "Open the board" }] },
      { id: "gr_b", keyResultId: null, approach: "", testingPlan: [] },
    ]);
    expect(db.prepare("SELECT id, keyResultId, gap FROM assignments ORDER BY id").all()).toEqual([
      { id: "as_d", keyResultId: null, gap: null }, { id: "as_e", keyResultId: null, gap: "One explicit blocker" }, { id: "as_g", keyResultId: null, gap: null },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM key_results").get()).toEqual({ n: 0 });
    expect((db.prepare("PRAGMA table_info(key_results)").all() as { name: string }[]).map((c) => c.name)).toContain("buildingId");
    expect((db.prepare("PRAGMA table_info(buildings)").all() as { name: string }[]).map((c) => c.name)).toContain("blockedAt");
  });
});
