/** v1.3: the `deployer` town role, who holds town.redeploy (no agent), the workshop data fix, and old merge keys. */
import { join } from "node:path";
import Database from "better-sqlite3";
import { BUILTIN_ROLES } from "@muster-town/schema";
import { describe, expect, it } from "vitest";
import { createResident, townRoleId, World } from "../src/index.ts";
import { freshWorld, REPO_ROOT, seededWorld } from "./helpers.ts";

const WORKSHOP = join(REPO_ROOT, "collectives/workshop/collective.json");

describe("deployer role + redeploy verb", () => {
  it("the deployer role holds town.redeploy and town.interact (dc_f0cumcfubk); admin has it too", () => {
    const { world, admin } = seededWorld();
    expect(world.roles.require(townRoleId("deployer"))).toMatchObject({ name: "deployer", scope: "town", builtin: true, permissions: ["town.redeploy", "town.interact"] });
    expect(BUILTIN_ROLES.town.deployer).toEqual(["town.redeploy", "town.interact"]);
    expect(world.permissions.can(admin, "town.redeploy")).toBe(true);
  });

  it("an agent never holds town.redeploy, even with the deployer role; a user with the deployer role does (1:1 mt_vdu3iqhasi)", () => {
    const { world, by, seed } = seededWorld();
    const noor = by("Noor");
    world.permissions.grant(noor, townRoleId("deployer"));
    expect(world.permissions.can(noor, "town.redeploy")).toBe(false);
    expect("redeploy" in world.verbs).toBe(false);
    expect(world.permissions.can({ kind: "user", id: seed.admin.id }, "town.redeploy")).toBe(true);
  });

  it("seed grants the manager's townRoles from collective.json (the Workshop's manager is a deployer, the Planner isn't)", () => {
    const { world } = freshWorld();
    world.seedDefaults({ collectivePath: WORKSHOP });
    const roles = (a: { id: string }) => world.permissions.rolesOf({ kind: "agent", id: a.id }).map((r) => r.name);
    expect(roles(world.agents.first("name = 'Pix'")!)).toContain("deployer");
    expect(roles(world.reorgs.planner()!)).not.toContain("deployer");
  });
});

describe("v1.3 data fix on open", () => {
  /** A workshop DB from before v1.3: no deployer role, no memberships. */
  function preV13(): string {
    const { world, dbPath } = freshWorld();
    world.seedDefaults({ collectivePath: WORKSHOP });
    createResident(world, { buildingId: "workshop", name: "Root" });
    createResident(world, { buildingId: "workshop", name: "Sage" });
    world.close();
    const db = new Database(dbPath);
    db.prepare("DELETE FROM memberships WHERE roleId = 'role:deployer'").run();
    db.prepare("DELETE FROM roles WHERE id = 'role:deployer'").run();
    db.prepare("UPDATE agents SET status = 'retired' WHERE name = 'Sage'").run();
    db.close();
    return dbPath;
  }

  it("creates the deployer role once and grants it to current workshop residents (not retired, not the Planner)", () => {
    const dbPath = preV13();
    let w = World.open(dbPath);
    const can = (name: string) => w.permissions.rolesOf(w.agents.first("name = ?", [name])!).some((r) => r.name === "deployer");
    expect(w.roles.require(townRoleId("deployer")).permissions).toEqual(["town.redeploy", "town.interact"]);
    expect([can("Pix"), can("Root"), can("Sage"), can("Planner")]).toEqual([true, true, false, false]);
    // a revoke sticks across reopen: the grant only runs in the pass that creates the role
    w.permissions.revoke(w.agents.first("name = 'Root'")!, townRoleId("deployer"));
    w.close();
    w = World.open(dbPath);
    expect(can("Root")).toBe(false);
    w.close();
  });

  it("migration 022 lifts a building's workspace to the collective repo and gives that building code access", () => {
    const { world, dbPath } = freshWorld();
    world.seedDefaults({ collectivePath: WORKSHOP });
    world.close();
    const db = new Database(dbPath);
    const ws = { path: "/srv/agent-town", base: "main", branchPrefix: "agent", repoUrl: "git@github.com:o/agent-town.git", merge: "green" };
    db.prepare("UPDATE buildings SET workspace = ? WHERE id = 'workshop'").run(JSON.stringify(ws));
    db.prepare("UPDATE meta SET value = json_remove(value, '$.workspace') WHERE key = 'town'").run();
    db.exec("ALTER TABLE buildings DROP COLUMN codeAccess");
    db.prepare("DELETE FROM schema_version WHERE version = 22").run();
    db.close();
    const w = World.open(dbPath);
    const town = w.town.get().workspace as Record<string, unknown>;
    expect(town.repoUrl).toBe(ws.repoUrl);
    expect("merge" in town).toBe(false);
    expect(w.buildings.require("workshop").codeAccess).toBe(true);
    expect(w.buildings.first("kind = 'town-hall'")!.codeAccess).toBe(false);
    w.close();
  });
});
