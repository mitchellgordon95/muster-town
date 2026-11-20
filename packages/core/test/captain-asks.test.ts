import { describe, expect, it } from "vitest";
import { canDecideAsk, decideAsk, deferAsk, intrayRoutes, townHallIntray, townRoleId } from "../src/index.ts";
import { seedAsk, seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";
const CLICK = { type: "click" as const, sourceDocId: null, branches: [{ label: "Done" }, { label: "Decline" }], recommendation: "Done", body: "Open the page once." };

/**
 * Captains decide every ask in their subtree (gr_0vuiuqcw8p): a non-admin who captains the goal an ask moves (or a goal
 * above it) decides and defers it; outside their subtree they are refused, and the in-tray routes every ask by its own
 * id with the same rule.
 */
function setup() {
  const s = seededWorld();
  const { world, admin } = s;
  const user = (name: string) => {
    const { user: u } = world.ops.createUser(name);
    world.permissions.grant({ kind: "user", id: u.id }, townRoleId("member"));
    return world.ops.ensureAvatar(u.id);
  };
  const cap = user("Cap");
  const plain = user("Plain");
  const leaf = world.goalTree.create(admin, { parentId: "gl_trust", text: "The carbon lab's leaf goal" });
  world.goalTree.attach(admin, LAB, leaf.id);
  world.goalTree.update(admin, leaf.id, { ownerId: world.holderOf(cap).id });
  const th = world.buildings.first("kind = 'town-hall'")!;
  const inside = seedAsk(world, { ...CLICK, buildingId: LAB, title: "Merge the lab docs" }).ask;
  const outside = seedAsk(world, { ...CLICK, buildingId: th.id, title: "Set the mail key" }).ask;
  return { ...s, cap, plain, leaf, inside, outside };
}

describe("captains decide asks in their subtree (gr_0vuiuqcw8p)", () => {
  it("canDecideAsk: the captain inside, not outside; a plain member and an agent never; an admin everywhere", () => {
    const { world, admin, cap, plain, inside, outside, by } = setup();
    expect(canDecideAsk(world, cap, inside)).toBe(true);
    expect(canDecideAsk(world, cap, outside)).toBe(false);
    expect(canDecideAsk(world, plain, inside)).toBe(false);
    expect(canDecideAsk(world, by("Mei"), inside)).toBe(false);
    expect(canDecideAsk(world, admin, outside)).toBe(true);
  });

  it("decideAsk and deferAsk: the captain decides in the subtree, is refused (403) outside", () => {
    const { world, cap, plain, inside, outside } = setup();
    expect(() => decideAsk(world, cap, outside.id, "Done")).toThrow(/captain of its goal/);
    expect(() => deferAsk(world, cap, outside.id, "later")).toThrow(/captain of its goal/);
    expect(() => decideAsk(world, plain, inside.id, "Done")).toThrow(/captain of its goal/);
    const done = decideAsk(world, cap, inside.id, "Done");
    expect(done).toMatchObject({ status: "decided", decidedBy: world.holderOf(cap).id, decision: "Done" });
  });

  it("in-tray routes: every ask by its own id, Mine and canDecide from the same rule", () => {
    const { world, admin, cap, plain, leaf, inside, outside } = setup();
    const tray = townHallIntray(world);
    const forCap = intrayRoutes(world, cap, tray).routes;
    expect(forCap[inside.id]).toMatchObject({ goalId: leaf.id, mine: true, canDecide: true });
    expect(forCap[outside.id]).toMatchObject({ mine: false, canDecide: false });
    expect(intrayRoutes(world, plain, tray).routes[inside.id]).toMatchObject({ mine: false, canDecide: false });
    const forAdmin = intrayRoutes(world, admin, tray).routes;
    expect(forAdmin[inside.id]).toMatchObject({ mine: false, canDecide: true });
    expect(intrayRoutes(world, undefined, tray).routes[inside.id]).toMatchObject({ canDecide: false });
  });
});
