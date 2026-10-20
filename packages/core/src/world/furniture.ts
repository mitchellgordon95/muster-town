import { TILE, type Lot, type Tile } from "@muster-town/schema";
import { facesNorth } from "./road.ts";

/**
 * Movable furniture. Every piece of a room is a `Piece`: footprint cells and stand tiles relative to an anchor,
 * with a default anchor relative to the lot. `Building.furniture` stores only the moved pieces' anchors
 * (lot-relative); `computeLayout` places each piece at its stored anchor if it's legal, else at its default.
 * A building south of the road has its door in the top wall, so its default room is the north one upside down.
 */
export interface Piece {
  /** stable key, e.g. `board`, `desk:3`, `meeting` */
  key: string;
  label: string;
  /** default anchor, relative to the lot */
  at: Tile;
  /** footprint cells relative to the anchor, with their tile */
  cells: { dx: number; dy: number; tile: number }[];
  /** walkable tiles agents stand on to use it (desk seats, places), relative to the anchor */
  stands: Tile[];
  /** sits on a wall tile (board), not on the floor */
  wall?: boolean;
  /** a meeting table: needs at least 2 reachable seats */
  table?: boolean;
}

/** A lot-relative anchor per moved piece. */
export type Furniture = Record<string, Tile>;
export interface LayoutError { key: string | null; message: string }

const row = (n: number, tile: number) => Array.from({ length: n }, (_, dx) => ({ dx, dy: 0, tile }));
const one = (tile: number) => [{ dx: 0, dy: 0, tile }];

/** The pieces of a building of this kind and lot size, at their default anchors. */
export function piecesFor(kind: "lab" | "town-hall", headcount: number, lot: { w: number; h: number; y?: number }): Piece[] {
  const pieces = southFacingPieces(kind, headcount, lot);
  if (!facesNorth(lot)) return pieces;
  return pieces.map((p) => ({
    ...p,
    at: { x: p.at.x, y: lot.h - 1 - p.at.y },
    cells: p.cells.map((c) => ({ ...c, dy: -c.dy })),
    stands: p.stands.map((s) => ({ x: s.x, y: -s.y })),
  }));
}

function southFacingPieces(kind: "lab" | "town-hall", headcount: number, lot: { w: number; h: number }): Piece[] {
  const { w: bw, h: bh } = lot;
  if (kind === "town-hall") {
    return [
      { key: "mod-station", label: "Mod station", at: { x: 2, y: 8 }, cells: row(3, TILE.DESK), stands: [{ x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 0 }] },
      // v1.4 visitor bench right of the door corridor; visitors wait on the row above it (stands = the two seats)
      { key: "bench", label: "Visitor bench", at: { x: 10, y: 9 }, cells: row(2, TILE.BENCH), stands: [{ x: 0, y: -1 }, { x: 1, y: -1 }] },
      { key: "planning", label: "Planning desk", at: { x: 12, y: 9 }, cells: row(2, TILE.DESK), stands: [{ x: 0, y: -1 }] },
      { key: "schedule", label: "Schedule board", at: { x: 15, y: 6 }, cells: one(TILE.SCHEDULE), stands: [{ x: 0, y: 1 }] },
      { key: "library", label: "Library shelves", at: { x: 2, y: 2 }, cells: row(5, TILE.SHELF), stands: [{ x: 2, y: 1 }] },
      { key: "trophy", label: "Trophy cases", at: { x: 10, y: 2 }, cells: row(5, TILE.TROPHY), stands: [{ x: 2, y: 1 }] },
      { key: "outbox", label: "Outbox counter", at: { x: 2, y: 6 }, cells: row(4, TILE.COUNTER), stands: [{ x: 1, y: 1 }] },
      { key: "meeting", label: "Meeting table", at: { x: 10, y: 6 }, cells: row(4, TILE.TABLE), stands: [{ x: 1, y: 1 }], table: true },
      { key: "plant:0", label: "Plant", at: { x: 1, y: 1 }, cells: one(TILE.PLANT), stands: [] },
      { key: "plant:1", label: "Plant", at: { x: bw - 2, y: 1 }, cells: one(TILE.PLANT), stands: [] },
    ];
  }
  const cols = Math.min(3, Math.max(1, headcount));
  const desks: Piece[] = [];
  // desks in rows of up to 3 (desk = 2 tiles, agent sits below the left half)
  for (let i = 0; i < headcount; i++) {
    const c = i % cols, r = Math.floor(i / cols);
    desks.push({ key: `desk:${i}`, label: `Desk ${i + 1}`, at: { x: 2 + c * 4, y: 2 + r * 3 }, cells: row(2, TILE.DESK), stands: [{ x: 0, y: 1 }] });
  }
  const my = 2, yMeet = bh - 4;
  // the cabinet sits against the right wall between the in-tray and the table (bottom-right when there's no room)
  const cy = yMeet - 2 >= my + 2 ? yMeet - 2 : bh - 2;
  return [
    ...desks,
    { key: "board", label: "Board", at: { x: Math.floor(bw / 2) - 2, y: 0 }, cells: one(TILE.BOARD), stands: [{ x: 0, y: 1 }], wall: true },
    { key: "intray", label: "In-tray (manager's desk)", at: { x: bw - 2, y: my }, cells: one(TILE.MANAGER_DESK), stands: [{ x: 0, y: 1 }] },
    { key: "cabinet", label: "Filing cabinet", at: { x: bw - 2, y: cy }, cells: one(TILE.CABINET), stands: [{ x: -1, y: 0 }] },
    { key: "meeting", label: "Meeting table", at: { x: bw - 5, y: yMeet }, cells: row(3, TILE.TABLE), stands: [{ x: 1, y: 1 }], table: true },
    { key: "plant", label: "Plant", at: { x: 1, y: yMeet }, cells: one(TILE.PLANT), stands: [] },
  ];
}

