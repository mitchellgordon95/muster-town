import { describe, expect, it } from "vitest";
import { canDirect, createDoc, intrayRoutes, townHallIntray, townRoleId } from "../src/index.ts";
import { buildingRoleId } from "../src/permissions.ts";
import { seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";

/**
 * Captain steering rights (gr_zsm1piyqyx, kr_xx9wtfnwh8): the captain of a building's goal (or a goal above it) decides
 * that building's rollups, runs 1:1s there as staff and plants flags there. Three actors per gate: the captain of the
 * attached goal's parent (yes), the captain of a goal outside the subtree (no / member), a plain member (no / member).
 */
function setup() {
  const s = seededWorld();
  const { world, admin, by } = s;
  const user = (name: string) => {
    const { user: u } = world.ops.createUser(name);
    world.permissions.grant({ kind: "user", id: u.id }, townRoleId("member"));
    return world.ops.ensureAvatar(u.id);
  };
  const cap = user("Cap");
  const out = user("Out");
  const plain = user("Plain");
  const mei = by("Mei");
  world.ops.updateBuilding(admin, LAB, { managerAgentId: mei.id });
  world.permissions.grant(mei, buildingRoleId(LAB, "manager"));
  // the lab hangs under Cap's goal (one level down: captaincy is inherited); Out captains a sibling branch
  const top = world.goalTree.create(admin, { parentId: "gl_trust", text: "Funders see what every token bought" });
  const labGoal = world.goalTree.create(admin, { parentId: top.id, text: "The carbon lab's goal" });
  world.goalTree.attach(admin, LAB, labGoal.id);
  world.goalTree.update(admin, top.id, { ownerId: world.holderOf(cap).id });
  const other = world.goalTree.create(admin, { parentId: "gl_trust", text: "Somewhere else" });
  world.goalTree.update(admin, other.id, { ownerId: world.holderOf(out).id });
  const rollup = createDoc(world, { type: "report", state: "building", title: "Rollup 1", body: "## Shipped\nx", decision: "pending", authorId: mei.id, authorKind: "agent", buildingId: LAB, tags: ["rollup"] });
  return { ...s, cap, out, plain, mei, rollup };
}

describe("captain steering rights (gr_zsm1piyqyx)", () => {
  it("captainsBuilding: a human captain of the attachment or an ancestor; never an agent, the system or the Town Hall", () => {
    const { world, cap, out, plain, mei } = setup();
    expect(world.goalTree.captainsBuilding(cap, LAB)).toBe(true);
    expect(world.goalTree.captainsBuilding(world.holderOf(cap), LAB)).toBe(true);
    expect(world.goalTree.captainsBuilding(out, LAB)).toBe(false);
    expect(world.goalTree.captainsBuilding(plain, LAB)).toBe(false);
    expect(world.goalTree.captainsBuilding(mei, LAB)).toBe(false);
    expect(world.goalTree.captainsBuilding(null, LAB)).toBe(false);
    expect(world.goalTree.captainsBuilding(cap, "town-hall")).toBe(false);
    expect(world.goalTree.captainsBuilding(cap, "nope")).toBe(false);
  });

  it("rollups: the in-tray's canDecide and the review/archive decisions follow the captain; outside and plain members can't", async () => {
    const { world, cap, out, plain, rollup } = setup();
    const tray = townHallIntray(world);
    expect(tray.reports.map((d) => d.id)).toContain(rollup.id);
    expect(intrayRoutes(world, cap, tray).routes[rollup.id]).toMatchObject({ mine: true, canDecide: true });
    expect(intrayRoutes(world, cap, tray).defaultView).toBe("mine");
    expect(intrayRoutes(world, out, tray).routes[rollup.id]).toMatchObject({ mine: false, canDecide: false });
    expect(intrayRoutes(world, plain, tray).routes[rollup.id]).toMatchObject({ mine: false, canDecide: false });
    await expect(world.verbs.review(out, { docId: rollup.id, decision: "approve", note: "" })).rejects.toThrow(/building.review/);
    await expect(world.verbs.review(plain, { docId: rollup.id, decision: "approve", note: "" })).rejects.toThrow(/building.review/);
    expect(() => world.ops.archiveReport(out, rollup.id)).toThrow(/building.review/);
    expect(() => world.ops.archiveReport(plain, rollup.id)).toThrow(/building.review/);
    await world.verbs.review(cap, { docId: rollup.id, decision: "approve", note: "thanks" });
    expect(world.docs.require(rollup.id, "doc").decision).toBe("approve");
  });

  it("archive: the captain archives a report of a building under their goal", () => {
    const { world, cap, rollup } = setup();
    world.ops.archiveReport(cap, rollup.id);
    expect(world.docs.require(rollup.id, "doc").decision).not.toBe("pending");
  });

  it("1:1s: the captain directs work inside the subtree (canDirect, 1:1 opens); outside or plain, no 1:1 (403)", () => {
    const { world, cap, out, plain } = setup();
    expect(canDirect(world, cap, LAB)).toBe(true);
    expect(canDirect(world, out, LAB)).toBe(false);
    expect(canDirect(world, plain, LAB)).toBe(false);
    const mc = world.ops.openOneOnOne(cap, LAB);
    expect(() => world.ops.openOneOnOne(out, LAB)).toThrow(/meeting.facilitate|direct work/);
    expect(() => world.ops.openOneOnOne(plain, LAB)).toThrow(/meeting.facilitate|direct work/);
    // they speak and end it
    world.ops.meetingSay(cap, mc.id, "Ship the captain gates.");
    expect(world.ops.endMeeting(cap, mc.id).phase).toBe("done");
    // and call a meeting in the building; outsiders can't
    expect(world.ops.createMeeting(cap, { kind: "standup", buildingId: LAB }).buildingId).toBe(LAB);
    expect(() => world.ops.createMeeting(out, { kind: "standup", buildingId: LAB })).toThrow(/direct work/);
    expect(() => world.ops.createMeeting(plain, { kind: "standup", buildingId: LAB })).toThrow(/direct work/);
  });

  it("flags: the captain plants one in a building under their goal; outside and plain members get 403", () => {
    const { world, cap, out, plain } = setup();
    const f = world.ops.plantFlag(cap, LAB, "Look at the lab banner");
    expect(f).toMatchObject({ type: "flag", buildingId: LAB, authorId: world.holderOf(cap).id, authorKind: "user" });
    expect(() => world.ops.plantFlag(out, LAB, "nope")).toThrow(/building.assign/);
    expect(() => world.ops.plantFlag(plain, LAB, "nope")).toThrow(/building.assign/);
    expect(() => world.ops.plantFlag(cap, "town-hall", "nope")).toThrow(/Town Hall/);
  });
});
