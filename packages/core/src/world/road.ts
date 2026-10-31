import { BANK_FIXTURES, type Building, type Lot, type Tile } from "@muster-town/schema";
import type { TreeLayout } from "./tree.ts";

/**
 * Which wall a building's door is in (1:1 mt_3ldf9p5av1: doors on any side, so buildings can stand back to back and
 * side by side). The layout may set a building's side (`TreeLayout.sides`); otherwise the Town Hall's door is in its
 * bottom wall and a lab's goes in the wall facing its nearest road (`deriveRoads`).
 */
export type Side = "n" | "s" | "e" | "w";
/** The side a building has when nothing else decides it: the Town Hall faces south, a lab north (it hangs below a street). */
export const defaultSide = (kind: Building["kind"]): Side => (kind === "town-hall" ? "s" : "n");

/**
 * The door tile: the middle of the top or bottom wall; on a side wall, three rows up from the bottom (clear of every
 * piece of a lab's default room: furniture.ts).
 */
export const doorOf = (lot: Lot, side: Side): Tile =>
  side === "n" ? { x: lot.x + Math.floor(lot.w / 2), y: lot.y }
  : side === "s" ? { x: lot.x + Math.floor(lot.w / 2), y: lot.y + lot.h - 1 }
  : { x: side === "w" ? lot.x : lot.x + lot.w - 1, y: lot.y + lot.h - 3 };

const STEP: Record<Side, Tile> = { n: { x: 0, y: -1 }, s: { x: 0, y: 1 }, w: { x: -1, y: 0 }, e: { x: 1, y: 0 } };
/** One tile from `t` towards `side`. */
const stepOut = (t: Tile, side: Side): Tile => ({ x: t.x + STEP[side].x, y: t.y + STEP[side].y });
/** The tile just outside the door: on the street. */
export const doorstepOf = (lot: Lot, side: Side): Tile => stepOut(doorOf(lot, side), side);
/** The tile just inside the door. */
export const insideOf = (lot: Lot, side: Side): Tile => stepOut(doorOf(lot, side), side === "n" ? "s" : side === "s" ? "n" : side === "e" ? "w" : "e");

/** Extra cost of a turn, so roads run in long straight segments. */
const TURN = 4;
const DIRS = [[0, 1], [0, -1], [1, 0], [-1, 0]] as const;
/** the router's heading leaving a door on each side */
const HEADING: Record<Side, number> = { s: 0, n: 1, e: 2, w: 3 };

export interface Roads {
  /** every road tile: the streets and the drops between them */
  tiles: Tile[];
  /** per door (building id; the Bank's is `bank`): the road from its doorstep to the nearest street, first tile first; empty when the doorstep is on one */
  routes: Map<string, Tile[]>;
  /** doors no road can reach (empty on any map treeLayout makes) */
  unreached: string[];
  /** the wall each building's door is in */
  sides: Map<string, Side>;
}

/**
 * The road layer, derived from the tree layout alone (nothing is stored): every street and every drop (treeLayout's
 * `edges`) is road. Each building's door goes in the wall the layout gave it (`tree.sides`), else the default; then each
 * door gets a road from its doorstep to the nearest road, found by a grid router that never enters a lot, a signpost or the town's decor and prefers straight
 * segments (a turn costs TURN steps). treeLayout puts every doorstep on a street, so those are empty. Deterministic.
 */
