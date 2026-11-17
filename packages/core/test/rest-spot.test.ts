import { describe, expect, it } from "vitest";
import { TILE } from "@muster-town/schema";
import { restDrop, restTile } from "../src/world/rest-spot.ts";
import { walkHome } from "../src/home.ts";
import { seededWorld } from "./helpers.ts";

/** Drag only the body (Mitchell's flag dc_d2wkuhoh1l): the drop tile is where the agent rests; the desk stays put. */
describe("rest spot", () => {
  it("pure: a floor or grass tile becomes the spot (relative to its building); the home tile clears it; walls, furniture, doors, off-map refused", () => {
    const { world } = seededWorld("tree");
    const grid = world.layout.grid, lots = world.layout.lots(), lot = lots.get("carbon-cycle")!;
    const home = { x: lot.x + 1, y: lot.y + 1 };
    const floor = { x: lot.x + 3, y: lot.y + 1 };
    expect(grid.tiles[floor.y * grid.w + floor.x]).toBe(TILE.FLOOR);
    expect(restDrop(grid, lots, "Ravi", home, floor)).toEqual({ ok: true, spot: { buildingId: "carbon-cycle", x: 3, y: 1 } });
    expect(restDrop(grid, lots, "Ravi", home, home)).toEqual({ ok: true, spot: null });
    // outside every building: absolute
    const grass = (() => { for (let i = 0; i < grid.tiles.length; i++) if (grid.tiles[i] === TILE.GRASS) return { x: i % grid.w, y: Math.floor(i / grid.w) }; throw new Error("no grass"); })();
    expect(restDrop(grid, new Map(), "Ravi", home, grass)).toEqual({ ok: true, spot: { buildingId: null, ...grass } });
    expect(restDrop(grid, lots, "Ravi", home, { x: lot.x, y: lot.y + 3 })).toMatchObject({ ok: false, message: /wall, furniture or water/ });
    expect(restDrop(grid, lots, "Ravi", home, world.layout.door("carbon-cycle")!)).toMatchObject({ ok: false, message: /block the door/ });
    expect(restDrop(grid, lots, "Ravi", home, { x: -1, y: 0 })).toMatchObject({ ok: false, message: /off the map/ });
    // a stored spot follows its building, and gives way to the default when it can't be stood on
    expect(restTile({ buildingId: "carbon-cycle", x: 3, y: 1 }, lots, grid)).toEqual(floor);
    expect(restTile({ buildingId: "carbon-cycle", x: 0, y: 3 }, lots, grid)).toBeNull();
    expect(restTile({ buildingId: "gone", x: 3, y: 1 }, lots, grid)).toBeNull();
  });

  it("ops: only the body moves (the desk stays), it walks home to the spot, its desk tile clears it; the Secretary too; humans refused", () => {
    const { world, admin, by } = seededWorld("tree");
    const ravi = by("Ravi");
    const furniture = world.buildings.require("carbon-cycle").furniture;
    const desk = world.layout.deskOf(ravi.id)!.pos;
    const lot = world.buildings.require("carbon-cycle").lot!;
    const spot = { x: lot.x + 3, y: lot.y + 1 };
    expect(() => world.ops.dropAgent(by("Moss"), ravi.id, spot)).toThrow(/Only humans/);
    expect(world.ops.dropAgent(admin, ravi.id, spot)).toEqual({ pos: spot, home: false });
    expect(world.agents.require(ravi.id).pos).toEqual(spot);
    expect(world.buildings.require("carbon-cycle").furniture).toEqual(furniture);
    expect(world.layout.deskOf(ravi.id)!).toMatchObject({ pos: spot, name: "Ravi's spot" });
    expect(world.layout.defaultHomeOf(ravi.id)).toEqual(desk);
    // sent elsewhere, it walks home to the spot, not the desk
    world.agents.patch(ravi.id, { pos: world.layout.door("carbon-cycle")! });
    expect(walkHome(world, ravi.id)).toBe(true);
    expect(world.movement.isWalking(ravi.id)).toBe(true);
    world.movement.cancel(ravi.id, "test");
    // refused drops change nothing
    expect(() => world.ops.dropAgent(admin, ravi.id, { x: lot.x, y: lot.y + 3 })).toThrow(/wall, furniture or water/);
    expect(world.layout.deskOf(ravi.id)!.pos).toEqual(spot);
    // back on its desk tile: the default again
    expect(world.ops.dropAgent(admin, ravi.id, desk)).toEqual({ pos: desk, home: true });
    expect(world.db.prepare("SELECT COUNT(*) AS n FROM rest_spots").get()).toEqual({ n: 0 });
    expect(world.layout.deskOf(ravi.id)!.name).toBe("Ravi's desk");
    // the Secretary rests by the hydrant by default; an admin can move him anywhere he can stand
    const sec = world.secretary.ensure()!;
    expect(world.layout.deskOf(sec.id)).toBeTruthy();
    {
      const hall = world.buildings.require("town-hall").lot!;
      const to = { x: hall.x + 8, y: hall.y + 4 };
      expect(world.ops.dropAgent(admin, sec.id, to)).toEqual({ pos: to, home: false });
      expect(world.layout.deskOf(sec.id)!.pos).toEqual(to);
    }
    expect(() => world.ops.dropAgent(admin, admin.id, spot)).toThrow(/person/);
  });
});
