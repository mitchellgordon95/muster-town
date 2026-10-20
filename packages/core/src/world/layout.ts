import { TILE, WALKABLE, type Building, type Lot, type Place, type Tile } from "@agent-town/schema";

/** Row-major tile grid, same shape as the WS snapshot's `grid`. */
export interface Grid { w: number; h: number; tiles: number[] }

/** y of the main road (2 tiles tall). Buildings sit above it; fixed so lots stay stable. */
export const ROAD_Y = 40;
/** x of the Town Hall's left edge. Labs alternate left/right of it. */
export const TOWN_HALL_X = 48;
export const LOT_GAP = 4;
export const TOWN_HALL_SIZE = { w: 17, h: 11 } as const;
/** Largest headcount that fits under the fixed road (rows*3 + 6 <= ROAD_Y - 2). */
export const MAX_HEADCOUNT = 3 * Math.floor((ROAD_Y - 2 - 6) / 3);

export const TOWN_HALL_ID = "town-hall";
/** Seats at the Town Hall mod station (town moderators' desks). */
export const MOD_SEATS = 3;

/** Town Hall fixtures, relative to its lot (17x11). Exported so tests and the web can reason about them. */
export const TOWN_HALL_FIXTURES = {
  /** mod station: desk tiles in the bottom-left; moderators sit on the row below */
  modDesk: [{ x: 2, y: 8 }, { x: 3, y: 8 }, { x: 4, y: 8 }],
  modSeats: [{ x: 2, y: 9 }, { x: 3, y: 9 }, { x: 4, y: 9 }],
  modStand: { x: 5, y: 8 },
  /** donation box left of the door corridor */
  donation: { x: 6, y: 9 }, donationStand: { x: 7, y: 9 },
  /** planning desk bottom-right */
  planningDesk: [{ x: 12, y: 9 }, { x: 13, y: 9 }], planningStand: { x: 12, y: 8 },
  /** schedule board next to the town meeting room table */
  schedule: { x: 15, y: 6 }, scheduleStand: { x: 15, y: 7 },
} as const;

export function labSize(headcount: number): { w: number; h: number } {
  const n = Math.max(1, headcount);
  const cols = Math.min(3, n), rows = Math.ceil(n / cols);
  return { w: Math.max(cols * 4 + 3, 13), h: rows * 3 + 6 };
}
export function sizeFor(b: Building): { w: number; h: number } {
  return b.kind === "town-hall" ? { ...TOWN_HALL_SIZE } : labSize(b.headcount);
}
function lotFits(lot: Lot, need: { w: number; h: number }) {
  return lot.w >= need.w && lot.h >= need.h;
}

/**
 * Assign lots to buildings without one (or whose lot is now too small). Existing fitting lots never move.
 * Labs alternate left/right of the Town Hall in creation order; a lab goes right if the left is full.
 * New lots are placed beyond the current extremes, so lots never overlap.
 * Returns the buildings whose lot changed.
 */
export function assignLots(buildings: Building[]): Building[] {
  const sorted = [...buildings].sort((a, b) => (a.kind === "town-hall" ? -1 : b.kind === "town-hall" ? 1 : a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)));
  const placed: Lot[] = [];
  const pending: Building[] = [];
  for (const b of sorted) {
    if (b.lot && lotFits(b.lot, sizeFor(b))) placed.push(b.lot);
    else pending.push(b);
  }
  const changed: Building[] = [];
  let labIndex = sorted.filter((b) => b.kind !== "town-hall" && b.lot && lotFits(b.lot, sizeFor(b))).length;
  for (const b of pending) {
    const { w, h } = sizeFor(b);
    const y = ROAD_Y - 2 - h;
    let x: number;
    const minX = placed.length ? Math.min(...placed.map((l) => l.x)) : TOWN_HALL_X;
    const maxX = placed.length ? Math.max(...placed.map((l) => l.x + l.w)) : TOWN_HALL_X + TOWN_HALL_SIZE.w;
    if (b.kind === "town-hall" && !placed.some((l) => l.x < TOWN_HALL_X + TOWN_HALL_SIZE.w && l.x + l.w > TOWN_HALL_X)) {
      x = TOWN_HALL_X;
    } else {
      const left = minX - LOT_GAP - w;
      x = labIndex % 2 === 0 && left >= 2 ? left : maxX + LOT_GAP;
      if (b.kind !== "town-hall") labIndex++;
    }
    const lot = { x, y, w, h };
    placed.push(lot);
    changed.push({ ...b, lot });
  }
  return changed;
}

