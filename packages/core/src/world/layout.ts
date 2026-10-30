import { BANK_FIXTURES, BANK_LOT, bankPlaces, labSize, MAX_HEADCOUNT, TILE, WALKABLE, type Building, type Lot, type Place, type Tile } from "@muster-town/schema";
import { piecesFor, resolveFurniture } from "./furniture.ts";
import { deriveRoads, doorOf } from "./road.ts";
import { treeLayout, type Plaza, type TreeGoal } from "./tree.ts";

/** Row-major tile grid, same shape as the WS snapshot's `grid`. */
export interface Grid { w: number; h: number; tiles: number[] }

export const TOWN_HALL_SIZE = { w: 17, h: 11 } as const;
export { MAX_HEADCOUNT };

export const TOWN_HALL_ID = "town-hall";
/** Seats at the Town Hall mod station (town moderators' desks). */
export const MOD_SEATS = 3;

/** Town Hall fixtures, relative to its lot (17x11). Exported so tests and the web can reason about them. */
export const TOWN_HALL_FIXTURES = {
  /** mod station: desk tiles in the bottom-left; moderators sit on the row below */
  modDesk: [{ x: 2, y: 8 }, { x: 3, y: 8 }, { x: 4, y: 8 }],
  modSeats: [{ x: 2, y: 9 }, { x: 3, y: 9 }, { x: 4, y: 9 }],
  modStand: { x: 5, y: 8 },
  /** planning desk bottom-right */
  planningDesk: [{ x: 12, y: 9 }, { x: 13, y: 9 }], planningStand: { x: 12, y: 8 },
  /** the Town Hall in-tray (rollups, proposals, checkpoints) right of the planning desk */
  intray: { x: 14, y: 9 }, intrayStand: { x: 14, y: 8 },
  /** schedule board next to the town meeting room table */
  schedule: { x: 15, y: 6 }, scheduleStand: { x: 15, y: 7 },
  /** the Town Hall board (town-wide FYIs) on the back wall, above the middle */
  board: { x: 8, y: 0 }, boardStand: { x: 8, y: 1 },
  /** v1.4 visitor bench (default spot; furniture piece `bench`): visitors wait on the row above it */
  bench: [{ x: 10, y: 9 }, { x: 11, y: 9 }], benchSeats: [{ x: 10, y: 8 }, { x: 11, y: 8 }],
} as const;

export { labSize };
export function sizeFor(b: Building): { w: number; h: number } {
  return b.kind === "town-hall" ? { ...TOWN_HALL_SIZE } : labSize(b.headcount);
}
export interface DeskSlot { buildingId: string; n: number; pos: Tile; agentId: string | null }
export interface LayoutResult {
  grid: Grid;
  /** every building's lot, as the tree puts it */
  lots: Map<string, Lot>;
  plazas: Plaza[];
  places: Place[];
  /** standing tiles for every desk, by building */
  desks: Map<string, DeskSlot[]>;
  /** door tile per building */
  doors: Map<string, Tile>;
  /** seats around each meeting table, by meeting-room place id; the place's own tile first */
  seats: Map<string, Tile[]>;
}

/**
 * Build the tile grid and places from the goal tree (`treeLayout` decides every lot and plaza; a building's stored lot
 * is not read) and desk occupancy. `occupancy`: buildingId -> (deskIndex -> agentId); `names`: agentId -> name.
 */
