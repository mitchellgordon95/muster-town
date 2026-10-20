/** Static world layer: the grid baked into one bitmap, plus walkability and lookups. */
import { TILE, WALKABLE } from "@agent-town/schema";
import type { Building, Place } from "@agent-town/schema";
import type { Grid } from "../api";
import { T, tiles, drawTable, drawCounter, drawDoor, drawManagerDesk, drawBoard, drawDonation, drawSchedule } from "./sprites";

export class World {
  readonly w: number;
  readonly h: number;
  readonly bitmap: HTMLCanvasElement;
  private readonly t: number[];

  constructor(grid: Grid, readonly buildings: Building[], readonly places: Place[]) {
    this.w = grid.w; this.h = grid.h; this.t = grid.tiles;
    this.bitmap = document.createElement("canvas");
    this.bitmap.width = this.w * T; this.bitmap.height = this.h * T;
    this.bake();
  }

  at(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return TILE.WALL;
    return this.t[y * this.w + x];
  }
  walkable(x: number, y: number): boolean { return WALKABLE.has(this.at(x, y)); }
  /** Pixel-space walkability (world px). */
  walkablePx(px: number, py: number): boolean { return this.walkable(Math.floor(px / T), Math.floor(py / T)); }

  buildingAt(x: number, y: number): Building | null {
    for (const b of this.buildings) {
      const l = b.lot;
      if (l && x >= l.x && y >= l.y && x < l.x + l.w && y < l.y + l.h) return b;
    }
    return null;
  }

  /** Pixel offset for a body standing at (x,y): agents at a desk sit tucked under it, centred on the 2-tile desk. */
  seatOffset(x: number, y: number): { dx: number; dy: number } {
    if (this.at(x, y - 1) !== TILE.DESK) return { dx: 0, dy: 0 };
    const leftIsDesk = this.at(x - 1, y - 1) === TILE.DESK;
    const run = this.deskRunIndex(x, y - 1);
    return { dx: run % 2 === 0 ? 8 : leftIsDesk ? -8 : 0, dy: -7 };
  }
  private deskRunIndex(x: number, y: number): number {
    let i = 0;
    while (this.at(x - 1 - i, y) === TILE.DESK) i++;
    return i;
  }

  /** Shortest 4-neighbour path over walkable tiles, excluding `from`; null when unreachable. */
  path(from: { x: number; y: number }, to: { x: number; y: number }): { x: number; y: number }[] | null {
    const W = this.w, start = from.y * W + from.x, goal = to.y * W + to.x;
    if (start === goal) return [];
    const prev = new Int32Array(this.w * this.h).fill(-1);
    prev[start] = start;
    const q = [start];
    for (let i = 0; i < q.length; i++) {
      const cur = q[i];
      if (cur === goal) break;
      const x = cur % W, y = (cur / W) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (!this.walkable(nx, ny)) continue;
        const ni = ny * W + nx;
        if (prev[ni] === -1) { prev[ni] = cur; q.push(ni); }
      }
    }
    if (prev[goal] === -1) return null;
    const out: { x: number; y: number }[] = [];
    for (let c = goal; c !== start; c = prev[c]) out.push({ x: c % W, y: (c / W) | 0 });
    return out.reverse();
  }

  /** Nearest walkable tile to (x,y), searching outward. */
  nearestWalkable(x: number, y: number): { x: number; y: number } {
    for (let r = 0; r < 8; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (this.walkable(x + dx, y + dy)) return { x: x + dx, y: y + dy };
        }
    return { x, y };
  }

  private bake() {
    const g = this.bitmap.getContext("2d")!;
    g.imageSmoothingEnabled = false;
    const tl = tiles();
    for (let y = 0; y < this.h; y++)
      for (let x = 0; x < this.w; x++) {
        const k = this.at(x, y), px = x * T, py = y * T;
        const b = this.buildingAt(x, y);
        const floor = b?.kind === "town-hall" ? tl.stone : tl.wood;
        // ground under furniture
        if (k === TILE.GRASS || k === TILE.PLANT && !b) g.drawImage(tl.grass, px, py);
        else if (k === TILE.PATH) g.drawImage(tl.path, px, py);
        else if (k !== TILE.WALL && k !== TILE.BOARD) g.drawImage(floor, px, py);
        switch (k) {
          case TILE.WALL: g.drawImage(this.at(x, y + 1) === TILE.WALL ? tl.wallTop : tl.wallFace, px, py); break;
          case TILE.DESK: {
            const i = this.deskRunIndex(x, y);
            const lone = i % 2 === 0 && this.at(x + 1, y) !== TILE.DESK;
            g.drawImage(lone ? tl.deskPlain : i % 2 === 0 ? tl.deskL : tl.deskR, px, py);
            break;
          }
          case TILE.SHELF: g.drawImage(tl.shelf, px, py); break;
          case TILE.PLANT: g.drawImage(tl.plant, px, py); break;
          case TILE.TROPHY: g.drawImage(tl.trophy, px, py); break;
          case TILE.DOOR: drawDoor(g, px, py); break;
          case TILE.MANAGER_DESK: drawManagerDesk(g, px, py); break;
          case TILE.BOARD: g.drawImage(tl.wallFace, px, py); drawBoard(g, px, py); break;
          case TILE.DONATION: drawDonation(g, px, py); break;
          case TILE.SCHEDULE: drawSchedule(g, px, py); break;
          case TILE.TABLE: drawTable(g, px, py, {
            l: this.at(x - 1, y) === TILE.TABLE, r: this.at(x + 1, y) === TILE.TABLE,
            u: this.at(x, y - 1) === TILE.TABLE, d: this.at(x, y + 1) === TILE.TABLE,
          }); break;
          case TILE.COUNTER: drawCounter(g, px, py, { l: this.at(x - 1, y) === TILE.COUNTER, r: this.at(x + 1, y) === TILE.COUNTER }, (x + y) % 2 === 0); break;
        }
      }
    // soft shadow under the bottom wall of each building
    g.fillStyle = "rgba(0,0,0,0.18)";
    for (const b of this.buildings) {
      const l = b.lot;
      if (!l) continue;
      for (let x = l.x; x < l.x + l.w; x++) if (this.at(x, l.y + l.h) !== TILE.WALL && this.at(x, l.y + l.h - 1) === TILE.WALL) g.fillRect(x * T, (l.y + l.h) * T, T, 3);
    }
  }
}
