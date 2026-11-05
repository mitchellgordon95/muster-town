import { describe, expect, it } from "vitest";
import { stayReason, walkHome } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

/**
 * Mitchell's flag dc_r7u6bkaei4: idle, the Planner stands by the goal tree and the Secretary by the Town Hall in-tray,
 * not at the mod station. They still hold a mod-station desk slot; only where that desk is drawn moves.
 */
describe("Town Hall rest spots (flag dc_r7u6bkaei4)", () => {
  const near = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

  it("the Planner's desk is beside the goal tree's stand, the Secretary's beside the in-tray's; both keep a desk slot", () => {
    const { world } = seededWorld();
    const planner = world.reorgs.ensurePlanner();
    const secretary = world.secretary.ensure()!;
    const L = world.layout;
    const tree = L.requirePlace("goal-tree").pos, tray = L.requirePlace("intray:town-hall").pos;
    const pd = L.deskOf(planner.id)!, sd = L.deskOf(secretary.id)!;
    expect(near(pd.pos, tree)).toBe(1);
    expect(near(sd.pos, tray)).toBe(1);
    expect(pd.name).toBe("Planner's spot by the goal tree");
    expect(sd.name).toBe("Secretary's spot by the town hall in-tray");
    // walkable, inside the Town Hall, on no other place's tile
    for (const d of [pd, sd]) {
      expect(L.isWalkable(d.pos.x, d.pos.y)).toBe(true);
      expect(L.buildingAt(d.pos)?.id).toBe("town-hall");
      expect(L.places.filter((p) => p.pos.x === d.pos.x && p.pos.y === d.pos.y).map((p) => p.id)).toEqual([d.id]);
    }
    // the bodies are put there when created
    expect(world.agents.require(planner.id).pos).toEqual(pd.pos);
    expect(world.agents.require(secretary.id).pos).toEqual(sd.pos);
    // desk bookkeeping: both still hold Town Hall slots; the free slot stays a mod-station seat
    const slots = L.deskSlots("town-hall");
    expect(slots.filter((s) => s.agentId).map((s) => s.agentId).sort()).toEqual([planner.id, secretary.id].sort());
    const mod = L.requirePlace("mod-station").pos;
    const free = slots.find((s) => !s.agentId)!;
    expect(near(free.pos, mod)).toBeLessThanOrEqual(3);
    expect(L.place(`desk:free:town-hall:${free.n}`)!.name).toBe("Free mod station seat");
  });

  it("another Town Hall resident still sits at the mod station", () => {
    const { world } = seededWorld();
    world.reorgs.ensurePlanner();
    const mod = world.layout.requirePlace("mod-station").pos;
    const d = world.layout.claimDesk("town-hall", "ag_moss");
    expect(d.name).toBe("ag_moss's seat at the mod station");
    expect(near(d.pos, mod)).toBeLessThanOrEqual(3);
  });

  it("an idle Planner left elsewhere walks back to the goal tree, not the mod station", () => {
    const { world } = seededWorld();
    const planner = world.reorgs.ensurePlanner();
    const desk = world.layout.deskOf(planner.id)!;
    const elsewhere = world.layout.requirePlace("mod-station").pos;
    world.agents.patch(planner.id, { pos: elsewhere });
    expect(stayReason(world, planner.id, Date.now() + 10 * 60_000)).toBeNull();
    const walks: unknown[] = [];
    world.movement.go = ((_a: unknown, to: unknown) => { walks.push(to); return Promise.resolve(); }) as never;
    expect(walkHome(world, planner.id, Date.now() + 10 * 60_000)).toBe(true);
    expect(walks).toEqual([desk.pos]);
  });
});
