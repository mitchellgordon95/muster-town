import { describe, expect, it } from "vitest";
import { layoutBubbles, type Rect } from "../src/map/overlay";

const hits = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (r: Rect, v: Rect) => r.x >= v.x && r.y >= v.y && r.x + r.w <= v.x + v.w && r.y + r.h <= v.y + v.h;

// kr_aba1s2qx7p: every bubble fully on screen, off the HUD card and minimap, and off every other bubble
describe("layoutBubbles", () => {
  const sizes: [string, Rect, Rect[]][] = [
    ["phone 390×844", { x: 0, y: 0, w: 390, h: 844 }, [{ x: 12, y: 12, w: 366, h: 300 }, { x: 12, y: 700, w: 160, h: 128 }]],
    ["desktop 1280×720", { x: 0, y: 0, w: 1280, h: 720 }, [{ x: 12, y: 12, w: 300, h: 500 }, { x: 12, y: 560, w: 200, h: 144 }]],
  ];
  for (const [name, view, avoid] of sizes) it(`keeps bubbles on screen, off the HUD and apart at ${name}`, () => {
    // a crowd: agents in a tight cluster, at every edge, and a wide bubble near the right edge (the live failure)
    const items = [] as { ax: number; ay: number; w: number; h: number }[];
    for (let i = 0; i < 6; i++) items.push({ ax: view.w / 2 + (i % 3) * 20, ay: view.h / 2 + Math.floor(i / 3) * 16, w: 164, h: 38 });
    items.push({ ax: view.w - 10, ay: 400, w: 164, h: 38 }, { ax: view.w - 3, ay: 30, w: 224, h: 52 }, { ax: 330 + 10, ay: view.h - 6, w: 120, h: 24 });
    const boxes = layoutBubbles(items, view, avoid);
    const shown = boxes.filter((b): b is Rect => !!b);
    expect(shown.length).toBe(items.length);
    for (const b of shown) {
      expect(inside(b, view)).toBe(true);
      for (const o of avoid) expect(hits(b, o)).toBe(false);
    }
    for (let i = 0; i < shown.length; i++) for (let j = i + 1; j < shown.length; j++) expect(hits(shown[i], shown[j])).toBe(false);
  });

  it("leaves a lone bubble centred over its agent", () => {
    expect(layoutBubbles([{ ax: 500, ay: 300, w: 100, h: 24 }], { x: 0, y: 0, w: 1280, h: 720 }, [])).toEqual([{ x: 450, y: 269, w: 100, h: 24 }]);
  });

  it("drops a bubble whose agent is off screen or under the HUD", () => {
    const hud = { x: 12, y: 12, w: 300, h: 400 };
    expect(layoutBubbles([{ ax: 1400, ay: 300, w: 100, h: 24 }, { ax: 100, ay: 100, w: 100, h: 24 }], { x: 0, y: 0, w: 1280, h: 720 }, [hud])).toEqual([null, null]);
  });

  it("gives the first item its wanted spot and moves the later one", () => {
    const [a, b] = layoutBubbles([{ ax: 500, ay: 300, w: 100, h: 24 }, { ax: 510, ay: 300, w: 100, h: 24 }], { x: 0, y: 0, w: 1280, h: 720 }, []);
    expect(a).toEqual({ x: 450, y: 269, w: 100, h: 24 });
    expect(hits(a!, b!)).toBe(false);
  });
});
