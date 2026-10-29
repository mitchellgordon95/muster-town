import { BANK_FIXTURES, BANK_LOT, type Lot, type Tile } from "@muster-town/schema";

/** y of the main road (2 tiles tall). Fixed so lots stay stable. */
export const ROAD_Y = 40;

/** A lot south of the road faces it: its door is in the top wall and its room is laid out mirrored. */
export const facesNorth = (lot: Pick<Lot, "h"> & { y?: number }) => lot.y !== undefined && lot.y >= ROAD_Y + 2;

/** The door tile: bottom middle, or top middle for a lot south of the road. */
export const doorOf = (lot: Lot) => ({ x: lot.x + Math.floor(lot.w / 2), y: facesNorth(lot) ? lot.y : lot.y + lot.h - 1 });

/** The grass tile just outside the door, where the building's road starts. */
export const doorstepOf = (lot: Lot): Tile => {
  const d = doorOf(lot);
  return { x: d.x, y: facesNorth(lot) ? d.y - 1 : d.y + 1 };
};

/** Extra cost of a turn, so roads run in long straight segments. */
const TURN = 4;
const DIRS = [[0, 1], [0, -1], [1, 0], [-1, 0]] as const;

export interface Roads {
  /** every road tile: the trunk road plus each building's derived road */
  tiles: Tile[];
  /** derived road per building id (the Bank's is `bank`), doorstep first; empty when the doorstep is already road */
  routes: Map<string, Tile[]>;
  /** buildings whose door can't reach the road */
  unreached: string[];
}

/**
 * The road layer, derived from the lots alone (so nothing is stored): the two-row trunk road at ROAD_Y, then for
 * each building (and the Bank) a road from its doorstep to the nearest road tile, found by a grid router that never
 * enters a lot, prefers straight segments (a turn costs TURN steps) and stops as soon as it meets the trunk or a road
 * already routed. Buildings nearest the trunk route first, so farther ones merge onto their roads. Deterministic:
 * the same lots always give the same roads.
 */
export function deriveRoads(lots: { id: string; lot: Lot }[], w: number, h: number): Roads {
  const road = new Uint8Array(w * h), blocked = new Uint8Array(w * h);
  const all = [...lots, { id: "bank", lot: BANK_LOT as Lot }];
  for (const { lot } of all) {
    for (let y = Math.max(0, lot.y); y < Math.min(h, lot.y + lot.h); y++) for (let x = Math.max(0, lot.x); x < Math.min(w, lot.x + lot.w); x++) blocked[y * w + x] = 1;
  }
  for (let x = 0; x < w; x++) for (const y of [ROAD_Y, ROAD_Y + 1]) if (y < h) road[y * w + x] = 1;
  const starts = all.map(({ id, lot }) => ({ id, step: id === "bank" ? { x: BANK_LOT.x + BANK_FIXTURES.door.x, y: BANK_LOT.y - 1 } : doorstepOf(lot), out: id === "bank" || facesNorth(lot) ? 1 : 0 }));
  const gap = (t: Tile) => (t.y < ROAD_Y ? ROAD_Y - t.y : Math.max(0, t.y - ROAD_Y - 1));
  starts.sort((a, b) => gap(a.step) - gap(b.step) || a.step.x - b.step.x || a.step.y - b.step.y || a.id.localeCompare(b.id));
  const routes = new Map<string, Tile[]>(), unreached: string[] = [];
  for (const s of starts) {
    const r = route(s.step, s.out, w, h, road, blocked);
    if (!r) { unreached.push(s.id); continue; }
    for (const t of r) road[t.y * w + t.x] = 1;
    routes.set(s.id, r);
  }
  const tiles: Tile[] = [];
  for (let i = 0; i < w * h; i++) if (road[i]) tiles.push({ x: i % w, y: Math.floor(i / w) });
  return { tiles, routes, unreached: unreached.sort() };
}

/** Cheapest walk from `from` (leaving in direction `dir`) to a road tile, over unblocked tiles; the road tile itself excluded. */
function route(from: Tile, dir: number, w: number, h: number, road: Uint8Array, blocked: Uint8Array): Tile[] | null {
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

