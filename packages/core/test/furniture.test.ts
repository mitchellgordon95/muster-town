import { describe, expect, it } from "vitest";
import { TILE } from "@muster-town/schema";
import { createBuilding, findPath, updateBuilding, isWalkable, labSize, MAX_HEADCOUNT, piecesFor, TOWN_HALL_SIZE, validateLayout } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const at = (world: ReturnType<typeof seededWorld>["world"], x: number, y: number) => world.layout.grid.tiles[y * world.layout.grid.w + x];

describe("furniture", () => {
  it("every default room is legal, for every headcount and the Town Hall", () => {
    // a lab's door is in its top wall (it hangs below its goal's plaza): the room is mirrored; the Town Hall's is in the bottom wall
    for (let n = 1; n <= MAX_HEADCOUNT; n++) expect(validateLayout("lab", labSize(n), piecesFor("lab", n, labSize(n))), `headcount ${n}`).toEqual([]);
    expect(validateLayout("town-hall", TOWN_HALL_SIZE, piecesFor("town-hall", 3, TOWN_HALL_SIZE))).toEqual([]);
  });

  it("rejects pieces on the door, overlapping, off the floor, or walling off a stand tile", () => {
    const lot = labSize(6), pieces = piecesFor("lab", 6, lot), v = (f: Parameters<typeof validateLayout>[3]) => validateLayout("lab", lot, pieces, f);
    const door = Math.floor(lot.w / 2), desk0 = pieces.find((p) => p.key === "desk:0")!.at;
    expect(v({ plant: { x: door, y: 1 } })[0].message).toMatch(/blocks the door/);
    expect(v({ "desk:1": desk0 })[0].message).toMatch(/overlaps/);
    expect(v({ "desk:0": { x: 0, y: 4 } })[0].message).toMatch(/inside the room/);
    expect(v({ board: { x: 3, y: 3 } })[0].message).toMatch(/wall/);
    // the plant on desk 0's chair (above the desk: the room is mirrored) leaves the chair with no free floor
    expect(v({ plant: { x: desk0.x, y: desk0.y - 1 } })[0].message).toMatch(/free floor/);
  });

  it("a human manager moves the board; the place, the grid and the body standing there follow", () => {
    const { world, admin, by } = seededWorld("tree");
    const lot = world.buildings.require("carbon-cycle").lot!;
    const oldBoard = world.layout.requirePlace("board:carbon-cycle").pos;
    const ravi = by("Ravi");
    world.agents.patch(ravi.id, { pos: oldBoard });
    // a lab's back wall is its bottom one (its door is in the top wall, on its goal's plaza)
    const back = lot.h - 1;
    world.ops.updateFurniture(admin, "carbon-cycle", { board: { x: 1, y: back } });
    expect(world.buildings.require("carbon-cycle").furniture).toEqual({ board: { x: 1, y: back } });
    expect(at(world, lot.x + 1, lot.y + back)).toBe(TILE.BOARD);
    expect(at(world, oldBoard.x, oldBoard.y + 1)).toBe(TILE.WALL);
    const board = world.layout.requirePlace("board:carbon-cycle").pos;
    expect(board).toEqual({ x: lot.x + 1, y: lot.y + back - 1 });
    expect(world.agents.require(ravi.id).pos).toEqual(board);
    expect(world.events.recent({ limit: 5 }).some((e) => e.type === "building.layout")).toBe(true);
    // moving it back to the default stores nothing
    world.ops.updateFurniture(admin, "carbon-cycle", { board: piecesFor("lab", 6, lot).find((p) => p.key === "board")!.at });
    expect(world.buildings.require("carbon-cycle").furniture).toEqual({});
  });

  it("a resident at their desk moves with it; the Town Hall is editable too", () => {
    const { world, admin, by } = seededWorld("tree");
    const ravi = by("Ravi");
    const desk = world.layout.deskOf(ravi.id)!;
    const slot = world.layout.deskSlots("carbon-cycle").find((s) => s.agentId === ravi.id)!;
    world.agents.patch(ravi.id, { pos: desk.pos });
    const lot = world.buildings.require("carbon-cycle").lot!;
    // a free spot near the top-left (the door side) of a 6-desk lab; its chair is above it (the room is mirrored)
    world.ops.updateFurniture(admin, "carbon-cycle", { [`desk:${slot.n}`]: { x: 3, y: 2 } });
    const moved = world.layout.deskOf(ravi.id)!.pos;
    expect(moved).toEqual({ x: lot.x + 3, y: lot.y + 1 });
    expect(world.agents.require(ravi.id).pos).toEqual(moved);
    const th = world.buildings.require("town-hall").lot!;
    world.ops.updateFurniture(admin, "town-hall", { schedule: { x: 2, y: 4 } });
    const box = world.layout.requirePlace("schedule-board").pos;
    expect(box).toEqual({ x: th.x + 2, y: th.y + 5 });
    expect(findPath(world.layout.grid, world.layout.door("town-hall")!, box)).not.toBeNull();
  });

  it("only humans with building.manage may edit; illegal rooms are refused and dry runs save nothing", () => {
    const { world, admin, by } = seededWorld("tree");
    const moss = by("Moss");
    expect(() => world.ops.updateFurniture(moss, "carbon-cycle", { plant: { x: 2, y: 4 } })).toThrow(/Only humans/);
    const nobody = world.ops.ensureAvatar(world.ops.createUser("Nobody").user.id);
    expect(() => world.ops.updateFurniture(nobody, "carbon-cycle", { plant: { x: 2, y: 4 } })).toThrow();
    expect(() => world.ops.updateFurniture(admin, "carbon-cycle", { "desk:0": { x: 0, y: 0 } })).toThrow(/inside the room/);
    expect(() => world.ops.updateFurniture(admin, "carbon-cycle", { sofa: { x: 2, y: 2 } })).toThrow(/Unknown furniture/);
    const lot = world.buildings.require("carbon-cycle").lot!;
    const dry = world.ops.layoutPreview(admin, "carbon-cycle", { board: { x: 1, y: lot.h - 1 } });
    expect(dry.errors).toEqual([]);
    expect(dry.grid.tiles[(lot.y + lot.h - 1) * dry.grid.w + lot.x + 1]).toBe(TILE.BOARD);
    expect(world.buildings.require("carbon-cycle").furniture).toEqual({});
  });

  it("a stored spot that becomes illegal falls back to the default; legal ones survive a bigger lot", () => {
    const { world, admin, seed } = seededWorld("tree");
    const b = createBuilding(world, { name: "Small", headcount: 1 }, seed.admin.id);
    const back = b.lot!.h - 1;
    world.ops.updateFurniture(admin, b.id, { plant: { x: 3, y: 3 }, board: { x: 1, y: back } });
    // growing to 3 desks gives a bigger lot; the stored spots are still legal there
    updateBuilding(world, b.id, { headcount: 3 });
    const now = world.buildings.require(b.id);
    const lot = now.lot!;
    expect(lot.h - 1).toBe(back);
    expect(at(world, lot.x + 1, lot.y + back)).toBe(TILE.BOARD);
    // desks 1 and 2 take their defaults; the plant at (3,3) is legal still (desk 0's chair is at 2,5: the room is mirrored)
    expect(at(world, lot.x + 3, lot.y + 3)).toBe(TILE.PLANT);
    for (const s of world.layout.deskSlots(b.id)) expect(isWalkable(world.layout.grid, s.pos.x, s.pos.y)).toBe(true);
    // a stored spot on desk 0's chair is illegal: the plant goes back to its default
    world.buildings.upsert({ ...now, furniture: { ...now.furniture, plant: { x: 2, y: 5 } } });
    world.layout.rebuild();
    expect(at(world, lot.x + 2, lot.y + 5)).toBe(TILE.FLOOR);
  });
});
