import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { World, buildingRoleId, townRoleId } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";

describe("agent permissions: inherit the owner, capped by the owner, with denies", () => {
  it("a visitor inherits its manager owner's building.assign; opting out leaves only its own roles", () => {
    const { world } = seededWorld();
    const mgr = world.ops.createUser("Mgr").user;
    world.permissions.grant({ kind: "user", id: mgr.id }, buildingRoleId(LAB, "manager"));
    const v = world.ops.registerVisitor(mgr.id, { name: "Mgr's Claude" }).agent;
    expect(v.inheritsOwner).toBe(true);
    expect(world.permissions.can(v, "building.assign", LAB)).toBe(true);
    expect(world.permissions.can({ kind: "agent", id: v.id }, "building.assign", LAB)).toBe(true);
    expect(world.permissions.effective(v, LAB)).toContain("building.assign");
    const own = world.ops.registerVisitor(mgr.id, { name: "Strict", inheritsOwner: false }).agent;
    expect(own.inheritsOwner).toBe(false);
    expect(world.permissions.can(own, "building.assign", LAB)).toBe(false);
    expect(world.permissions.can(own, "meeting.attend")).toBe(true); // its visitor role
  });

  it("the cap: a plain visitor's agent cannot assign even when granted the role, nor be admin", () => {
    const { world } = seededWorld();
    const plain = world.ops.createUser("Plain").user;
    world.permissions.grant({ kind: "user", id: plain.id }, townRoleId("visitor"));
    const v = world.ops.registerVisitor(plain.id, { name: "Plain's Claude" }).agent;
    world.permissions.grant(v, buildingRoleId(LAB, "reviewer"));
    world.permissions.grant(v, townRoleId("admin"));
    expect(world.permissions.can(v, "building.assign", LAB)).toBe(false);
    expect(world.permissions.can(v, "town.manage_roles")).toBe(false);
    expect(world.permissions.isAdmin(v)).toBe(false);
    expect(world.permissions.can(v, "meeting.attend")).toBe(true); // both hold it
    expect(world.permissions.effective(v, LAB)).toEqual(["meeting.attend"]);
  });

  it("denies remove inherited permissions; only the owner or an admin can set them", () => {
    const { world, admin } = seededWorld();
    const mgr = world.ops.createUser("Mgr").user;
    world.permissions.grant({ kind: "user", id: mgr.id }, buildingRoleId(LAB, "manager"));
    const v = world.ops.registerVisitor(mgr.id, { name: "V" }).agent;
    const stranger = world.ops.ensureAvatar(world.ops.createUser("Stranger").user.id);
    expect(() => world.ops.setAgentPermissions(stranger, v.id, { deniedPermissions: ["building.assign"] })).toThrow(/owner or an admin/);
    expect(() => world.ops.setAgentPermissions(v, v.id, { inheritsOwner: true })).toThrow(/owner or an admin/); // not itself
    const updated = world.ops.setAgentPermissions(world.ops.ensureAvatar(mgr.id), v.id, { deniedPermissions: ["building.assign", "building.assign"] });
    expect(updated.deniedPermissions).toEqual(["building.assign"]);
    expect(world.permissions.can(updated, "building.assign", LAB)).toBe(false);
    expect(world.permissions.can(updated, "building.review", LAB)).toBe(true);
    expect(world.permissions.effective(updated, LAB)).not.toContain("building.assign");
    const off = world.ops.setAgentPermissions(admin, v.id, { inheritsOwner: false });
    expect(world.permissions.can(off, "building.review", LAB)).toBe(false);
    expect(world.agents.require(v.id)).toMatchObject({ inheritsOwner: false, deniedPermissions: ["building.assign"] }); // persisted
  });

  it("residents don't inherit their (admin) owner; ownerless service agents use their own roles", () => {
    const { world, by } = seededWorld();
    const mei = by("Mei");
    expect(mei.inheritsOwner).toBe(false);
    expect(world.permissions.can(mei, "town.manage_roles")).toBe(false);
    expect(world.permissions.can(mei, "doc.write_building", LAB)).toBe(true);
    const ada = by("Ada");
    expect(ada.ownerUserId).toBeNull();
    expect(world.permissions.can(ada, "town.moderate")).toBe(false);
    world.permissions.grant(ada, townRoleId("moderator"));
    expect(world.permissions.can(ada, "town.moderate")).toBe(true);
  });

  it("human avatars inherit their user and keep working", () => {
    const { world, seed, admin } = seededWorld();
    expect(admin.inheritsOwner).toBe(true);
    expect(world.permissions.isAdmin(admin)).toBe(true);
    expect(world.permissions.effective(admin, LAB)).toEqual(world.permissions.effective({ kind: "user", id: seed.admin.id }, LAB));
    const u = world.ops.createUser("Nobody").user;
    expect(world.permissions.can(world.ops.ensureAvatar(u.id), "building.assign", LAB)).toBe(false);
  });

  it("migration 016 backfills inheritsOwner for existing visitors and avatars only", () => {
    const { world, dbPath, by, seed } = seededWorld();
    const v = world.ops.registerVisitor(seed.admin.id, { name: "Old visitor" }).agent;
    const avatarId = world.ops.ensureAvatar(seed.admin.id).id;
    const meiId = by("Mei").id;
    world.close();
    const db = new Database(dbPath);
    db.exec("ALTER TABLE agents DROP COLUMN inheritsOwner; ALTER TABLE agents DROP COLUMN deniedPermissions; DELETE FROM schema_version WHERE version = 16");
    db.close();
    const w = World.open(dbPath);
    try {
      expect(w.agents.require(v.id).inheritsOwner).toBe(true);
      expect(w.agents.require(avatarId).inheritsOwner).toBe(true);
      expect(w.agents.require(meiId)).toMatchObject({ inheritsOwner: false, deniedPermissions: [] });
    } finally { w.close(); }
  });
});
