import { describe, expect, it } from "vitest";
import { TILE } from "@muster-town/schema";
import { createBuilding, findPath, isWalkable, labSize, MAX_HEADCOUNT, piecesFor, TOWN_HALL_SIZE, validateLayout } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const at = (world: ReturnType<typeof seededWorld>["world"], x: number, y: number) => world.layout.grid.tiles[y * world.layout.grid.w + x];

describe("furniture", () => {
  it("every default room is legal, for every headcount and the Town Hall", () => {
    for (let n = 1; n <= MAX_HEADCOUNT; n++) expect(validateLayout(labSize(n), piecesFor("lab", n, labSize(n))), `headcount ${n}`).toEqual([]);
    expect(validateLayout(TOWN_HALL_SIZE, piecesFor("town-hall", 3, TOWN_HALL_SIZE))).toEqual([]);
    // south of the road (door in the top wall) the same rooms, mirrored, are legal too
    for (let n = 1; n <= MAX_HEADCOUNT; n++) { const lot = { ...labSize(n), y: 50 }; expect(validateLayout(lot, piecesFor("lab", n, lot)), `south, headcount ${n}`).toEqual([]); }
    const hall = { ...TOWN_HALL_SIZE, y: 50 };
    expect(validateLayout(hall, piecesFor("town-hall", 3, hall))).toEqual([]);
  });

  it("rejects pieces on the door, overlapping, off the floor, or walling off a stand tile", () => {
    const lot = labSize(6), pieces = piecesFor("lab", 6, lot);
    const door = Math.floor(lot.w / 2);
    expect(validateLayout(lot, pieces, { plant: { x: door, y: lot.h - 2 } })[0].message).toMatch(/blocks the door/);
    expect(validateLayout(lot, pieces, { "desk:1": { x: 2, y: 2 } })[0].message).toMatch(/overlaps/);
    expect(validateLayout(lot, pieces, { "desk:0": { x: 0, y: 4 } })[0].message).toMatch(/inside the room/);
    expect(validateLayout(lot, pieces, { board: { x: 3, y: 3 } })[0].message).toMatch(/wall/);
    // the plant right below desk 0's chair leaves the chair with no free floor
    expect(validateLayout(lot, pieces, { plant: { x: 2, y: 3 } })[0].message).toMatch(/free floor/);
  });

  it("a human manager moves the board; the place, the grid and the body standing there follow", () => {
    const { world, admin, by } = seededWorld();
    const lot = world.buildings.require("carbon-cycle").lot!;
    const oldBoard = world.layout.requirePlace("board:carbon-cycle").pos;
    const ravi = by("Ravi");
    world.agents.patch(ravi.id, { pos: oldBoard });
    world.ops.updateFurniture(admin, "carbon-cycle", { board: { x: 1, y: 0 } });
    expect(world.buildings.require("carbon-cycle").furniture).toEqual({ board: { x: 1, y: 0 } });
    expect(at(world, lot.x + 1, lot.y)).toBe(TILE.BOARD);
    expect(at(world, oldBoard.x, oldBoard.y - 1)).toBe(TILE.WALL);
    const board = world.layout.requirePlace("board:carbon-cycle").pos;
    expect(board).toEqual({ x: lot.x + 1, y: lot.y + 1 });
    expect(world.agents.require(ravi.id).pos).toEqual(board);
    expect(world.events.recent({ limit: 5 }).some((e) => e.type === "building.layout")).toBe(true);
    // moving it back to the default stores nothing
    world.ops.updateFurniture(admin, "carbon-cycle", { board: piecesFor("lab", 6, lot).find((p) => p.key === "board")!.at });
    expect(world.buildings.require("carbon-cycle").furniture).toEqual({});
  });

  it("a resident at their desk moves with it; the Town Hall is editable too", () => {
    const { world, admin, by } = seededWorld();
    const ravi = by("Ravi");
    const desk = world.layout.deskOf(ravi.id)!;
    const slot = world.layout.deskSlots("carbon-cycle").find((s) => s.agentId === ravi.id)!;
    world.agents.patch(ravi.id, { pos: desk.pos });
    const lot = world.buildings.require("carbon-cycle").lot!;
    // a free spot near the bottom-left of a 6-desk lab
    world.ops.updateFurniture(admin, "carbon-cycle", { [`desk:${slot.n}`]: { x: 3, y: lot.h - 3 } });
    const moved = world.layout.deskOf(ravi.id)!.pos;
    expect(moved).toEqual({ x: lot.x + 3, y: lot.y + lot.h - 2 });
    expect(world.agents.require(ravi.id).pos).toEqual(moved);
    const th = world.buildings.require("town-hall").lot!;
    world.ops.updateFurniture(admin, "town-hall", { schedule: { x: 2, y: 4 } });
    const box = world.layout.requirePlace("schedule-board").pos;
    expect(box).toEqual({ x: th.x + 2, y: th.y + 5 });
    expect(findPath(world.layout.grid, world.layout.door("town-hall")!, box)).not.toBeNull();
  });

  it("only humans with building.manage may edit; illegal rooms are refused and dry runs save nothing", () => {
    const { world, admin, by } = seededWorld();
    const moss = by("Moss");
    expect(() => world.ops.updateFurniture(moss, "carbon-cycle", { plant: { x: 2, y: 4 } })).toThrow(/Only humans/);
    const nobody = world.ops.ensureAvatar(world.ops.createUser("Nobody").user.id);
    expect(() => world.ops.updateFurniture(nobody, "carbon-cycle", { plant: { x: 2, y: 4 } })).toThrow();
    expect(() => world.ops.updateFurniture(admin, "carbon-cycle", { "desk:0": { x: 0, y: 0 } })).toThrow(/inside the room/);
    expect(() => world.ops.updateFurniture(admin, "carbon-cycle", { sofa: { x: 2, y: 2 } })).toThrow(/Unknown furniture/);
    const lot = world.buildings.require("carbon-cycle").lot!;
    const dry = world.ops.layoutPreview(admin, "carbon-cycle", { board: { x: 1, y: 0 } });
    expect(dry.errors).toEqual([]);
    expect(dry.grid.tiles[lot.y * dry.grid.w + lot.x + 1]).toBe(TILE.BOARD);
    expect(world.buildings.require("carbon-cycle").furniture).toEqual({});
  });

  it("a stored spot that becomes illegal falls back to the default; legal ones survive a bigger lot", () => {
    const { world, admin, seed } = seededWorld();
    const b = createBuilding(world, { name: "Small", headcount: 1 }, seed.admin.id);
    world.ops.updateFurniture(admin, b.id, { plant: { x: 3, y: 3 }, board: { x: 1, y: 0 } });
    // growing to 3 desks gives a bigger lot; the stored spots are still legal there
    world.ops.updateBuilding(admin, b.id, { headcount: 3 });
    const now = world.buildings.require(b.id);
    const lot = now.lot!;
    expect(at(world, lot.x + 1, lot.y)).toBe(TILE.BOARD);
    // desks 1 and 2 take their defaults; the plant at (3,3) is legal still (desk 0's chair is at 2,3)
    expect(at(world, lot.x + 3, lot.y + 3)).toBe(TILE.PLANT);
    for (const s of world.layout.deskSlots(b.id)) expect(isWalkable(world.layout.grid, s.pos.x, s.pos.y)).toBe(true);
    // a stored spot on desk 0's chair is illegal: the plant goes back to its default
    world.buildings.upsert({ ...now, furniture: { ...now.furniture, plant: { x: 2, y: 3 } } });
    world.layout.rebuild();
    expect(at(world, lot.x + 2, lot.y + 3)).toBe(TILE.FLOOR);
  });
});