const k = (x: number, y: number) => `${x},${y}`;

/**
 * Check a room: `anchors` gives each piece's lot-relative anchor (missing = default). Rules: cells inside the
 * room (floor pieces on the floor, wall pieces on a side wall or the back wall, not a corner); nothing on or just inside
 * the door; no overlaps; stand tiles on free floor and not shared; every stand tile and 2 seats at each table
 * reachable from the door. Empty = legal.
 */
export function validateLayout(lot: { w: number; h: number; y?: number }, pieces: Piece[], anchors: Furniture = {}): LayoutError[] {
  const { w, h } = lot;
  const errors: LayoutError[] = [];
  const north = facesNorth(lot), back = north ? h - 1 : 0;
  const door = { x: Math.floor(w / 2), y: north ? 0 : h - 1 }, inside = { x: door.x, y: north ? 1 : h - 2 };
  const interior = (x: number, y: number) => x >= 1 && y >= 1 && x <= w - 2 && y <= h - 2;
  const onWall = (x: number, y: number) => (x === 0 || x === w - 1) ? y >= 1 && y <= h - 2 : y === back && x >= 1 && x <= w - 2;
  const owner = new Map<string, string>();
  const at = (p: Piece) => anchors[p.key] ?? p.at;
  for (const p of pieces) {
    const a = at(p);
    for (const c of p.cells) {
      const x = a.x + c.dx, y = a.y + c.dy;
      if (p.wall ? !onWall(x, y) : !interior(x, y)) { errors.push({ key: p.key, message: `${p.label} must sit ${p.wall ? `on a side or ${north ? "bottom" : "top"} wall` : "inside the room"}.` }); break; }
      if ((x === door.x && y === door.y) || (x === inside.x && y === inside.y)) { errors.push({ key: p.key, message: `${p.label} blocks the door.` }); break; }
      const other = owner.get(k(x, y));
      if (other) { errors.push({ key: p.key, message: `${p.label} overlaps ${pieces.find((q) => q.key === other)!.label}.` }); break; }
      owner.set(k(x, y), p.key);
    }
  }
  if (errors.length) return errors;
  const standOwner = new Map<string, string>();
  for (const p of pieces) {
    const a = at(p);
    for (const s of p.stands) {
      const x = a.x + s.x, y = a.y + s.y;
      if (!interior(x, y) || owner.has(k(x, y))) { errors.push({ key: p.key, message: `${p.label} needs free floor where people stand to use it.` }); break; }
      if (x === inside.x && y === inside.y) { errors.push({ key: p.key, message: `${p.label} would have people standing in the doorway.` }); break; }
      const other = standOwner.get(k(x, y));
      if (other && other !== p.key) { errors.push({ key: p.key, message: `${p.label} shares its standing spot with ${pieces.find((q) => q.key === other)!.label}.` }); break; }
      standOwner.set(k(x, y), p.key);
    }
  }
  if (errors.length) return errors;
  // flood fill from just inside the door over free floor
  const seen = new Set([k(inside.x, inside.y)]);
  const q = [inside];
  for (let i = 0; i < q.length; i++) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = q[i].x + dx, y = q[i].y + dy;
      if (!interior(x, y) || owner.has(k(x, y)) || seen.has(k(x, y))) continue;
      seen.add(k(x, y)); q.push({ x, y });
    }
  }
  for (const p of pieces) {
    const a = at(p);
    if (p.stands.some((s) => !seen.has(k(a.x + s.x, a.y + s.y)))) { errors.push({ key: p.key, message: `${p.label} can't be reached from the door.` }); continue; }
    if (p.table) {
      const seats = new Set<string>();
      for (const c of p.cells) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const s = k(a.x + c.dx + dx, a.y + c.dy + dy);
        if (seen.has(s)) seats.add(s);
      }
      if (seats.size < 2) errors.push({ key: p.key, message: `${p.label} needs at least 2 reachable seats.` });
    }
  }
  return errors;
}

/**
 * The anchors to build with: each stored anchor that keeps the room legal, else the piece's default.
 * Unknown keys (e.g. a desk beyond a lowered headcount) are dropped. Tries again after each accepted piece, so
 * swaps survive (A takes B's old spot only once B has moved).
 */
export function resolveFurniture(lot: Lot, pieces: Piece[], stored: Furniture | undefined): { anchors: Furniture; dropped: string[] } {
  const anchors: Furniture = {};
  let pending = Object.keys(stored ?? {}).filter((key) => pieces.some((p) => p.key === key)).sort();
  for (let progress = true; progress && pending.length;) {
    progress = false;
    for (const key of [...pending]) {
      const trial = { ...anchors, [key]: stored![key] };
      if (validateLayout(lot, pieces, trial).length) continue;
      anchors[key] = stored![key];
      pending = pending.filter((x) => x !== key);
      progress = true;
    }
  }
  return { anchors, dropped: pending };
}

/** Only the pieces away from their default, so a reset piece leaves nothing behind. */
export function movedOnly(pieces: Piece[], anchors: Furniture): Furniture {
  const out: Furniture = {};
  for (const p of pieces) {
    const a = anchors[p.key];
    if (a && (a.x !== p.at.x || a.y !== p.at.y)) out[p.key] = { x: a.x, y: a.y };
  }
  return out;
}
