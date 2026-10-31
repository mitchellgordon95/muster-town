import { describe, expect, it } from "vitest";
import { decideCaptain, intrayCount, intrayRoutes, pendingCaptainRequests, requestCaptain, reviewDeck, townHallIntray, townRoleId } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

// "Ask to captain this goal" (grant gr_bwm0iz7rwl, kr_j1w17nw178): a member asks, the goal's current captain decides.
function setup() {
  const s = seededWorld();
  const { world, admin } = s;
  const user = (name: string, role: "member" | "visitor") => {
    const { user: u } = world.ops.createUser(name);
    world.permissions.grant({ kind: "user", id: u.id }, townRoleId(role));
    return { user: u, avatar: world.ops.ensureAvatar(u.id) };
  };
  const ana = user("Ana", "member");
  const bo = user("Bo", "member");
  const vic = user("Vic", "visitor");
  const parent = world.goalTree.create(admin, { parentId: "gl_trust", text: "A funder sees what every token bought" });
  const child = world.goalTree.create(admin, { parentId: parent.id, text: "Grant pages show sessions" });
  const th = world.buildings.first("kind = 'town-hall'")!;
  return { ...s, ana, bo, vic, parent, child, th };
}

describe("captain requests (gr_bwm0iz7rwl)", () => {
  it("only a member can ask; not for the root; one pending ask per (goal, user)", () => {
    const { world, ana, vic, child, parent } = setup();
    expect(() => requestCaptain(world, vic.user.id, child.id)).toThrow(/Only a member/);
    expect(() => requestCaptain(world, ana.user.id, "gl_town")).toThrow(/town admins/);
    const r = requestCaptain(world, ana.user.id, child.id, "  I run this work  ");
    expect(r).toMatchObject({ status: "pending", goalId: child.id, userId: ana.user.id, note: "I run this work" });
    expect(() => requestCaptain(world, ana.user.id, child.id)).toThrow(/already asked/);
    // another goal is a separate ask
    expect(requestCaptain(world, ana.user.id, parent.id).status).toBe("pending");
  });

  it("is a Town Hall in-tray item with the goal's words and requester, counted in the badge, routed to the admins when nobody captains it", () => {
    const { world, ana, bo, admin, child, th } = setup();
    const before = intrayCount(world, th.id);
    const r = requestCaptain(world, ana.user.id, child.id);
    expect(intrayCount(world, th.id)).toBe(before + 1);
    const tray = townHallIntray(world);
    expect(tray.captains).toEqual([expect.objectContaining({ id: r.id, name: "Ana", goalText: "Grant pages show sessions", captainId: null, captainName: "the town admins" })]);
    const forAdmin = intrayRoutes(world, admin, tray).routes[r.id];
    expect(forAdmin).toMatchObject({ goalId: "gl_town", ownerId: null, mine: true, canDecide: true });
    const forBo = intrayRoutes(world, bo.avatar, tray).routes[r.id];
    expect(forBo).toMatchObject({ mine: false, canDecide: false });
  });

  it("routes to the node's current captain (inherited down the tree), who accepts: ownerId set, goal.owned posted", () => {
    const { world, ana, bo, admin, parent, child } = setup();
    world.goalTree.update(admin, parent.id, { ownerId: bo.user.id });
    const r = requestCaptain(world, ana.user.id, child.id);
    const tray = townHallIntray(world);
    expect(tray.captains[0]).toMatchObject({ captainId: bo.user.id, captainName: "Bo" });
    expect(intrayRoutes(world, bo.avatar, tray).routes[r.id]).toMatchObject({ goalId: parent.id, ownerId: bo.user.id, mine: true, canDecide: true });
    expect(intrayRoutes(world, ana.avatar, tray).routes[r.id]).toMatchObject({ mine: false, canDecide: false });
    // the requester can't accept their own ask
    expect(() => decideCaptain(world, ana.avatar, r.id, true)).toThrow(/current captain/);
    const done = decideCaptain(world, bo.avatar, r.id, true, "yours");
    expect(done).toMatchObject({ status: "accepted", decidedBy: bo.user.id, decisionNote: "yours" });
    expect(world.goalTree.require(child.id).ownerId).toBe(ana.user.id);
    expect(world.goalTree.ownerOf(child.id).userId).toBe(ana.user.id);
    const ev = world.events.recent({ limit: 10 }).find((e) => e.type === "goal.owned" && (e.payload as { goalId?: string }).goalId === child.id);
    expect(ev?.payload).toMatchObject({ ownerId: ana.user.id, fromOwnerId: null });
    expect(pendingCaptainRequests(world)).toEqual([]);
    expect(() => decideCaptain(world, bo.avatar, r.id, false)).toThrow(/already accepted/);
    expect(() => requestCaptain(world, ana.user.id, child.id)).toThrow(/already captain/);
  });

  it("decline leaves ownerId unset; the same user may ask again", () => {
    const { world, ana, admin, child } = setup();
    const r = requestCaptain(world, ana.user.id, child.id);
    expect(decideCaptain(world, admin, r.id, false).status).toBe("declined");
    expect(world.goalTree.require(child.id).ownerId).toBeNull();
    expect(requestCaptain(world, ana.user.id, child.id).status).toBe("pending");
  });

  it("is one review-deck slide with the goal, the requester, why and who decides; gone once decided", () => {
    const { world, ana, admin, child } = setup();
    const r = requestCaptain(world, ana.user.id, child.id, "I run this work");
    const slide = reviewDeck(world).slides.find((s) => s.kind === "captain");
    expect(slide).toMatchObject({ key: `captain:${r.id}`, itemId: r.id, group: 4 });
    expect(slide!.text).toContain('Ana asks to captain "Grant pages show sessions"');
    expect(slide!.text).toContain('Why: "I run this work"');
    expect(slide!.text).toContain("captained by the town admins");
    decideCaptain(world, admin, r.id, true);
    expect(reviewDeck(world).slides.some((s) => s.kind === "captain")).toBe(false);
  });
});
