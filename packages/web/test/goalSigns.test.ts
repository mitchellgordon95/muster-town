import { describe, expect, it } from "vitest";
import { placeGoalSigns } from "../src/map/overlay";

const view = { x: 0, y: 0, w: 390, h: 844 };
const hud = { x: 8, y: 8, w: 180, h: 200 };
// each label draws as wide as its room allows, so the test sees the widest case
const run = (items: { x: number; y: number; max: number }[], avoid = [hud]) => placeGoalSigns(items, view, avoid, (_, x, _y, max) => x + max + 10);

describe("goal signs on the map (kr_c3c7651d18)", () => {
  it("keeps a label where its signpost is when nothing is in the way", () => {
    expect(run([{ x: 100, y: 400, max: 220 }])).toEqual([{ x: 100, y: 400, max: 220 }]);
  });

  it("slides a label that starts off the left edge back on screen", () => {
    expect(run([{ x: -60, y: 400, max: 220 }])[0]?.x).toBe(4);
  });

  it("slides a label under the HUD card out to its right and fits it before the screen edge", () => {
    const [p] = run([{ x: 20, y: 100, max: 220 }]);
    expect(p!.x).toBeGreaterThanOrEqual(hud.x + hud.w);
    expect(p!.x + p!.max + 10).toBeLessThanOrEqual(view.w - 4);
  });

  it("leaves labels on rows the HUD doesn't reach alone", () => {
    expect(run([{ x: 20, y: 300, max: 100 }])[0]?.x).toBe(20);
  });

  it("stops short of the next signpost on the row and of a minimap on it", () => {
    const minimap = { x: 300, y: 700, w: 80, h: 120 };
    const [a, b] = run([{ x: 20, y: 760, max: 220 }, { x: 150, y: 760, max: 220 }], [minimap]);
    expect(a!.x + a!.max + 10).toBeLessThanOrEqual(150);
    expect(b!.x + b!.max + 10).toBeLessThanOrEqual(minimap.x);
  });

  it("lines up two labels hidden under the HUD one after the other instead of on top of each other", () => {
    const [a, b] = run([{ x: 20, y: 100, max: 60 }, { x: 60, y: 100, max: 60 }]);
    expect(a!.x).toBeGreaterThanOrEqual(hud.x + hud.w);
    expect(b!.x).toBeGreaterThanOrEqual(a!.x + a!.max + 10);
  });

  it("moves a label whose post is at the top edge down inside the view", () => {
    expect(run([{ x: 250, y: 6, max: 100 }])[0]?.y).toBe(4 + 15);
  });

  it("slides a label squeezed by the right edge back left so its words still fit", () => {
    const [p] = run([{ x: 360, y: 500, max: 120 }]);
    expect(p).toEqual({ x: 390 - 4 - 10 - 120, y: 500, max: 120 });
  });

  it("draws nothing for a signpost off screen to the right or below", () => {
    expect(run([{ x: 500, y: 400, max: 100 }, { x: 100, y: 900, max: 100 }])).toEqual([null, null]);
  });
});