export function computeLayout(buildings: Building[], goals: TreeGoal[], occupancy: Map<string, Map<number, string>>, names: Map<string, string>): LayoutResult {
  const tree = treeLayout(goals, buildings.map((b) => ({ id: b.id, kind: b.kind, goalId: b.goalId, createdAt: b.createdAt, size: sizeFor(b) })));
  const lots = buildings.filter((b) => tree.lots.has(b.id)).map((b) => ({ ...b, lot: tree.lots.get(b.id)! }));
  const { w, h } = tree;
  const hall = lots.find((b) => b.kind === "town-hall");
  const tiles = new Array<number>(w * h).fill(TILE.GRASS);
  const set = (x: number, y: number, t: number) => { if (x >= 0 && y >= 0 && x < w && y < h) tiles[y * w + x] = t; };
  const places: Place[] = [];
  const desks = new Map<string, DeskSlot[]>();
  const doors = new Map<string, Tile>();
  /** meeting-room place id -> its table tiles (seats are computed once the grid is complete) */
  const tables = new Map<string, Tile[]>();

  // the roads (the plazas and the tree's edges between them), then a signpost and a place per plaza
  const roads = deriveRoads(lots, tree, w, h);
  for (const t of roads.tiles) set(t.x, t.y, TILE.PATH);
  for (const p of tree.plazas) {
    set(p.sign.x, p.sign.y, TILE.SIGNPOST);
    const pos = { x: p.rect.x + 1, y: p.rect.y + 1 };
    places.push({ id: `plaza:${p.goalId}`, kind: "plaza", name: p.text || "Goal", buildingId: null, pos });
    // the root's plaza keeps its old id too: the town's meeting point (presence, arrivals)
    if (!p.parentId) places.push({ id: "plaza", kind: "plaza", name: "Plaza", buildingId: null, pos: hall ? { x: doorOf(hall.lot, hall.kind).x - 2, y: p.rect.y } : pos });
  }
  bankRoom(set, places);

  for (const b of lots) {
    const { x: x0, y: y0, w: bw, h: bh } = b.lot;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const edge = x === 0 || y === 0 || x === bw - 1 || y === bh - 1;
      set(x0 + x, y0 + y, edge ? TILE.WALL : TILE.FLOOR);
    }
    const door = doorOf(b.lot, b.kind);
    set(door.x, door.y, TILE.DOOR);
    doors.set(b.id, door);
    places.push({ id: `door:${b.id}`, kind: "door", name: `${b.name} door`, buildingId: b.id, pos: door });

    // furniture: each piece at its stored anchor if that's legal, else its default
    const pieces = piecesFor(b.kind, b.headcount, b.lot);
    const { anchors, dropped } = resolveFurniture(b.kind, b.lot, pieces, b.furniture);
    if (dropped.length) console.warn(`[layout] ${b.id}: ${dropped.join(", ")} back at the default spot (stored spot is no longer legal)`);
    const piece = new Map(pieces.map((p) => [p.key, p]));
    for (const p of pieces) {
      const a = anchors[p.key] ?? p.at;
      for (const c of p.cells) set(x0 + a.x + c.dx, y0 + a.y + c.dy, c.tile);
    }
    /** absolute tile of piece `key`'s stand `i` (or of its cells, for tables) */
    const stand = (key: string, i = 0) => { const p = piece.get(key)!, a = anchors[key] ?? p.at; return { x: x0 + a.x + p.stands[i].x, y: y0 + a.y + p.stands[i].y }; };
    const cells = (key: string) => { const p = piece.get(key)!, a = anchors[key] ?? p.at; return p.cells.map((c) => ({ x: x0 + a.x + c.dx, y: y0 + a.y + c.dy })); };
    const occ = occupancy.get(b.id) ?? new Map<number, string>();

    if (b.kind === "town-hall") {
      // mod-station seats are the Town Hall's desks (town moderators)
      const seats: DeskSlot[] = Array.from({ length: MOD_SEATS }, (_, n) => ({ buildingId: b.id, n, pos: stand("mod-station", n), agentId: occ.get(n) ?? null }));
      desks.set(b.id, seats);
      for (const s of seats) {
        places.push(s.agentId
          ? { id: `desk:${s.agentId}`, kind: "desk", name: `${names.get(s.agentId) ?? s.agentId}'s seat at the mod station`, buildingId: b.id, pos: s.pos }
          : { id: `desk:free:${b.id}:${s.n}`, kind: "desk", name: "Free mod station seat", buildingId: b.id, pos: s.pos });
      }
      places.push(
        { id: "mod-station", kind: "mod-station", name: "Mod station", buildingId: b.id, pos: stand("mod-station", MOD_SEATS) },
        { id: "planning-desk", kind: "planning", name: "Planning desk", buildingId: b.id, pos: stand("planning") },
        { id: `intray:${b.id}`, kind: "intray", name: "Town Hall in-tray (rollups, proposals, checkpoints)", buildingId: b.id, pos: stand("intray") },
        { id: "schedule-board", kind: "schedule", name: "Schedule board", buildingId: b.id, pos: stand("schedule") },
        { id: `board:${b.id}`, kind: "board", name: "Town Hall board (town-wide FYIs)", buildingId: b.id, pos: stand("board") },
        { id: "visitor-bench", kind: "bench", name: "Visitor bench", buildingId: b.id, pos: stand("bench") },
        { id: "library", kind: "library", name: "Library", buildingId: b.id, pos: stand("library") },
        { id: "town-map", kind: "town-map", name: "Town map (town planning)", buildingId: b.id, pos: stand("town-map") },
        { id: "goal-tree", kind: "goal-tree", name: "Goal tree (the town's goals, key results and proposals)", buildingId: b.id, pos: stand("goal-tree") },
        { id: "outbox", kind: "outbox", name: "Outbox", buildingId: b.id, pos: stand("outbox") },
        { id: `meeting-room:${b.id}`, kind: "meeting-room", name: "Town Hall meeting room", buildingId: b.id, pos: stand("meeting") },
      );
      tables.set(`meeting-room:${b.id}`, cells("meeting"));
      continue;
    }

    const slots: DeskSlot[] = [];
    for (let i = 0; i < b.headcount; i++) {
      const pos = stand(`desk:${i}`);
      const agentId = occ.get(i) ?? null;
      slots.push({ buildingId: b.id, n: i, pos, agentId });
      places.push(agentId
        ? { id: `desk:${agentId}`, kind: "desk", name: `${names.get(agentId) ?? agentId}'s desk`, buildingId: b.id, pos }
        : { id: `desk:free:${b.id}:${i}`, kind: "desk", name: "Free desk", buildingId: b.id, pos });
    }
    desks.set(b.id, slots);
    places.push(
      { id: `board:${b.id}`, kind: "board", name: `${b.name} board`, buildingId: b.id, pos: stand("board") },
      { id: `schedule:${b.id}`, kind: "schedule", name: `${b.name} schedule board (timed jobs)`, buildingId: b.id, pos: stand("schedule") },
      { id: `intray:${b.id}`, kind: "intray", name: `${b.name} in-tray (manager's desk)`, buildingId: b.id, pos: stand("intray") },
      { id: `cabinet:${b.id}`, kind: "cabinet", name: `${b.name} filing cabinet`, buildingId: b.id, pos: stand("cabinet") },
      { id: `meeting-room:${b.id}`, kind: "meeting-room", name: `${b.name} meeting room`, buildingId: b.id, pos: stand("meeting") },
    );
    tables.set(`meeting-room:${b.id}`, cells("meeting"));
  }
  const grid = { w, h, tiles };
  const seats = new Map<string, Tile[]>();
  for (const [id, table] of tables) {
    const room = places.find((p) => p.id === id)!.pos;
    seats.set(id, seatsAround(grid, table, room));
  }
  return { grid, lots: tree.lots, plazas: tree.plazas, places, desks, doors, seats };
}

