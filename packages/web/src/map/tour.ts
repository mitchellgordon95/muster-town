/**
 * A building's tour (Mitchell's flag dc_qppl7741ci): opening its "?" help sign lights the building and shadows the
 * rest of the town, and each thing the help card lists becomes a numbered hotspot on the map. The help card
 * (panels/HelpSign.tsx) starts and ends the tour; the renderer frames the camera on the lot and draws it (drawTour);
 * MapCanvas routes hover, clicks and taps on hotspots to the callbacks here.
 */
import { TILE } from "@muster-town/schema";
import { roundRect } from "./overlay";

export interface Tour {
  buildingId: string;
  /** the help card's "What's here" things, in its order (hotspot n is row n) */
  spots: { placeId: string; n: number }[];
  /** the hotspot under the mouse, the focused legend row, or the tapped hotspot */
  hot: string | null;
  setHot: (placeId: string | null) => void;
  go: (placeId: string) => void;
  leave: () => void;
}

/** Tiles you walk on, and the walls: never part of a thing's hotspot. */
const NOT_FURNITURE: ReadonlySet<number> = new Set([TILE.GRASS, TILE.PATH, TILE.FLOOR, TILE.WALL, TILE.DOOR, TILE.PAVING]);

/**
 * The tile box a place's thing covers, tiles: a place's spot is where you stand, its furniture is usually next to it.
 * The nearest furniture tile beside the spot, grown over touching tiles of the same kind (at most 2 tiles each way),
 * plus the spot itself; the spot alone when nothing is beside it.
 */
export function spotBox(at: (x: number, y: number) => number, pos: { x: number; y: number }): { x: number; y: number; w: number; h: number } {
  const near = [[0, 0], [0, -1], [-1, 0], [1, 0], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];
  const hit = near.map(([dx, dy]) => ({ x: pos.x + dx, y: pos.y + dy })).find((t) => !NOT_FURNITURE.has(at(t.x, t.y)));
  if (!hit) return { x: pos.x, y: pos.y, w: 1, h: 1 };
  const k = at(hit.x, hit.y);
  let x0 = hit.x, x1 = hit.x, y0 = hit.y, y1 = hit.y;
  while (x0 > hit.x - 2 && at(x0 - 1, hit.y) === k) x0--;
  while (x1 < hit.x + 2 && at(x1 + 1, hit.y) === k) x1++;
  while (y0 > hit.y - 2 && at(hit.x, y0 - 1) === k) y0--;
  while (y1 < hit.y + 2 && at(hit.x, y1 + 1) === k) y1++;
  x0 = Math.min(x0, pos.x); x1 = Math.max(x1, pos.x); y0 = Math.min(y0, pos.y); y1 = Math.max(y1, pos.y);
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

type Rect = { x: number; y: number; w: number; h: number };

/**
 * Screen-space drawing of the tour: the shadow with the lot cut out, a soft paper glow round the lot, then one
 * numbered hotspot per thing (the hot one filled and solid). `spots` are screen rects, canvas CSS px.
 */
export function drawTour(g: CanvasRenderingContext2D, cw: number, ch: number, lot: Rect, spots: (Rect & { id: string; n: number })[], hot: string | null, now: number) {
  g.save();
  g.fillStyle = "rgba(8,9,14,.66)";
  g.beginPath(); g.rect(0, 0, cw, ch); g.rect(lot.x, lot.y, lot.w, lot.h); g.fill("evenodd");
  g.shadowColor = "rgba(251,239,196,.85)"; g.shadowBlur = 22;
  g.strokeStyle = "#fbefc4"; g.lineWidth = 3;
  g.strokeRect(lot.x - 1.5, lot.y - 1.5, lot.w + 3, lot.h + 3);
  g.restore();
  const pulse = 0.55 + 0.45 * Math.sin(now / 420);
  for (const s of spots) {
    const on = s.id === hot;
    g.save();
    roundRect(g, s.x, s.y, s.w, s.h, 6);
    if (on) { g.fillStyle = "rgba(251,239,196,.28)"; g.fill(); }
    g.setLineDash(on ? [] : [5, 4]);
    g.lineWidth = on ? 3 : 2;
    g.strokeStyle = on ? "#fbefc4" : `rgba(251,239,196,${0.5 + 0.4 * pulse})`;
    g.stroke();
    g.restore();
    // the number disc on the top-left corner: ink on paper, like the card's step numbers
    const r = 9, cx = s.x + 2, cy = s.y + 2;
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fillStyle = on ? "#3b2f12" : "#fbefc4"; g.fill();
    g.lineWidth = 2; g.strokeStyle = "#3b2f12"; g.stroke();
    g.fillStyle = on ? "#fbefc4" : "#3b2f12";
    g.font = "700 11px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(String(s.n), cx, cy + 0.5);
  }
  g.textAlign = "left"; g.textBaseline = "alphabetic";
}
