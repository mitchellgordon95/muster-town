/**
 * Mock-only town layout, following the contract's "World model": a road at the bottom, the Town Hall
 * centred above it, labs alternating left/right in creation order, 3 desks per row, a meeting table
 * at the bottom-right of each lab, door at bottom centre. Core owns the real layout.
 */
import { TILE, WALKABLE } from "@agent-town/schema";
import type { Agent, Building, Place } from "@agent-town/schema";
import type { Grid } from "../api";

export interface Layout { grid: Grid; places: Place[]; lots: Map<string, NonNullable<Building["lot"]>> }

const LAB_W = 14, HALL_W = 19, HALL_H = 12, GAP = 4, MARGIN = 3;
const labH = (headcount: number) => 2 + Math.ceil(headcount / 3) * 3 + 4;

export function computeLayout(buildings: Building[], agents: Agent[]): Layout {
  const hall = buildings.find((b) => b.kind === "town-hall");
  const labs = buildings.filter((b) => b.kind !== "town-hall");
  const left = labs.filter((_, i) => i % 2 === 0), right = labs.filter((_, i) => i % 2 === 1);
  const ordered = [...left.reverse(), ...(hall ? [hall] : []), ...right];
  const size = (b: Building) => (b.kind === "town-hall" ? { w: HALL_W, h: HALL_H } : { w: LAB_W, h: labH(b.headcount) });
  const maxH = Math.max(HALL_H, ...ordered.map((b) => size(b).h));
  const W = MARGIN * 2 + ordered.reduce((s, b) => s + size(b).w, 0) + GAP * Math.max(0, ordered.length - 1);
  const top = 4;
  const roadY = top + maxH + 3;
  const H = roadY + 2 + 4;
  const t = new Array<number>(W * H).fill(TILE.GRASS);
  const set = (x: number, y: number, k: number) => { if (x >= 0 && y >= 0 && x < W && y < H) t[y * W + x] = k; };
  const places: Place[] = [];
  const lots = new Map<string, NonNullable<Building["lot"]>>();

  for (let x = 0; x < W; x++) { set(x, roadY, TILE.PATH); set(x, roadY + 1, TILE.PATH); }
  for (let x = 2; x < W - 1; x += 6) set(x, roadY + 3, TILE.PLANT);
  for (let x = 1; x < W - 1; x += 9) set(x, 1, TILE.PLANT);

  let cx = MARGIN;
  for (const b of ordered) {
    const { w, h } = size(b);
    const x0 = cx, y0 = roadY - 3 - h;
    lots.set(b.id, { x: x0, y: y0, w, h });
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) set(x0 + x, y0 + y, x === 0 || y === 0 || x === w - 1 || y === h - 1 ? TILE.WALL : TILE.FLOOR);
    const doorX = x0 + Math.floor(w / 2);
    set(doorX, y0 + h - 1, TILE.DOOR);
    for (let y = y0 + h; y < roadY; y++) set(doorX, y, TILE.PATH);
    places.push({ id: `door:${b.id}`, kind: "door", name: b.name, buildingId: b.id, pos: { x: doorX, y: y0 + h - 1 } });

    if (b.kind === "town-hall") {
      for (let x = 1; x <= 6; x++) set(x0 + x, y0 + 1, TILE.SHELF);
      for (let x = 12; x <= 17; x++) set(x0 + x, y0 + 1, x % 2 ? TILE.TROPHY : TILE.SHELF);
      for (let x = 1; x <= 4; x++) set(x0 + x, y0 + 6, TILE.COUNTER);
      for (let x = 12; x <= 16; x++) { set(x0 + x, y0 + 6, TILE.TABLE); set(x0 + x, y0 + 7, TILE.TABLE); }
      set(x0 + 9, y0 + 1, TILE.PLANT); set(x0 + 1, y0 + 10, TILE.PLANT); set(x0 + 17, y0 + 10, TILE.PLANT);
      places.push(
        { id: "library", kind: "library", name: "Library", buildingId: b.id, pos: { x: x0 + 3, y: y0 + 2 } },
        { id: "trophy-room", kind: "trophy-room", name: "Trophy room", buildingId: b.id, pos: { x: x0 + 15, y: y0 + 2 } },
        { id: "outbox", kind: "outbox", name: "Outbox", buildingId: b.id, pos: { x: x0 + 2, y: y0 + 7 } },
        { id: `meeting-room:${b.id}`, kind: "meeting-room", name: "Town Hall meeting room", buildingId: b.id, pos: { x: x0 + 14, y: y0 + 8 } },
      );
    } else {
      const residents = agents.filter((a) => a.homeBuildingId === b.id && a.kind === "resident");
      for (let i = 0; i < b.headcount; i++) {
        const r = Math.floor(i / 3), c = i % 3;
        const dx = x0 + 2 + c * 4, dy = y0 + 2 + r * 3;
        set(dx, dy, TILE.DESK); set(dx + 1, dy, TILE.DESK);
        const a = residents[i];
        places.push({ id: a ? `desk:${a.id}` : `desk:free:${b.id}:${i}`, kind: "desk", name: a ? `${a.name}'s desk` : "Free desk", buildingId: b.id, pos: { x: dx, y: dy + 1 } });
      }
      const yM = y0 + 2 + Math.ceil(b.headcount / 3) * 3;
      for (let x = 8; x <= 11; x++) { set(x0 + x, yM, TILE.TABLE); set(x0 + x, yM + 1, TILE.TABLE); }
      set(x0 + 1, yM, TILE.SHELF); set(x0 + 2, yM, TILE.SHELF); set(x0 + 1, yM + 2, TILE.PLANT); set(x0 + w - 2, y0 + 1, TILE.PLANT);
      places.push({ id: `meeting-room:${b.id}`, kind: "meeting-room", name: "Meeting room", buildingId: b.id, pos: { x: x0 + 10, y: yM + 2 } });
    }
    if (b.kind === "town-hall") places.push({ id: "plaza", kind: "plaza", name: "Plaza", buildingId: null, pos: { x: doorX, y: roadY } });
    cx += w + GAP;
  }
  return { grid: { w: W, h: H, tiles: t }, places, lots };
}

/** BFS on walkable tiles (bodies don't block). Returns the path excluding the start. */
export function bfs(grid: Grid, from: { x: number; y: number }, to: { x: number; y: number }): { x: number; y: number }[] {
  const { w, h, tiles } = grid;
  const ok = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && WALKABLE.has(tiles[y * w + x]);
  const prev = new Int32Array(w * h).fill(-1);
  const start = from.y * w + from.x, goal = to.y * w + to.x;
  const q = [start];
  prev[start] = start;
  while (q.length) {
    const cur = q.shift()!;
    if (cur === goal) break;
    const x = cur % w, y = (cur / w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, ni = ny * w + nx;
      if (ok(nx, ny) && prev[ni] === -1) { prev[ni] = cur; q.push(ni); }
    }
  }
  if (prev[goal] === -1) return [];
  const path: { x: number; y: number }[] = [];
  for (let c = goal; c !== start; c = prev[c]) path.push({ x: c % w, y: (c / w) | 0 });
  return path.reverse();
}