/** The Bank (fixed lot south of the road): gold walls are the renderer's job; here the room, its door, the vault and the stations, and their places. */
function bankRoom(set: (x: number, y: number, t: number) => void, places: Place[]) {
  const { x: x0, y: y0, w: bw, h: bh } = BANK_LOT, F = BANK_FIXTURES;
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const edge = x === 0 || y === 0 || x === bw - 1 || y === bh - 1;
    set(x0 + x, y0 + y, edge ? TILE.WALL : TILE.FLOOR);
  }
  const put = (cells: readonly Tile[], t: number) => { for (const c of cells) set(x0 + c.x, y0 + c.y, t); };
  put(F.pillars, TILE.PILLAR);
  put(F.gold, TILE.GOLD);
  put([F.vault], TILE.VAULT);
  put([F.map], TILE.BANK_MAP);
  for (const st of F.stations) put(st.cells, st.tile);
  const door = { x: x0 + F.door.x, y: y0 + F.door.y };
  set(door.x, door.y, TILE.DOOR);
  places.push(...bankPlaces(x0, y0));
}

/**
 * Walkable tiles touching a table (4-neighbours), so each attendee gets their own.
 * `first` (the meeting-room place) leads; the rest go nearest-first, then top-to-bottom, left-to-right.
 */
export function seatsAround(grid: Grid, table: Tile[], first: Tile): Tile[] {
  const key = (t: Tile) => `${t.x},${t.y}`;
  const onTable = new Set(table.map(key));
  const out = new Map<string, Tile>();
  for (const t of table) {
    for (const [dx, dy] of [[0, 1], [0, -1], [-1, 0], [1, 0]]) {
      const s = { x: t.x + dx, y: t.y + dy };
      if (!onTable.has(key(s)) && WALKABLE.has(tileAt(grid, s.x, s.y))) out.set(key(s), s);
    }
  }
  const d = (t: Tile) => Math.abs(t.x - first.x) + Math.abs(t.y - first.y);
  return [...out.values()].sort((a, b) => d(a) - d(b) || a.y - b.y || a.x - b.x);
}

export function tileAt(grid: Grid, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= grid.w || y >= grid.h) return TILE.WALL;
  return grid.tiles[y * grid.w + x];
}
