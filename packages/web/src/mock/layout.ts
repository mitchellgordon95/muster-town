/**
 * Mock-only town layout. Building interiors mirror core's `computeLayout` (packages/core/src/world/layout.ts,
 * including TOWN_HALL_FIXTURES, copied here because the web bundle can't import core); lots are packed
 * side by side around the Town Hall so the mock map stays compact. Core owns the real layout.
 */
import { TILE, WALKABLE } from "@agent-town/schema";
import type { Agent, Building, Place } from "@agent-town/schema";
import type { Grid } from "../api";

export interface Layout { grid: Grid; places: Place[]; lots: Map<string, NonNullable<Building["lot"]>> }

/** = core TOWN_HALL_FIXTURES (relative to the 17x11 Town Hall lot). */
const F = {
  modDesk: [{ x: 2, y: 8 }, { x: 3, y: 8 }, { x: 4, y: 8 }],
  modSeats: [{ x: 2, y: 9 }, { x: 3, y: 9 }, { x: 4, y: 9 }],
  modStand: { x: 5, y: 8 },
  donation: { x: 6, y: 9 }, donationStand: { x: 7, y: 9 },
  planningDesk: [{ x: 12, y: 9 }, { x: 13, y: 9 }], planningStand: { x: 12, y: 8 },
  schedule: { x: 15, y: 6 }, scheduleStand: { x: 15, y: 7 },
};
const HALL = { w: 17, h: 11 }, GAP = 4, MARGIN = 3;
function labSize(headcount: number) {
  const n = Math.max(1, headcount);
  const cols = Math.min(3, n), rows = Math.ceil(n / cols);
  return { w: Math.max(cols * 4 + 3, 13), h: rows * 3 + 6 };
}

