import { describe, expect, it } from "vitest";
import { BUILTIN_ROLES, Permission } from "@muster-town/schema";
import { buildingRoleId, createBuilding, townRoleId } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

describe("permissions", () => {
  it("built-in roles exist with the schema's permissions", () => {
    const { world } = seededWorld();
    expect(world.roles.require(townRoleId("admin")).permissions).toEqual(Permission.options);
    expect(world.roles.require(townRoleId("visitor")).permissions).toEqual(BUILTIN_ROLES.town.visitor);
    expect(world.roles.require(townRoleId("moderator")).permissions).toEqual(BUILTIN_ROLES.town.moderator);
    for (const name of ["manager", "reviewer", "member"] as const) {
      const r = world.roles.require(buildingRoleId("carbon-cycle", name));
      expect(r).toMatchObject({ scope: "building", buildingId: "carbon-cycle", builtin: true });
      expect(r.permissions).toEqual(BUILTIN_ROLES.building[name]);
    }
  });

  it("admin can everything everywhere; members only in their building; scope is respected", () => {
    const { world, by, seed } = seededWorld();
    const other = createBuilding(world, { name: "Other" }, null);
    const admin = { kind: "user" as const, id: seed.admin.id };
    expect(world.permissions.can(admin, "town.approve_trophy")).toBe(true);
    expect(world.permissions.can(admin, "building.review", other.id)).toBe(true);
    const mei = by("Mei");
    expect(world.permissions.can(mei, "doc.write_building", "carbon-cycle")).toBe(true);
    expect(world.permissions.can(mei, "doc.write_building", other.id)).toBe(false);
    expect(world.permissions.can(mei, "building.review", "carbon-cycle")).toBe(false);
    expect(world.permissions.can(mei, "doc.write_building")).toBe(false); // building scope needs a buildingId
    const moss = by("Moss");
    expect(world.permissions.can(moss, "building.review", "carbon-cycle")).toBe(true);
    expect(world.permissions.can(moss, "building.review", other.id)).toBe(false);
    expect(() => world.permissions.require(mei, "building.dismiss", "carbon-cycle")).toThrow(expect.objectContaining({ code: "forbidden", permission: "building.dismiss" }));
  });

  it("creator gets manager; human avatars act with their user's roles; role assignment is permissioned", () => {
    const { world, seed } = seededWorld();
    const u = world.ops.createUser("Builder").user;
    world.ops.assignRole(null, { roleId: townRoleId("admin"), holderKind: "user", holderId: u.id });
    const b = world.ops.createBuilding(world.ops.ensureAvatar(u.id), { name: "Builder Lab" });
    expect(world.permissions.can({ kind: "user", id: u.id }, "building.manage", b.id)).toBe(true);
    // the creator, and the starter resident named manager (managerAgentId grants the role)
    const managers = world.memberships.forRole(buildingRoleId(b.id, "manager"));
    expect(managers).toHaveLength(2);
    expect(managers).toContainEqual({ roleId: buildingRoleId(b.id, "manager"), holderKind: "user", holderId: u.id });
    expect(managers).toContainEqual({ roleId: buildingRoleId(b.id, "manager"), holderKind: "agent", holderId: world.buildings.require(b.id).managerAgentId });
    const nobody = world.ops.ensureAvatar(world.ops.createUser("Nobody").user.id);
    expect(() => world.ops.createBuilding(nobody, { name: "x" })).toThrow(/manage_buildings/);
    expect(() => world.ops.assignRole(nobody, { roleId: buildingRoleId(b.id, "reviewer"), holderKind: "user", holderId: nobody.ownerUserId! })).toThrow(/building.manage/);
    // the lab manager (admin) can grant building roles in the lab
    world.ops.assignRole(world.ops.ensureAvatar(seed.admin.id), { roleId: buildingRoleId("carbon-cycle", "reviewer"), holderKind: "user", holderId: nobody.ownerUserId! });
    expect(world.permissions.can(nobody, "building.review", "carbon-cycle")).toBe(true);
    world.ops.unassignRole(null, { roleId: buildingRoleId("carbon-cycle", "reviewer"), holderKind: "user", holderId: nobody.ownerUserId! });
    expect(world.permissions.can(nobody, "building.review", "carbon-cycle")).toBe(false);
  });

  it("tokens resolve to users and agents", () => {
    const { world, seed, by } = seededWorld();
    expect(world.tokens.resolve(seed.adminToken)).toMatchObject({ kind: "user", id: seed.admin.id });
    const t = world.tokens.getOrCreate("agent", by("Mei").id);
    expect(world.tokens.getOrCreate("agent", by("Mei").id)).toBe(t);
    expect(world.tokens.resolve(t)).toMatchObject({ kind: "agent", id: by("Mei").id });
    expect(world.tokens.resolve("nope")).toBeUndefined();
  });
});
