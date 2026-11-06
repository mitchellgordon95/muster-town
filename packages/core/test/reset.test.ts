import { describe, expect, it } from "vitest";
import { accessRequestOf, buildingRoleId, canInteract, decideAccess, directGrantsOf, grantDirect, holderOf, pendingCaptainRequests, requestAccess, requestCaptain, resetOwnAccount, townRoleId } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

// Self-service role reset (dc_ia2hybtuax): the test account goes back to a never-granted stranger after a live check.
function setup() {
  const s = seededWorld();
  const { world, admin } = s;
  const { user: u } = world.ops.createUser("Tess");
  world.permissions.grant({ kind: "user", id: u.id }, townRoleId("visitor"));
  const goal = world.goalTree.create(admin, { parentId: "gl_trust", text: "A funder sees what every token bought" });
  const other = world.goalTree.create(admin, { parentId: "gl_trust", text: "Reports link their sessions" });
  return { ...s, tess: u, goal, other };
}
const roleIds = (world: ReturnType<typeof setup>["world"], userId: string) => world.permissions.rolesOf({ kind: "user", id: userId }).map((r) => r.id).sort();

describe("resetOwnAccount (dc_ia2hybtuax)", () => {
  it("a let-in member who captains a goal, asked to captain another and directs work is a never-granted visitor again", () => {
    const { world, admin, tess, goal, other } = setup();
    const ar = requestAccess(world, tess.id, "testing");
    decideAccess(world, admin, ar.id, true, goal.id);
    const b = world.buildings.first("kind != 'town-hall'")!;
    world.permissions.ensureBuildingRoles(b.id);
    world.permissions.grant({ kind: "user", id: tess.id }, buildingRoleId(b.id, "manager"));
    world.goalTree.update(admin, goal.id, { ownerId: tess.id });
    requestCaptain(world, tess.id, other.id);
    expect(canInteract(world, tess.id)).toBe(true);
    expect(directGrantsOf(world, tess.id)).toHaveLength(1);
    const { agent: bot } = world.ops.registerVisitor(tess.id, { name: "Tess's Claude", buildingId: b.id });
    const avatar = world.ops.ensureAvatar(tess.id);

    const out = resetOwnAccount(world, tess.id);
    expect(out).toMatchObject({ goalsReleased: [goal.id], accessRequestsDeleted: 1, captainRequestsWithdrawn: 1, directGrantsRemoved: 1 });
    expect(out.rolesRemoved.sort()).toEqual([townRoleId("member"), buildingRoleId(b.id, "manager")].sort());
    expect(roleIds(world, tess.id)).toEqual([townRoleId("visitor")]);
    expect(canInteract(world, tess.id)).toBe(false);
    expect(accessRequestOf(world, tess.id)).toBeNull();
    expect(world.goalTree.require(goal.id).ownerId).toBeNull();
    expect(world.goalTree.ownerOf(goal.id).userId).toBe(holderOf(admin).id);
    expect(pendingCaptainRequests(world)).toEqual([]);
    expect(directGrantsOf(world, tess.id)).toEqual([]);
    expect(out.agentsRetired).toEqual([bot.id]);
    expect(world.agents.require(bot.id).status).toBe("retired");
    expect(world.layout.deskOf(bot.id)).toBeFalsy();
    expect(world.agents.require(avatar.id).status).not.toBe("retired");
    // a stranger again: may ask to join at once
    expect(requestAccess(world, tess.id).status).toBe("pending");
  });

  it("is a no-op for a visitor who never asked, and withdraws a pending ask to join", () => {
    const { world, tess } = setup();
    expect(resetOwnAccount(world, tess.id)).toEqual({ rolesRemoved: [], goalsReleased: [], accessRequestsDeleted: 0, captainRequestsWithdrawn: 0, directGrantsRemoved: 0, agentsRetired: [] });
    requestAccess(world, tess.id);
    expect(resetOwnAccount(world, tess.id).accessRequestsDeleted).toBe(1);
    expect(accessRequestOf(world, tess.id)).toBeNull();
    expect(roleIds(world, tess.id)).toEqual([townRoleId("visitor")]);
  });

  it("refuses an admin and the root's captain, changing nothing; the root keeps its captain", () => {
    const { world, admin, tess } = setup();
    const adminId = holderOf(admin).id;
    const before = roleIds(world, adminId);
    expect(() => resetOwnAccount(world, adminId)).toThrow(/admin/);
    expect(roleIds(world, adminId)).toEqual(before);
    world.permissions.grant({ kind: "user", id: tess.id }, townRoleId("member"));
    world.goalTree.update(admin, "gl_town", { ownerId: tess.id });
    expect(() => resetOwnAccount(world, tess.id)).toThrow(/root goal's captain/);
    expect(world.goalTree.root().ownerId).toBe(tess.id);
    expect(roleIds(world, tess.id)).toContain(townRoleId("member"));
  });
});