export function computeLayout(buildings: Building[], agents: Agent[]): Layout {
  const hall = buildings.find((b) => b.kind === "town-hall");
  const labs = buildings.filter((b) => b.kind !== "town-hall");
  const left = labs.filter((_, i) => i % 2 === 0), right = labs.filter((_, i) => i % 2 === 1);
  const ordered = [...left.reverse(), ...(hall ? [hall] : []), ...right];
  const size = (b: Building) => (b.kind === "town-hall" ? HALL : labSize(b.headcount));
  const maxH = Math.max(HALL.h, ...ordered.map((b) => size(b).h));
  const W = MARGIN * 2 + ordered.reduce((s, b) => s + size(b).w, 0) + GAP * Math.max(0, ordered.length - 1);
  const top = 4;
  const roadY = top + maxH + 2;
  const H = roadY + 6;
  const t = new Array<number>(W * H).fill(TILE.GRASS);
  const set = (x: number, y: number, k: number) => { if (x >= 0 && y >= 0 && x < W && y < H) t[y * W + x] = k; };
  const places: Place[] = [];
  const lots = new Map<string, NonNullable<Building["lot"]>>();

  for (let x = 0; x < W; x++) { set(x, roadY, TILE.PATH); set(x, roadY + 1, TILE.PATH); }
  for (let x = 2; x < W - 1; x += 6) set(x, roadY + 3, TILE.PLANT);
  for (let x = 1; x < W - 1; x += 9) set(x, 1, TILE.PLANT);

  let cx = MARGIN;
  for (const b of ordered) {
    const { w: bw, h: bh } = size(b);
    const x0 = cx, y0 = roadY - 2 - bh;
    lots.set(b.id, { x: x0, y: y0, w: bw, h: bh });
    for (let y = 0; y < bh; y++)
      for (let x = 0; x < bw; x++) set(x0 + x, y0 + y, x === 0 || y === 0 || x === bw - 1 || y === bh - 1 ? TILE.WALL : TILE.FLOOR);
    const door = { x: x0 + Math.floor(bw / 2), y: y0 + bh - 1 };
    set(door.x, door.y, TILE.DOOR);
    for (let y = y0 + bh; y < roadY; y++) set(door.x, y, TILE.PATH);
    places.push({ id: `door:${b.id}`, kind: "door", name: `${b.name} door`, buildingId: b.id, pos: door });
    const at = (p: { x: number; y: number }) => ({ x: x0 + p.x, y: y0 + p.y });

    if (b.kind === "town-hall") {
      for (const p of F.modDesk) set(x0 + p.x, y0 + p.y, TILE.DESK);
      for (const p of F.planningDesk) set(x0 + p.x, y0 + p.y, TILE.DESK);
      set(x0 + F.donation.x, y0 + F.donation.y, TILE.DONATION);
      set(x0 + F.schedule.x, y0 + F.schedule.y, TILE.SCHEDULE);
      // town moderators (Town Hall residents) sit at the mod station
      const mods = agents.filter((a) => a.homeBuildingId === b.id && a.kind === "resident" && a.status !== "retired");
      F.modSeats.forEach((p, n) => {
        const a = mods[n];
        places.push(a
          ? { id: `desk:${a.id}`, kind: "desk", name: `${a.name}'s seat at the mod station`, buildingId: b.id, pos: at(p) }
          : { id: `desk:free:${b.id}:${n}`, kind: "desk", name: "Free mod station seat", buildingId: b.id, pos: at(p) });
      });
      places.push(
        { id: "mod-station", kind: "mod-station", name: "Mod station", buildingId: b.id, pos: at(F.modStand) },
        { id: "planning-desk", kind: "planning", name: "Planning desk", buildingId: b.id, pos: at(F.planningStand) },
        { id: "donation-box", kind: "donation", name: "Donation box", buildingId: b.id, pos: at(F.donationStand) },
        { id: "schedule-board", kind: "schedule", name: "Schedule board", buildingId: b.id, pos: at(F.scheduleStand) },
      );
      for (let x = 2; x <= 6; x++) set(x0 + x, y0 + 2, TILE.SHELF);
      for (let x = 10; x <= 14; x++) set(x0 + x, y0 + 2, TILE.TROPHY);
      for (let x = 2; x <= 5; x++) set(x0 + x, y0 + 6, TILE.COUNTER);
      for (let x = 10; x <= 13; x++) set(x0 + x, y0 + 6, TILE.TABLE);
      set(x0 + 1, y0 + 1, TILE.PLANT); set(x0 + bw - 2, y0 + 1, TILE.PLANT);
      places.push(
        { id: "library", kind: "library", name: "Library", buildingId: b.id, pos: { x: x0 + 4, y: y0 + 3 } },
        { id: "trophy-room", kind: "trophy-room", name: "Trophy room", buildingId: b.id, pos: { x: x0 + 12, y: y0 + 3 } },
        { id: "outbox", kind: "outbox", name: "Outbox", buildingId: b.id, pos: { x: x0 + 3, y: y0 + 7 } },
        { id: `meeting-room:${b.id}`, kind: "meeting-room", name: "Town Hall meeting room", buildingId: b.id, pos: { x: x0 + 11, y: y0 + 7 } },
        { id: "plaza", kind: "plaza", name: "Plaza", buildingId: null, pos: { x: door.x, y: roadY } },
      );
    } else {
      const residents = agents.filter((a) => a.homeBuildingId === b.id && a.kind === "resident" && a.status !== "retired");
      const cols = Math.min(3, Math.max(1, b.headcount));
      for (let i = 0; i < b.headcount; i++) {
        const c = i % cols, r = Math.floor(i / cols);
        const dx = x0 + 2 + c * 4, dy = y0 + 2 + r * 3;
        set(dx, dy, TILE.DESK); set(dx + 1, dy, TILE.DESK);
        const a = residents[i];
        places.push({ id: a ? `desk:${a.id}` : `desk:free:${b.id}:${i}`, kind: "desk", name: a ? `${a.name}'s desk` : "Free desk", buildingId: b.id, pos: { x: dx, y: dy + 1 } });
      }
      const boardX = x0 + Math.floor(bw / 2) - 2;
      set(boardX, y0, TILE.BOARD);
      places.push({ id: `board:${b.id}`, kind: "board", name: `${b.name} board`, buildingId: b.id, pos: { x: boardX, y: y0 + 1 } });
      const mx = x0 + bw - 2, my = y0 + 2;
      set(mx, my, TILE.MANAGER_DESK);
      places.push({ id: `intray:${b.id}`, kind: "intray", name: `${b.name} in-tray (manager's desk)`, buildingId: b.id, pos: { x: mx, y: my + 1 } });
      const yMeet = y0 + bh - 4;
      const cy = yMeet - 2 >= my + 2 ? yMeet - 2 : y0 + bh - 2;
      set(mx, cy, TILE.CABINET);
      places.push({ id: `cabinet:${b.id}`, kind: "cabinet", name: `${b.name} filing cabinet`, buildingId: b.id, pos: { x: mx - 1, y: cy } });
      for (let x = bw - 5; x <= bw - 3; x++) set(x0 + x, yMeet, TILE.TABLE);
      set(x0 + 1, yMeet, TILE.PLANT);
      places.push({ id: `meeting-room:${b.id}`, kind: "meeting-room", name: `${b.name} meeting room`, buildingId: b.id, pos: { x: x0 + bw - 4, y: yMeet + 1 } });
    }
    cx += bw + GAP;
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
