import { describe, expect, it } from "vitest";
import { BANK_LOT, deskRoom, desksForLot, TILE, TILES_PER_DESK } from "@muster-town/schema";
import { computeLayout, deriveRoads, doorOf, doorstepOf, findPath, labSize, MAX_TOWN_Y, piecesFor, planLot, ROAD_Y, validateLayout, validatePlan, type Grid, type PlanLot } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const lab = (id: string, x: number, y: number, headcount = 6): PlanLot => {
  const s = labSize(headcount);
  return { id, name: id, kind: "lab", headcount, lot: { x, y: y ?? ROAD_Y - 2 - s.h, w: s.w, h: s.h } };
};

describe("town planning", () => {
  it("the seeded town is a legal plan", () => {
    const { world } = seededWorld();
    expect(validatePlan(world.buildings.all().map(planLot).filter((p): p is PlanLot => !!p))).toEqual([]);
  });

  it("refuses overlaps, touching walls, lots on the road or too small", () => {
    const s = labSize(6);
    const y = ROAD_Y - 2 - s.h;
    expect(validatePlan([lab("a", 2, y), lab("b", 2 + s.w + 1, y)])).toEqual([]);
    expect(validatePlan([lab("a", 2, y), lab("b", 2 + s.w, y)])[0].message).toMatch(/overlap or touch/);
    expect(validatePlan([lab("a", 2, y), lab("b", 5, y - 3)])[0].message).toMatch(/overlap/);
    // b sits right below a's door, between it and the road: a's road goes around it
    const doorX = 2 + Math.floor(s.w / 2);
    expect(validatePlan([lab("a", 2, 2), { ...lab("b", doorX - 3, 2 + s.h + 2, 1) }])).toEqual([]);
    expect(validatePlan([lab("a", 2, ROAD_Y - s.h + 1)])[0].message).toMatch(/main road/);
    expect(validatePlan([lab("a", 2, ROAD_Y + 1)])[0].message).toMatch(/main road/);
    expect(validatePlan([{ ...lab("a", 2, y), lot: { x: 2, y, w: s.w - 1, h: s.h } }])[0].message).toMatch(/at least/);
    expect(validatePlan([lab("a", 0, y)])[0].message).toMatch(/edge/);
  });

  it("allows lots south of the road: door in the top wall, walk up to the road, clear of the Bank", () => {
    const s = labSize(6);
    expect(validatePlan([lab("a", 2, ROAD_Y + 2)])).toEqual([]);
    expect(validatePlan([lab("a", 2, ROAD_Y + 6)])).toEqual([]);
    // b sits right above a's (top) door, between it and the road: a's road goes around it
    const doorX = 2 + Math.floor(s.w / 2);
    expect(validatePlan([lab("a", 2, ROAD_Y + 14), lab("b", doorX - 3, ROAD_Y + 3, 1)])).toEqual([]);
    // a north lot's walk down doesn't care about a south lot across the road
    expect(validatePlan([lab("a", 2, ROAD_Y - 2 - s.h), lab("b", 2, ROAD_Y + 2)])).toEqual([]);
    expect(validatePlan([lab("a", BANK_LOT.x, BANK_LOT.y + 2)])[0].message).toMatch(/the Bank/);
    expect(validatePlan([lab("a", 2, MAX_TOWN_Y)])[0].message).toMatch(/edge/);
  });

  it("derives roads: every door reaches the trunk, no road crosses a building, existing straight walks stay as they were", () => {
    const { world } = seededWorld();
    const plan = world.buildings.all().map(planLot).filter((p): p is PlanLot => !!p);
    const s = labSize(6);
    // a far corner lab, one boxed behind another (b blocks a's straight walk), and one south far from the road
    const right = Math.max(...plan.map((p) => p.lot.x + p.lot.w));
    const extra = [lab("far", right + 30, 1), lab("behind", right + 3, 2), lab("blocker", right + 3, 2 + s.h + 2, 1), lab("south", right + 30, ROAD_Y + 20)];
    const all = [...plan, ...extra];
    expect(validatePlan(all)).toEqual([]);
    const buildings = [...world.buildings.all(), ...extra.map((e) => ({ id: e.id, name: e.name, kind: "lab", headcount: e.headcount, lot: e.lot, furniture: {} }) as never)];
    const { grid, doors } = computeLayout(buildings, new Map(), new Map());
    const at = (x: number, y: number) => grid.tiles[y * grid.w + x];
    const roadOnly: Grid = { ...grid, tiles: grid.tiles.map((t) => (t === TILE.PATH ? TILE.PATH : TILE.WALL)) };
    for (const p of all) {
      const step = doorstepOf(p.lot);
      expect(at(step.x, step.y), p.id).toBe(TILE.PATH);
      // walking only on road tiles from the doorstep reaches the trunk
      expect(findPath(roadOnly, step, { x: 0, y: ROAD_Y }), p.id).not.toBeNull();
      expect(doors.get(p.id)).toEqual(doorOf(p.lot));
    }
    const roads = deriveRoads(all.map((p) => ({ id: p.id, lot: p.lot })), grid.w, grid.h);
    expect(roads.unreached).toEqual([]);
    const inLot = (t: { x: number; y: number }, l: { x: number; y: number; w: number; h: number }) => t.x >= l.x && t.x < l.x + l.w && t.y >= l.y && t.y < l.y + l.h;
    for (const t of roads.tiles) for (const l of [...all.map((p) => p.lot), BANK_LOT]) expect(inLot(t, l)).toBe(false);
    // "behind" turns around "blocker"; the seeded labs keep their straight walk down to the road
    expect(new Set(roads.routes.get("behind")!.map((t) => t.x)).size).toBeGreaterThan(1);
    for (const p of plan) {
      const r = roads.routes.get(p.id)!, d = doorOf(p.lot);
      expect(r.every((t) => t.x === d.x), p.id).toBe(true);
    }
    // deterministic
    expect(deriveRoads(all.map((p) => ({ id: p.id, lot: p.lot })), grid.w, grid.h).tiles).toEqual(roads.tiles);
  });

  it("reports a door no road can reach", () => {
    // a 5-wide strip: b fills the row under a's doorstep from edge to edge, so a is boxed in
    const roads = deriveRoads([{ id: "a", lot: { x: 0, y: 0, w: 5, h: 5 } }, { id: "b", lot: { x: 0, y: 6, w: 5, h: 3 } }], 5, ROAD_Y + 2);
    expect(roads.unreached).toEqual(["a", "bank"]); // the Bank lies off this small grid
    expect(roads.routes.get("b")!.at(-1)).toEqual({ x: 2, y: ROAD_Y - 1 });
  });

  it("builds a south-side lab facing the road, with its room mirrored and every desk reachable", () => {
    const { world, admin, by } = seededWorld();
    const right = Math.max(...world.buildings.all().map((b) => b.lot!.x + b.lot!.w));
    const s = labSize(6);
    const lot = { x: right + 3, y: ROAD_Y + 4, w: s.w, h: s.h };
    const ravi = by("Ravi");
    world.ops.planTown(admin, { "carbon-cycle": lot });
    const door = world.layout.door("carbon-cycle")!;
    expect(door).toEqual({ x: lot.x + Math.floor(lot.w / 2), y: lot.y });
    const at = (x: number, y: number) => world.layout.grid.tiles[y * world.layout.grid.w + x];
    expect(at(door.x, door.y)).toBe(TILE.DOOR);
    expect(at(door.x, ROAD_Y + 2)).toBe(TILE.PATH);
    expect(world.layout.grid.h).toBeGreaterThanOrEqual(lot.y + lot.h);
    expect(findPath(world.layout.grid, { x: door.x, y: ROAD_Y }, world.layout.deskOf(ravi.id)!.pos)).not.toBeNull();
    for (const p of ["board:carbon-cycle", "intray:carbon-cycle", "cabinet:carbon-cycle", "meeting-room:carbon-cycle"]) {
      expect(findPath(world.layout.grid, door, world.layout.requirePlace(p).pos), p).not.toBeNull();
    }
    // the board hangs on the back (bottom) wall
    const board = piecesFor("lab", 6, lot).find((p) => p.key === "board")!;
    expect(board.at.y).toBe(lot.h - 1);
    expect(validateLayout(lot, piecesFor("lab", 6, lot))).toEqual([]);
  });

  it("an admin moves and resizes a lab; the walls, its door path and the residents inside follow", () => {
    const { world, admin, by } = seededWorld();
    const old = world.buildings.require("carbon-cycle").lot!;
    const ravi = by("Ravi");
    const desk = world.layout.deskOf(ravi.id)!.pos;
    world.agents.patch(ravi.id, { pos: desk });
    const lot = { ...old, x: old.x - 6, w: old.w + 2, y: old.y - 4, h: old.h + 4 };
    const dry = world.ops.planPreview(admin, { "carbon-cycle": lot });
    expect(dry.errors).toEqual([]);
    expect(world.buildings.require("carbon-cycle").lot).toEqual(old);
    const { buildings } = world.ops.planTown(admin, { "carbon-cycle": lot });
    expect(buildings[0].lot).toEqual(lot);
    const at = (x: number, y: number) => world.layout.grid.tiles[y * world.layout.grid.w + x];
    expect(at(lot.x, lot.y)).toBe(TILE.WALL);
    const door = world.layout.door("carbon-cycle")!;
    expect(door).toEqual({ x: lot.x + Math.floor(lot.w / 2), y: lot.y + lot.h - 1 });
    expect(findPath(world.layout.grid, door, { x: door.x, y: ROAD_Y })).not.toBeNull();
    // Ravi is still at his desk, which moved with the building
    expect(world.agents.require(ravi.id).pos).toEqual(world.layout.deskOf(ravi.id)!.pos);
    expect(world.layout.buildingAt(world.agents.require(ravi.id).pos)?.id).toBe("carbon-cycle");
    expect(world.events.recent({ limit: 5 }).some((e) => e.type === "town.plan" && e.text.includes("resized"))).toBe(true);
  });

  it("builds a new building on a drawn lot in the same step, and refuses an illegal one", () => {
    const { world, admin } = seededWorld();
    const right = Math.max(...world.buildings.all().map((b) => b.lot!.x + b.lot!.w));
    const s = labSize(2);
    const lot = { x: right + 3, y: ROAD_Y - 2 - s.h, w: s.w + 1, h: s.h };
    expect(() => world.ops.planTown(admin, {}, { name: "Too close", headcount: 2, lot: { ...lot, x: right } })).toThrow(/overlap or touch/);
    const { created } = world.ops.planTown(admin, {}, { name: "Kelp Lab", goal: "kelp", headcount: 2, lot });
    expect(created!.lot).toEqual(lot);
    expect(world.layout.door(created!.id)).toEqual({ x: lot.x + Math.floor(lot.w / 2), y: lot.y + lot.h - 1 });
    expect(world.permissions.can(admin, "building.manage", created!.id)).toBe(true);
  });

  it("desks follow floor space: one per TILES_PER_DESK tiles inside the walls, at least 1, never more than fit (dc_1hjoh9aurq)", () => {
    expect(TILES_PER_DESK).toBe(26);
    // the live town's labs when desks became derived keep their desks
    expect(desksForLot({ w: 15, h: 12 })).toBe(5);
    expect(desksForLot({ w: 15, h: 9 })).toBe(3);
    expect(desksForLot({ w: 13, h: 9 })).toBe(2);
    expect(desksForLot({ w: 21, h: 18 })).toBe(11); // 19×16 = 304 tiles / 26 = 11.7 → 11 (12 would fit)
    expect(desksForLot({ w: 13, h: 38 })).toBe(2); // 11×36 = 396 tiles → 15, but a lab narrower than 15 holds only 2 (labSize)
    for (const w of [13, 14, 15, 20, 30, 48]) for (const h of [9, 10, 12, 20, 38]) {
      const n = desksForLot({ w, h });
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(Math.max(1, deskRoom({ w, h })));
      expect(n).toBeLessThanOrEqual(Math.max(1, Math.floor(((w - 2) * (h - 2)) / TILES_PER_DESK)));
    }
    expect(desksForLot({ w: 3, h: 3 })).toBe(1);
  });

  it("resizing a lab sets its desks from the new floor space; moving keeps them; a client headcount is ignored", () => {
    const { world, admin } = seededWorld();
    const b = world.buildings.require("carbon-cycle"), old = b.lot!;
    const moved = { ...old, x: old.x - 2 };
    world.ops.planTown(admin, { "carbon-cycle": moved });
    expect(world.buildings.require("carbon-cycle").headcount).toBe(b.headcount);
    const big = { ...moved, y: moved.y + moved.h - 20, w: moved.w + 4, h: 20 };
    const dry = world.ops.planPreview(admin, { "carbon-cycle": big });
    expect(dry.errors).toEqual([]);
    expect(dry.places.filter((p) => p.kind === "desk" && p.buildingId === "carbon-cycle")).toHaveLength(desksForLot(big));
    world.ops.planTown(admin, { "carbon-cycle": big });
    expect(world.buildings.require("carbon-cycle").headcount).toBe(desksForLot(big));
    expect(world.events.recent({ limit: 5 }).find((e) => e.type === "town.plan" && e.text.includes("resized"))?.payload).toMatchObject({ desks: { before: b.headcount, after: desksForLot(big) } });
    // shrinking never goes below the desks in use: the plan asks for a lot big enough for them
    const used = world.layout.deskCount("carbon-cycle");
    expect(used).toBeGreaterThan(desksForLot({ w: 13, h: 9 }));
    const small = { ...big, w: 13, h: 9 };
    const err = world.ops.planPreview(admin, { "carbon-cycle": small }).errors;
    expect(err.map((e) => e.message).join(" ")).toMatch(new RegExp(`${used} desks`));
  });

  it("a new building drawn on the map gets its desks from its lot, whatever headcount is sent", () => {
    const { world, admin } = seededWorld();
    const right = Math.max(...world.buildings.all().map((b) => b.lot!.x + b.lot!.w));
    const lot = { x: right + 3, y: ROAD_Y - 2 - 12, w: 15, h: 12 };
    const { created } = world.ops.planTown(admin, {}, { name: "Kelp Lab", headcount: 20, lot });
    expect(created!.headcount).toBe(5);
  });

  it("needs a human with town.manage_buildings", () => {
    const { world, by } = seededWorld();
    const lot = world.buildings.require("carbon-cycle").lot!;
    expect(() => world.ops.planTown(by("Moss"), { "carbon-cycle": { ...lot, x: lot.x - 1 } })).toThrow(/Only humans/);
    const nobody = world.ops.ensureAvatar(world.ops.createUser("Nobody").user.id);
    expect(() => world.ops.planPreview(nobody, {})).toThrow(/town.manage_buildings/);
    expect(() => world.ops.planPreview(null, { nope: lot })).toThrow(/Unknown building/);
  });
});
