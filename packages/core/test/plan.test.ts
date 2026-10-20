import { describe, expect, it } from "vitest";
import { TILE } from "@muster-town/schema";
import { findPath, labSize, planLot, ROAD_Y, validatePlan, type PlanLot } from "../src/index.ts";
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

  it("refuses overlaps, touching walls, paths through a building, lots south of the road or too small", () => {
    const s = labSize(6);
    const y = ROAD_Y - 2 - s.h;
    expect(validatePlan([lab("a", 2, y), lab("b", 2 + s.w + 1, y)])).toEqual([]);
    expect(validatePlan([lab("a", 2, y), lab("b", 2 + s.w, y)])[0].message).toMatch(/overlap or touch/);
    expect(validatePlan([lab("a", 2, y), lab("b", 5, y - 3)])[0].message).toMatch(/overlap/);
    // b sits right below a's door, between it and the road
    const doorX = 2 + Math.floor(s.w / 2);
    expect(validatePlan([lab("a", 2, 2), { ...lab("b", doorX - 3, 2 + s.h + 2, 1) }]).some((e) => /path to the road runs through b/.test(e.message))).toBe(true);
    expect(validatePlan([lab("a", 2, ROAD_Y - s.h + 1)])[0].message).toMatch(/north of the road/);
    expect(validatePlan([{ ...lab("a", 2, y), lot: { x: 2, y, w: s.w - 1, h: s.h } }])[0].message).toMatch(/at least/);
    expect(validatePlan([lab("a", 0, y)])[0].message).toMatch(/edge/);
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

  it("needs a human with town.manage_buildings", () => {
    const { world, by } = seededWorld();
    const lot = world.buildings.require("carbon-cycle").lot!;
    expect(() => world.ops.planTown(by("Moss"), { "carbon-cycle": { ...lot, x: lot.x - 1 } })).toThrow(/Only humans/);
    const nobody = world.ops.ensureAvatar(world.ops.createUser("Nobody").user.id);
    expect(() => world.ops.planPreview(nobody, {})).toThrow(/town.manage_buildings/);
    expect(() => world.ops.planPreview(null, { nope: lot })).toThrow(/Unknown building/);
  });
});
