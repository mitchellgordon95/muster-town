/** v1.3: the `deployer` town role, the `redeploy` verb's permission check, the workshop data fix, and old merge keys. */
import { join } from "node:path";
import Database from "better-sqlite3";
import { BUILTIN_ROLES } from "@agent-town/schema";
import { describe, expect, it, vi } from "vitest";
import { townRoleId, World } from "../src/index.ts";
import { freshWorld, REPO_ROOT, seededWorld } from "./helpers.ts";

const WORKSHOP = join(REPO_ROOT, "collectives/workshop/collective.json");

describe("deployer role + redeploy verb", () => {
  it("the deployer role holds only town.redeploy; admin has it too", () => {
    const { world, admin } = seededWorld();
    expect(world.roles.require(townRoleId("deployer"))).toMatchObject({ name: "deployer", scope: "town", builtin: true, permissions: ["town.redeploy"] });
    expect(BUILTIN_ROLES.town.deployer).toEqual(["town.redeploy"]);
    expect(world.permissions.can(admin, "town.redeploy")).toBe(true);
  });

  it("redeploy needs town.redeploy, then calls the host hook with the actor's name", async () => {
    const { world, by } = seededWorld();
    const noor = by("Noor");
    const hook = vi.fn(() => ({ started: true }));
    world.host.redeploy = hook;
    await expect(world.verbs.redeploy(noor.id, {})).rejects.toThrow(/town\.redeploy/);
    expect(hook).not.toHaveBeenCalled();
    world.permissions.grant(noor, townRoleId("deployer"));
    expect(await world.verbs.redeploy(noor.id, { image: true })).toEqual({ started: true });
    expect(hook).toHaveBeenCalledWith({ image: true, requestedBy: "Noor" });
  });

  it("without a runtime the verb says redeploy is unavailable", async () => {
    const { world, by } = seededWorld();
    const noor = by("Noor");
    world.permissions.grant(noor, townRoleId("deployer"));
    await expect(world.verbs.redeploy(noor.id, {})).rejects.toThrow(/unavailable/);
  });

  it("seed grants townRoles from collective.json (workshop residents are deployers, the reviewer isn't)", () => {
    const { world } = freshWorld();
    world.seedDefaults({ collectivePath: WORKSHOP });
    for (const name of ["Pix", "Root", "Sage"]) expect(world.permissions.can(world.agents.first("name = ?", [name])!, "town.redeploy")).toBe(true);
    expect(world.permissions.can(world.agents.first("name = 'Keel'")!, "town.redeploy")).toBe(false);
  });
});

describe("v1.3 data fix on open", () => {
  /** A workshop DB from before v1.3: no deployer role, no memberships, merge/checks inside the workspace JSON. */
  function preV13(): string {
    const { world, dbPath } = freshWorld();
    world.seedDefaults({ collectivePath: WORKSHOP });
    world.close();
    const db = new Database(dbPath);
    db.prepare("DELETE FROM memberships WHERE roleId = 'role:deployer'").run();
    db.prepare("DELETE FROM roles WHERE id = 'role:deployer'").run();
    const ws = JSON.parse((db.prepare("SELECT workspace FROM buildings WHERE id = 'workshop'").get() as { workspace: string }).workspace);
    db.prepare("UPDATE buildings SET workspace = ? WHERE id = 'workshop'").run(JSON.stringify({ ...ws, merge: "green", checks: ["npm test"] }));
    db.prepare("UPDATE agents SET status = 'retired' WHERE name = 'Sage'").run();
    db.close();
    return dbPath;
  }

  it("creates the deployer role once and grants it to current workshop residents (not retired, not the reviewer)", () => {
    const dbPath = preV13();
    let w = World.open(dbPath);
    const can = (name: string) => w.permissions.can(w.agents.first("name = ?", [name])!, "town.redeploy");
    expect(w.roles.require(townRoleId("deployer")).permissions).toEqual(["town.redeploy"]);
    expect([can("Pix"), can("Root"), can("Sage"), can("Keel")]).toEqual([true, true, false, false]);
    // a revoke sticks across reopen: the grant only runs in the pass that creates the role
    w.permissions.revoke(w.agents.first("name = 'Root'")!, townRoleId("deployer"));
    w.close();
    w = World.open(dbPath);
    expect(can("Root")).toBe(false);
    w.close();
  });

  it("old merge/checks keys in a building's workspace JSON are stripped on read", () => {
    const w = World.open(preV13());
    const ws = w.buildings.require("workshop").workspace as Record<string, unknown>;
    expect(ws.base).toBe("main");
    expect("merge" in ws).toBe(false);
    expect("checks" in ws).toBe(false);
    w.close();
  });
});
