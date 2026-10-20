import { describe, expect, it } from "vitest";
import { OverviewCam, quickWalkGoal } from "../src/map/overview";

// "." walkable, "#" not: a room (walls, a door "D" at the bottom) beside a fenced-off patch "x" of grass
const rows = [
  ".........",
  ".#####.x.",
  ".#...#.xx",
  ".##D##...",
  ".........",
];
const m = { w: rows[0].length, h: rows.length, walkable: (x: number, y: number) => rows[y][x] === "." || rows[y][x] === "D" };

describe("minimap quick-walk", () => {
  const from = { x: 0, y: 4 };
  it("walks straight to a reachable tile, inside a building too", () => {
    expect(quickWalkGoal(m, from, { x: 8, y: 0 })).toEqual({ x: 8, y: 0 });
    expect(quickWalkGoal(m, from, { x: 3, y: 2 })).toEqual({ x: 3, y: 2 });
  });
  it("walks a click on a building's wall to its door", () => {
    expect(quickWalkGoal(m, from, { x: 2, y: 1 }, { x: 3, y: 3 })).toEqual({ x: 3, y: 3 });
  });
  it("walks anything else unreachable to the nearest reachable tile", () => {
    expect(quickWalkGoal(m, from, { x: 7, y: 2 })).toEqual({ x: 7, y: 3 });
    expect(quickWalkGoal(m, from, { x: 2, y: 1 })).toEqual({ x: 2, y: 2 });
  });
});

describe("overview camera", () => {
  it("maps world px to the view and back, and keeps the view over the world", () => {
    const c = new OverviewCam(200, 100);
    c.z = c.fit(1000, 1000) * 2; // 0.2
    c.cx = 0; c.cy = 0; c.clamp(1000, 1000);
    expect(c.cx).toBe(500); expect(c.cy).toBe(250);
    const p = c.toScreen(500, 250);
    expect(p).toEqual({ x: 100, y: 50 });
    expect(c.toWorld(p.x, p.y)).toEqual({ x: 500, y: 250 });
  });
});
