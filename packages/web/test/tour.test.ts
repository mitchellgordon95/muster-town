import { describe, expect, it } from "vitest";
import { TILE } from "@muster-town/schema";
import { spotBox } from "../src/map/tour";

/** a tiny room: rows of tile kinds, everything else floor */
const room = (rows: number[][]) => (x: number, y: number) => rows[y]?.[x] ?? TILE.FLOOR;
const W = TILE.WALL, F = TILE.FLOOR, B = TILE.BOARD, D = TILE.DESK;

describe("spotBox (a help-sign tour hotspot)", () => {
  it("covers the furniture beside the spot and the spot itself", () => {
    const at = room([[W, B, B, W], [F, F, F, F]]);
    expect(spotBox(at, { x: 1, y: 1 })).toEqual({ x: 1, y: 0, w: 2, h: 2 });
  });
  it("is the spot alone when nothing stands beside it, and never takes walls", () => {
    const at = room([[W, W, W], [F, F, F], [F, F, F]]);
    expect(spotBox(at, { x: 1, y: 1 })).toEqual({ x: 1, y: 1, w: 1, h: 1 });
  });
  it("grows at most two tiles each way along a long row of desks", () => {
    const at = room([[F, F, F, F, F, F, F, F], [D, D, D, D, D, D, D, D], [F, F, F, F, F, F, F, F]]);
    expect(spotBox(at, { x: 4, y: 2 })).toEqual({ x: 2, y: 1, w: 5, h: 2 });
  });
});
