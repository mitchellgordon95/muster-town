/**
 * The zoomed-out town: the world bitmap drawn small, building lots outlined, people as dots. Shared by the minimap
 * (bottom left) and town planning; the Bank's town map uses the same `fitZoom` to frame the whole town.
 * Pure drawing plus a small camera (`OverviewCam`): callers own their canvas, input and loop.
 */
import type { Building } from "@muster-town/schema";
import type { World } from "./world";
import { T } from "./sprites";
import { roundRect } from "./overlay";

const FONT = "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif";

/** The largest zoom that shows the whole world (`ww`×`wh` world px) in the view, with a margin; never above `max`. */
export function fitZoom(ww: number, wh: number, viewW: number, viewH: number, max: number): number {
  return Math.max(0.5, Math.min(max, (viewW * 0.92) / ww, (viewH * 0.8) / wh));
}

/** A camera over the world: `cx`,`cy` is the world px at the middle of the view, `z` is screen px per world px. */
export class OverviewCam {
  cx = 0; cy = 0; z = 1;
  constructor(public w: number, public h: number) {}
  /** World px to view px, and back. */
  toScreen(x: number, y: number) { return { x: (x - this.cx) * this.z + this.w / 2, y: (y - this.cy) * this.z + this.h / 2 }; }
  toWorld(x: number, y: number) { return { x: (x - this.w / 2) / this.z + this.cx, y: (y - this.h / 2) / this.z + this.cy }; }
  tileAt(x: number, y: number) { const p = this.toWorld(x, y); return { x: Math.floor(p.x / T), y: Math.floor(p.y / T) }; }
  /** Zoom that fits the whole world (`ww`×`wh` world px) in the view, edge to edge. */
  fit(ww: number, wh: number) { return Math.min(this.w / ww, this.h / wh); }
  /** Keep the view over the world: centred on an axis the world doesn't fill, else no further than its edges. */
  clamp(ww: number, wh: number) {
    const hw = this.w / 2 / this.z, hh = this.h / 2 / this.z;
    this.cx = ww <= 2 * hw ? ww / 2 : Math.max(hw, Math.min(ww - hw, this.cx));
    this.cy = wh <= 2 * hh ? wh / 2 : Math.max(hh, Math.min(wh - hh, this.cy));
  }
}

export interface OverviewDot { x: number; y: number; color: string; me?: boolean }
export interface OverviewOpts {
  /** people (world px, at their feet) */
  dots?: OverviewDot[];
  /** a rectangle in world px to outline, e.g. what the main view shows */
  frame?: { x: number; y: number; w: number; h: number } | null;
  /** a tile to highlight (under the pointer) and the building it's in, outlined and named */
  hover?: { x: number; y: number; building: Building | null } | null;
  /** name every building whose lot is at least this wide on screen (px); Infinity for none */
  labelMinPx?: number;
}

/** Draw the overview into `g`, already scaled to CSS px; fills the camera's whole view. */
export function drawOverview(g: CanvasRenderingContext2D, world: World, cam: OverviewCam, opts: OverviewOpts = {}) {
  const { z } = cam, o = cam.toScreen(0, 0);
  g.fillStyle = "#3f6e36";
  g.fillRect(0, 0, cam.w, cam.h);
  // smoothing on: the pixel art is shrunk well below 1:1 here, and nearest-neighbour would drop whole rows
  g.imageSmoothingEnabled = z < 1;
  g.imageSmoothingQuality = "medium";
  g.drawImage(world.bitmap, o.x, o.y, world.w * T * z, world.h * T * z);
  g.imageSmoothingEnabled = false;

  const lot = (l: { x: number; y: number; w: number; h: number }) => {
    const p = cam.toScreen(l.x * T, l.y * T);
    return { x: p.x, y: p.y, w: l.w * T * z, h: l.h * T * z };
  };
  const labelMin = opts.labelMinPx ?? 70;
  g.font = `600 10px ${FONT}`; g.textAlign = "center"; g.textBaseline = "middle";
  for (const b of world.buildings) {
    if (!b.lot) continue;
    const r = lot(b.lot);
    if (r.w < labelMin) continue;
    const tw = g.measureText(b.name).width + 8;
    g.fillStyle = "rgba(20,21,28,.75)";
    roundRect(g, r.x + r.w / 2 - tw / 2, r.y - 7, tw, 14, 4); g.fill();
    g.fillStyle = "#e8e8f0"; g.fillText(b.name, r.x + r.w / 2, r.y);
  }
  g.textAlign = "left";

  for (const d of opts.dots ?? []) {
    const p = cam.toScreen(d.x, d.y - 4);
    const r = d.me ? 3.5 : 2.5;
    g.fillStyle = d.me ? "#14151c" : "rgba(0,0,0,.55)";
    g.beginPath(); g.arc(p.x, p.y, r + 1.2, 0, Math.PI * 2); g.fill();
    if (d.me) { g.strokeStyle = "#ffd34d"; g.lineWidth = 1.5; g.beginPath(); g.arc(p.x, p.y, r + 3, 0, Math.PI * 2); g.stroke(); }
    g.fillStyle = d.color;
    g.beginPath(); g.arc(p.x, p.y, r, 0, Math.PI * 2); g.fill();
  }

  if (opts.frame) {
    const f = opts.frame, p = cam.toScreen(f.x, f.y);
    g.strokeStyle = "rgba(255,255,255,.85)"; g.lineWidth = 1;
    g.strokeRect(Math.round(p.x) + 0.5, Math.round(p.y) + 0.5, Math.round(f.w * z), Math.round(f.h * z));
  }

  const h = opts.hover;
  if (h) {
    if (h.building?.lot) {
      const r = lot(h.building.lot);
      g.strokeStyle = "#ffd34d"; g.lineWidth = 1.5;
      g.strokeRect(r.x, r.y, r.w, r.h);
    }
    const p = cam.toScreen(h.x * T, h.y * T), s = Math.max(3, T * z);
    g.strokeStyle = "#ffd34d"; g.lineWidth = 1.5;
    g.strokeRect(p.x, p.y, s, s);
  }
}

type Tile = { x: number; y: number };

/**
 * Where a click on tile `to` walks you from `from`: the tile itself when you can reach it; else `door` (a clicked
 * building's door) when you can reach that; else the reachable tile nearest the click, fewest steps on a tie.
 */
export function quickWalkGoal(m: { w: number; h: number; walkable(x: number, y: number): boolean }, from: Tile, to: Tile, door: Tile | null = null): Tile {
  const W = m.w, seen = new Uint8Array(m.w * m.h);
  const ok = (x: number, y: number) => x >= 0 && y >= 0 && x < m.w && y < m.h && m.walkable(x, y);
  if (!ok(from.x, from.y)) return from;
  seen[from.y * W + from.x] = 1;
  const q = [from.y * W + from.x];
  let best = from, bestD = Infinity;
  for (let i = 0; i < q.length; i++) {
    const x = q[i] % W, y = (q[i] / W) | 0;
    if (x === to.x && y === to.y) return to;
    const d = (x - to.x) ** 2 + (y - to.y) ** 2;
    if (d < bestD) { bestD = d; best = { x, y }; }
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (!ok(nx, ny) || seen[ny * W + nx]) continue;
      seen[ny * W + nx] = 1; q.push(ny * W + nx);
    }
  }
  if (door && seen[door.y * W + door.x]) return door;
  return best;
}