export interface DeskSlot { buildingId: string; n: number; pos: Tile; agentId: string | null }
export interface LayoutResult {
  grid: Grid;
  places: Place[];
  /** standing tiles for every desk, by building */
  desks: Map<string, DeskSlot[]>;
  /** door tile per building */
  doors: Map<string, Tile>;
  /** seats around each meeting table, by meeting-room place id; the place's own tile first */
  seats: Map<string, Tile[]>;
}

/**
 * Build the tile grid and places from buildings (with lots) and desk occupancy.
 * `occupancy`: buildingId -> (deskIndex -> agentId); `names`: agentId -> name.
 */
export function computeLayout(buildings: Building[], occupancy: Map<string, Map<number, string>>, names: Map<string, string>): LayoutResult {
  const lots = buildings.filter((b) => b.lot);
  const right = Math.max(TOWN_HALL_X + TOWN_HALL_SIZE.w, ...lots.map((b) => b.lot!.x + b.lot!.w));
  const w = Math.max(64, right + 6);
  const h = ROAD_Y + 6;
  const tiles = new Array<number>(w * h).fill(TILE.GRASS);
  const set = (x: number, y: number, t: number) => { if (x >= 0 && y >= 0 && x < w && y < h) tiles[y * w + x] = t; };
  const places: Place[] = [];
  const desks = new Map<string, DeskSlot[]>();
  const doors = new Map<string, Tile>();
  /** meeting-room place id -> its table tiles (seats are computed once the grid is complete) */
  const tables = new Map<string, Tile[]>();

  // road and trees
  for (let x = 0; x < w; x++) { set(x, ROAD_Y, TILE.PATH); set(x, ROAD_Y + 1, TILE.PATH); }
  for (let x = 2; x < w; x += 6) set(x, ROAD_Y + 3, TILE.PLANT);

  for (const b of lots) {
    const { x: x0, y: y0, w: bw, h: bh } = b.lot!;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const edge = x === 0 || y === 0 || x === bw - 1 || y === bh - 1;
      set(x0 + x, y0 + y, edge ? TILE.WALL : TILE.FLOOR);
    }
    const door = { x: x0 + Math.floor(bw / 2), y: y0 + bh - 1 };
    set(door.x, door.y, TILE.DOOR);
    for (let y = y0 + bh; y < ROAD_Y; y++) set(door.x, y, TILE.PATH);
    doors.set(b.id, door);
    places.push({ id: `door:${b.id}`, kind: "door", name: `${b.name} door`, buildingId: b.id, pos: door });

    if (b.kind === "town-hall") {
      const F = TOWN_HALL_FIXTURES;
      const at = (p: { x: number; y: number }) => ({ x: x0 + p.x, y: y0 + p.y });
      for (const p of F.modDesk) set(x0 + p.x, y0 + p.y, TILE.DESK);
      for (const p of F.planningDesk) set(x0 + p.x, y0 + p.y, TILE.DESK);
      set(x0 + F.donation.x, y0 + F.donation.y, TILE.DONATION);
      set(x0 + F.schedule.x, y0 + F.schedule.y, TILE.SCHEDULE);
      // mod-station seats are the Town Hall's desks (town moderators)
      const occ = occupancy.get(b.id) ?? new Map<number, string>();
      const seats: DeskSlot[] = F.modSeats.map((p, n) => ({ buildingId: b.id, n, pos: at(p), agentId: occ.get(n) ?? null }));
      desks.set(b.id, seats);
      for (const s of seats) {
        places.push(s.agentId
          ? { id: `desk:${s.agentId}`, kind: "desk", name: `${names.get(s.agentId) ?? s.agentId}'s seat at the mod station`, buildingId: b.id, pos: s.pos }
          : { id: `desk:free:${b.id}:${s.n}`, kind: "desk", name: "Free mod station seat", buildingId: b.id, pos: s.pos });
      }
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
      tables.set(`meeting-room:${b.id}`, [10, 11, 12, 13].map((x) => ({ x: x0 + x, y: y0 + 6 })));
      set(x0 + 1, y0 + 1, TILE.PLANT); set(x0 + bw - 2, y0 + 1, TILE.PLANT);
      places.push(
        { id: "library", kind: "library", name: "Library", buildingId: b.id, pos: { x: x0 + 4, y: y0 + 3 } },
        { id: "trophy-room", kind: "trophy-room", name: "Trophy room", buildingId: b.id, pos: { x: x0 + 12, y: y0 + 3 } },
        { id: "outbox", kind: "outbox", name: "Outbox", buildingId: b.id, pos: { x: x0 + 3, y: y0 + 7 } },
        { id: `meeting-room:${b.id}`, kind: "meeting-room", name: "Town Hall meeting room", buildingId: b.id, pos: { x: x0 + 11, y: y0 + 7 } },
        { id: "plaza", kind: "plaza", name: "Plaza", buildingId: null, pos: { x: door.x, y: ROAD_Y } },
      );
      continue;
    }

    // lab: desks in rows of up to 3 (desk = 2 tiles, agent stands below the left half)
    const n = Math.max(1, b.headcount);
    const cols = Math.min(3, n);
    const occ = occupancy.get(b.id) ?? new Map<number, string>();
    const slots: DeskSlot[] = [];
    for (let i = 0; i < b.headcount; i++) {
      const c = i % cols, r = Math.floor(i / cols);
      const dx = x0 + 2 + c * 4, dy = y0 + 2 + r * 3;
      set(dx, dy, TILE.DESK); set(dx + 1, dy, TILE.DESK);
      const pos = { x: dx, y: dy + 1 };
      const agentId = occ.get(i) ?? null;
      slots.push({ buildingId: b.id, n: i, pos, agentId });
      places.push(agentId
        ? { id: `desk:${agentId}`, kind: "desk", name: `${names.get(agentId) ?? agentId}'s desk`, buildingId: b.id, pos }
        : { id: `desk:free:${b.id}:${i}`, kind: "desk", name: "Free desk", buildingId: b.id, pos });
    }
    desks.set(b.id, slots);
    // the building board: a wall tile on the top wall, left of center; read it standing below
    const boardX = x0 + Math.floor(bw / 2) - 2;
    set(boardX, y0, TILE.BOARD);
    places.push({ id: `board:${b.id}`, kind: "board", name: `${b.name} board`, buildingId: b.id, pos: { x: boardX, y: y0 + 1 } });
    // the manager's desk (in-tray): top-right, one tile, stand below it
    const mx = x0 + bw - 2, my = y0 + 2;
    set(mx, my, TILE.MANAGER_DESK);
    places.push({ id: `intray:${b.id}`, kind: "intray", name: `${b.name} in-tray (manager's desk)`, buildingId: b.id, pos: { x: mx, y: my + 1 } });
    const yMeet = y0 + bh - 4;
    // the filing cabinet (reports and meeting notes): against the right wall, between the in-tray and the meeting table
    // (bottom-right corner when the lab is one desk row tall and there's no room); read it standing to its left
    const cy = yMeet - 2 >= my + 2 ? yMeet - 2 : y0 + bh - 2;
    set(mx, cy, TILE.CABINET);
    places.push({ id: `cabinet:${b.id}`, kind: "cabinet", name: `${b.name} filing cabinet`, buildingId: b.id, pos: { x: mx - 1, y: cy } });
    // meeting table bottom-right, plant bottom-left
    for (let x = bw - 5; x <= bw - 3; x++) set(x0 + x, yMeet, TILE.TABLE);
    tables.set(`meeting-room:${b.id}`, [bw - 5, bw - 4, bw - 3].map((x) => ({ x: x0 + x, y: yMeet })));
    set(x0 + 1, yMeet, TILE.PLANT);
    places.push({ id: `meeting-room:${b.id}`, kind: "meeting-room", name: `${b.name} meeting room`, buildingId: b.id, pos: { x: x0 + bw - 4, y: yMeet + 1 } });
  }
  const grid = { w, h, tiles };
  const seats = new Map<string, Tile[]>();
  for (const [id, table] of tables) {
    const room = places.find((p) => p.id === id)!.pos;
    seats.set(id, seatsAround(grid, table, room));
  }
  return { grid, places, desks, doors, seats };
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
