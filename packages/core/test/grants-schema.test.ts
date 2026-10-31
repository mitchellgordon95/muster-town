import Database from "better-sqlite3";
import { copyFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { World, buildingRoleId, migrate, migrateRoles, newId, nowIso, townRoleId } from "../src/index.ts";
import { freshWorld, seededWorld, tempDir } from "./helpers.ts";

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

  it("the daily inflow is the Bank's recurring inputs per day", () => {
    const { world, seed } = seededWorld();
    world.bank.addInput(seed.admin.id, { label: "Sub", source: "subscription", token: "sk-ant-oat01-test-token", model: "m", tokens: 20_000_000, recurrence: "daily", weeklyCapTokens: 140_000_000 });
    expect(world.bank.dailyInflow()).toBe(20_000_000);
  });
});

describe("goal budget settings (the optional exploration cap lives on the goal)", () => {
  it("a new building's goal sets no exploration cap: uncapped", () => {
    const { world, admin } = seededWorld();
    const b = world.ops.createBuilding(admin, { name: "New lab" });
    expect(world.grantDesk.exploration(b.id).cap).toBeNull();
  });

  it("exploreCapTokensPerDay on a goal needs a human funder: an admin or the goal's owner yes, an agent manager no", () => {
    const { world, admin } = seededWorld();
    const goal = world.goalTree.create(null, { parentId: "gl_town", text: "Owned" });
    world.goalTree.attach(null, LAB, goal.id);
    const owner = world.ops.createUser("Owner").user;
    world.goalTree.update(admin, goal.id, { ownerId: owner.id });
    const avatar = world.ops.ensureAvatar(owner.id);
    expect(world.goalTree.update(avatar, goal.id, { exploreCapTokensPerDay: 1_500_000 }).exploreCapTokensPerDay).toBe(1_500_000);
    expect(world.grantDesk.exploration(LAB).cap).toEqual({ tokensPerDay: 1_500_000, goalId: goal.id, spentTodayTokens: 0 });
    const resident = world.agents.first("homeBuildingId = ? AND kind = 'resident'", [LAB])!;
    world.permissions.grant(resident, buildingRoleId(LAB, "manager"));
    expect(() => world.goalTree.update(resident, goal.id, { exploreCapTokensPerDay: 9_000_000 })).toThrow(/owner of|building.fund/);
    expect(world.events.list({ types: ["goal.edited"] }).some((e) => e.payload.goalId === goal.id && e.payload.exploreCapTokensPerDay === 1_500_000)).toBe(true);
    void World;
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

  it("migration 069: grants carry their key results; open goal key results with no open grant are dropped", () => {
    const dir = tempDir(), migrations = join(dir, "migrations");
    mkdirSync(migrations);
    const all = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
    for (const f of readdirSync(all).filter((f) => f.endsWith(".sql") && Number(f.slice(0, 3)) <= 68)) copyFileSync(join(all, f), join(migrations, f));
    const db = new Database(join(dir, "town.db"));
    migrate(db, migrations);
    const now = "2026-10-30T00:00:00.000Z";
    db.prepare("INSERT INTO buildings (id, name, kind, headcount, createdAt, goalId) VALUES ('bl_a', 'Lab A', 'lab', 3, ?, 'gl_town')").run(now);
    const kr = db.prepare("INSERT INTO key_results (id, buildingId, position, text, howToCheck, status, goalId, updatedAt) VALUES (?, 'bl_a', ?, ?, 'h', ?, 'gl_town', ?)");
    kr.run("kr_named", 0, "Named by a funded grant", "on-track", now);
    kr.run("kr_orphan", 1, "Nobody works on it", "not-started", now);
    kr.run("kr_met", 2, "Done long ago", "met", now);
    const grant = db.prepare("INSERT INTO grants (id, buildingId, keyResultId, objective, stopCondition, askTokens, status, testingPlan, proposedBy, createdAt, updatedAt) VALUES (?, 'bl_a', ?, ?, 's', 1000, ?, ?, 'ag_x', ?, ?)");
    grant.run("gr_live", "kr_named", "Live plan", "funded", JSON.stringify([{ text: "Banner shows Usage", howToCheck: "Open the banner" }]), now, now);
    grant.run("gr_bare", null, "A plan with no key result", "proposed", "[]", now, now);
    const asg = db.prepare("INSERT INTO assignments (id, agentId, buildingId, title, description, status, createdBy, createdByKind, createdAt, updatedAt, lane, keyResultId, grantId) VALUES (?, 'ag_x', 'bl_a', 't', 'd', ?, 'system', 'system', ?, ?, ?, ?, ?)");
    asg.run("as_e", "pending", now, now, "exploration", "kr_orphan", null);
    asg.run("as_g", "pending", now, now, "grant", "kr_named", "gr_live");
    copyFileSync(join(all, "069_grants_carry_key_results.sql"), join(migrations, "069_grants_carry_key_results.sql"));
    migrate(db, migrations);
    const krs = db.prepare("SELECT id, text, howToCheck, grantId, goalId, status, archivedAt IS NOT NULL AS archived, statusNote FROM key_results ORDER BY position, rowid").all() as Record<string, unknown>[];
    // the funded grant keeps its key result and gains its testing plan line as a second one
    expect(krs.filter((k) => k.grantId === "gr_live").map((k) => [k.text, k.howToCheck, k.archived])).toEqual([["Named by a funded grant", "h", 0], ["Banner shows Usage", "Open the banner", 0]]);
    expect(db.prepare("SELECT goalId, keyResultId, testingPlan FROM grants WHERE id = 'gr_live'").get()).toEqual({ goalId: "gl_town", keyResultId: "kr_named", testingPlan: "[]" });
    // an open grant with none gets one from its objective
    const bare = db.prepare("SELECT keyResultId FROM grants WHERE id = 'gr_bare'").get() as { keyResultId: string };
    expect(krs.find((k) => k.id === bare.keyResultId)).toMatchObject({ text: "A plan with no key result", howToCheck: "s", grantId: "gr_bare", archived: 0 });
    // the orphan open KR is dropped (archived, text kept); a met one is left as it was
    expect(krs.find((k) => k.id === "kr_orphan")).toMatchObject({ grantId: null, archived: 1, status: "not-started", statusNote: expect.stringMatching(/^dropped when key results merged into grants/) });
    expect(krs.find((k) => k.id === "kr_met")).toMatchObject({ status: "met", statusNote: "" });
    // exploration that named it keeps its words as a gap; grant work keeps its key result
    expect(db.prepare("SELECT id, keyResultId, gap FROM assignments ORDER BY id").all()).toEqual([
      { id: "as_e", keyResultId: null, gap: "Nobody works on it" }, { id: "as_g", keyResultId: "kr_named", gap: null },
    ]);
  });
});
