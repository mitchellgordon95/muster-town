import { describe, expect, it } from "vitest";
import { TILE } from "@agent-town/schema";
import { World, createBuilding, createResident, findPath, isWalkable, MAX_HEADCOUNT, ROAD_Y } from "../src/index.ts";
import { freshWorld, seededWorld, tickUntil } from "./helpers.ts";

const overlap = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("layout", () => {
  it("lots never overlap and stay inside the grid, for many buildings of mixed sizes", () => {
    const { world, seed } = seededWorld();
    for (let i = 0; i < 7; i++) createBuilding(world, { name: `Lab ${i}`, headcount: [1, 4, 9, 12, 6, 2, MAX_HEADCOUNT][i] }, seed.admin.id);
    const bs = world.buildings.all();
    expect(bs).toHaveLength(9);
    for (const b of bs) {
      expect(b.lot).toBeDefined();
      expect(b.lot!.x).toBeGreaterThanOrEqual(0);
      expect(b.lot!.x + b.lot!.w).toBeLessThanOrEqual(world.layout.grid.w);
      expect(b.lot!.y + b.lot!.h).toBeLessThan(ROAD_Y);
    }
    for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) expect(overlap(bs[i].lot!, bs[j].lot!), `${bs[i].name} vs ${bs[j].name}`).toBe(false);
    // town hall centered at its fixed spot; the first lab is to its left
    const th = world.buildings.require("town-hall"), lab = world.buildings.require("carbon-cycle");
    expect(lab.lot!.x + lab.lot!.w).toBeLessThanOrEqual(th.lot!.x);
  });

  it("every desk (free or taken) is reachable from its building's door, and from the plaza", () => {
    const { world, seed } = seededWorld();
    createBuilding(world, { name: "Big", headcount: 12 }, seed.admin.id);
    const plaza = world.layout.requirePlace("plaza").pos;
    for (const b of world.buildings.where("kind = 'lab'")) {
      const door = world.layout.door(b.id)!;
      expect(world.layout.grid.tiles[door.y * world.layout.grid.w + door.x]).toBe(TILE.DOOR);
      const slots = world.layout.deskSlots(b.id);
      expect(slots).toHaveLength(b.headcount);
      for (const s of slots) {
        expect(isWalkable(world.layout.grid, s.pos.x, s.pos.y)).toBe(true);
        expect(findPath(world.layout.grid, door, s.pos), `${b.name} desk ${s.n}`).not.toBeNull();
      }
      expect(findPath(world.layout.grid, plaza, door)).not.toBeNull();
    }
  });

  it("creates the named places", () => {
    const { world, by } = seededWorld();
    for (const id of ["library", "trophy-room", "outbox", "meeting-room:town-hall", "plaza", "door:town-hall", "door:carbon-cycle", "meeting-room:carbon-cycle"]) {
      const p = world.layout.requirePlace(id);
      expect(isWalkable(world.layout.grid, p.pos.x, p.pos.y), id).toBe(true);
    }
    const ravi = by("Ravi");
    expect(world.layout.deskOf(ravi.id)?.pos).toEqual(ravi.pos);
    expect(world.layout.places.some((p) => p.id.startsWith("desk:free:"))).toBe(false); // 5 residents + Moss = 6 = headcount
  });

  it("lots and desks are stable across reopen, and growing headcount re-lots without overlap", () => {
    const { world, dbPath, seed } = seededWorld();
    const before = world.buildings.all().map((b) => [b.id, b.lot]);
    world.close();
    const w2 = World.open(dbPath);
    expect(w2.buildings.all().map((b) => [b.id, b.lot])).toEqual(before);
    const b = createBuilding(w2, { name: "Small", headcount: 1 }, seed.admin.id);
    createResident(w2, { buildingId: b.id, name: "Solo", title: "t", direction: "d" });
    expect(() => createResident(w2, { buildingId: b.id, name: "Extra", title: "t", direction: "d" })).toThrow(/no free desk/);
    w2.ops.updateBuilding(null, b.id, { headcount: 9 });
    const all = w2.buildings.all();
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) expect(overlap(all[i].lot!, all[j].lot!)).toBe(false);
    createResident(w2, { buildingId: b.id, name: "Extra", title: "t", direction: "d" });
    w2.close();
  });
});

describe("pathfinding and movement", () => {
  it("BFS finds shortest 4-neighbour paths and refuses walls", () => {
    const grid = { w: 5, h: 3, tiles: [0, 0, 0, 0, 0, 0, 3, 3, 3, 0, 0, 0, 0, 0, 0] };
    const p = findPath(grid, { x: 0, y: 1 }, { x: 4, y: 1 })!;
    expect(p.at(-1)).toEqual({ x: 4, y: 1 });
    expect(p).toHaveLength(6); // around the wall
    expect(findPath(grid, { x: 0, y: 0 }, { x: 0, y: 0 })).toEqual([]);
    const boxed = { w: 3, h: 3, tiles: [3, 3, 3, 3, 0, 3, 3, 3, 3] };
    expect(findPath(boxed, { x: 1, y: 1 }, { x: 5, y: 5 })).toBeNull();
  });

  it("`go` walks via tick, resolves on arrival, and restores status", async () => {
    const { world, by } = seededWorld();
    const noor = by("Noor");
    const positions: number[] = [];
    world.changes.subscribe((m) => { if (m.type === "agents.pos") positions.push(m.positions.length); });
    const p = world.verbs.go(noor, { to: "library" });
    await Promise.resolve();
    expect(world.agents.require(noor.id).status).toBe("walking");
    const res = await tickUntil(world, p);
    expect(res.arrived).toBe(true);
    const after = world.agents.require(noor.id);
    expect(after.pos).toEqual(world.layout.requirePlace("library").pos);
    expect(after.status).toBe("idle");
    expect(after.buildingId).toBe("carbon-cycle"); // residents keep their building
    expect(positions.length).toBeGreaterThan(3);
    expect(world.events.list({ agentId: noor.id, types: ["agent.moved"] })).toHaveLength(1);
    // back to desk
    await tickUntil(world, world.verbs.go(noor, { to: `desk:${noor.id}` }));
    expect(world.agents.require(noor.id).pos).toEqual(world.layout.deskOf(noor.id)!.pos);
  });

  it("visitors' buildingId follows their body; unknown targets fail", async () => {
    const { world, seed } = seededWorld();
    const { agent } = world.ops.registerVisitor(seed.admin.id, { name: "Visitor" });
    expect(agent.buildingId).toBeNull();
    await tickUntil(world, world.verbs.go(agent, { to: "library" }));
    expect(world.agents.require(agent.id).buildingId).toBe("town-hall");
    await expect(world.verbs.go(agent, { to: "nowhere" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("moveHuman validates walkability", () => {
    const { world, admin } = seededWorld();
    const th = world.buildings.require("town-hall").lot!;
    expect(world.moveHuman(admin.id, th.x, th.y)).toBe(false); // wall corner
    const lib = world.layout.requirePlace("library").pos;
    expect(world.moveHuman(admin.id, lib.x, lib.y)).toBe(true);
    expect(world.agents.require(admin.id).buildingId).toBe("town-hall");
  });

  it("freshWorld with no buildings still has a grid", () => {
    const { world } = freshWorld();
    expect(world.layout.grid.w * world.layout.grid.h).toBe(world.layout.grid.tiles.length);
  });
});