export function deriveRoads(lots: { id: string; kind: Building["kind"]; lot: Lot }[], tree: Pick<TreeLayout, "plazas" | "edges" | "bank" | "sides" | "decor">, w: number, h: number): Roads {
  const road = new Uint8Array(w * h), blocked = new Uint8Array(w * h);
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h;
  const fill = (l: Lot, a: Uint8Array, v: number) => {
    for (let y = Math.max(0, l.y); y < Math.min(h, l.y + l.h); y++) for (let x = Math.max(0, l.x); x < Math.min(w, l.x + l.w); x++) a[y * w + x] = v;
  };
  for (const { lot } of lots) fill(lot, blocked, 1);
  fill(tree.bank, blocked, 1);
  for (const p of tree.plazas) {
    if (p.street) fill(p.street, road, 1);
    if (p.sign && inside(p.sign.x, p.sign.y)) blocked[p.sign.y * w + p.sign.x] = 1;
  }
  // a fountain stands in its plaza: no road, and no route through it
  for (const p of tree.plazas) if (p.fountain) { fill(p.fountain, road, 0); fill(p.fountain, blocked, 1); }
  for (const e of tree.edges.values()) for (const t of e) if (inside(t.x, t.y)) road[t.y * w + t.x] = 1;
  for (const d of tree.decor ?? []) if (inside(d.at.x, d.at.y)) blocked[d.at.y * w + d.at.x] = 1;
  const sides = pickSides(lots, tree.sides);
  const routes = new Map<string, Tile[]>(), unreached: string[] = [];
  const go = (id: string, from: Tile, dir: number) => {
    const r = route(from, dir, w, h, road.slice(), blocked);
    if (!r) { unreached.push(id); return; }
    for (const t of r) road[t.y * w + t.x] = 1;
    routes.set(id, r);
  };
  // in id order, so the roads don't depend on the order the buildings arrive in
  for (const b of [...lots].sort((x, y) => x.id.localeCompare(y.id))) { const side = sides.get(b.id)!; go(b.id, doorstepOf(b.lot, side), HEADING[side]); }
  go("bank", { x: tree.bank.x + BANK_FIXTURES.door.x, y: tree.bank.y - 1 }, HEADING.n);
  const tiles: Tile[] = [];
  for (let i = 0; i < w * h; i++) if (road[i]) tiles.push({ x: i % w, y: Math.floor(i / w) });
  return { tiles, routes, unreached: unreached.sort(), sides };
}

/** Each building's door side: the layout's, else the default. */
function pickSides(lots: { id: string; kind: Building["kind"] }[], given: Map<string, Side> | undefined): Map<string, Side> {
  return new Map(lots.map((b) => [b.id, given?.get(b.id) ?? defaultSide(b.kind)]));
}

/** Cheapest walk from `from` (leaving in direction `dir`) to a target tile, over unblocked tiles; the target tile itself excluded. */
export function route(from: Tile, dir: number, w: number, h: number, road: Uint8Array, blocked: Uint8Array): Tile[] | null {
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h;
  if (!inside(from.x, from.y) || blocked[from.y * w + from.x]) return null;
  if (road[from.y * w + from.x]) return [];
  // Dijkstra over (tile, heading); ties go to the earlier push, so the result is deterministic
  const cost = new Float64Array(w * h * 4).fill(Infinity), prev = new Int32Array(w * h * 4).fill(-1);
  const heap: [number, number, number][] = [];
  let seq = 0;
  const push = (c: number, s: number) => {
    heap.push([c, seq++, s]);
    for (let i = heap.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (heap[p][0] < heap[i][0] || (heap[p][0] === heap[i][0] && heap[p][1] < heap[i][1])) break;
      [heap[p], heap[i]] = [heap[i], heap[p]]; i = p;
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        for (const c of [l, r]) if (c < heap.length && (heap[c][0] < heap[m][0] || (heap[c][0] === heap[m][0] && heap[c][1] < heap[m][1]))) m = c;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
      }
    }
    return top;
  };
  const start = (from.y * w + from.x) * 4 + dir;
  cost[start] = 0; push(0, start);
  while (heap.length) {
    const [c, , s] = pop();
    if (c > cost[s]) continue;
    const t = s >> 2, d = s & 3, x = t % w, y = (t - x) / w;
    if (road[t]) {
      const out: Tile[] = [];
      for (let i = prev[s]; ; i = prev[i]) { const ti = i >> 2; out.push({ x: ti % w, y: Math.floor(ti / w) }); if (i === start) break; }
      return out.reverse();
    }
    for (let nd = 0; nd < 4; nd++) {
      const nx = x + DIRS[nd][0], ny = y + DIRS[nd][1];
      if (!inside(nx, ny) || blocked[ny * w + nx]) continue;
      if (DIRS[nd][0] === -DIRS[d][0] && DIRS[nd][1] === -DIRS[d][1]) continue;
      const ns = (ny * w + nx) * 4 + nd, nc = c + 1 + (nd === d ? 0 : TURN);
      if (nc < cost[ns]) { cost[ns] = nc; prev[ns] = s; push(nc, ns); }
    }
  }
  return null;
}

