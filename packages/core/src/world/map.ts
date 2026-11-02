import { TILE, type Building, type Lot, type Place, type Tile } from "@muster-town/schema";
import type { DB } from "../db.ts";
import { AppError, notFound } from "../errors.ts";
import type { Repos } from "../store.ts";
import { movedOnly, piecesFor, resolveFurniture, validateLayout, type Furniture, type LayoutError, type Piece } from "./furniture.ts";
import { computeLayout, MAX_HEADCOUNT, MOD_SEATS, type DeskSlot, type Grid } from "./layout.ts";
import { isWalkable } from "./path.ts";
import type { Side } from "./road.ts";
import type { Plaza } from "./tree.ts";

/** Where every place and meeting seat was before a rebuild, so bodies can follow (entities.ts `followBodies`). */
export interface Before { places: Map<string, Tile>; seats: Map<string, Tile[]> }
/** A building whose lot the tree moved or resized in a rebuild. */
export interface Moved { id: string; from: Lot; to: Lot }

/**
 * World geometry service: `world.layout`. Rebuilt whenever buildings, desk occupancy or the goal tree change: the map is
 * drawn from the tree (tree.ts), so a rebuild can move buildings; their bodies follow (`follow`, set by the World).
 */
export class WorldMap {
  grid: Grid = { w: 0, h: 0, tiles: [] };
  places: Place[] = [];
  plazas: Plaza[] = [];
  /** called after a rebuild that moved places or lots, so bodies follow (set by the World) */
  follow: ((before: Before, moved: Moved[]) => void) | null = null;
  /** increments on every rebuild (lets the server know to resend the grid) */
  version = 0;
  private byId = new Map<string, Place>();
  private desks = new Map<string, DeskSlot[]>();
  private doors = new Map<string, Tile>();
  private sides = new Map<string, Side>();
  private seats = new Map<string, Tile[]>();

  constructor(private db: DB, private repos: Repos) {}

  /** Recompute the grid and places from the goal tree, store each building's lot, persist places; bodies follow. Returns the buildings the tree moved or resized. */
  rebuild(): Moved[] {
    // the first rebuild after a start compares against the places the last run stored, so bodies follow a map that changed across a deploy
    const was = this.places.length ? this.places : this.repos.places.all();
    const before: Before = { places: new Map(was.map((p) => [p.id, p.pos])), seats: new Map(was.map((p) => [p.id, this.seatsOf(p.id)])) };
    const buildings = this.repos.buildings.all();
    const res = this.compute(buildings);
    const moved: Moved[] = [];
    for (const b of buildings) {
      const lot = res.lots.get(b.id);
      if (!lot || (b.lot && b.lot.x === lot.x && b.lot.y === lot.y && b.lot.w === lot.w && b.lot.h === lot.h)) continue;
      if (b.lot) moved.push({ id: b.id, from: b.lot, to: lot });
      this.repos.buildings.upsert({ ...b, lot });
    }
    this.grid = res.grid;
    this.plazas = res.plazas;
    this.places = res.places;
    this.desks = res.desks;
    this.doors = res.doors;
    this.sides = res.sides;
    this.seats = res.seats;
    this.byId = new Map(res.places.map((p) => [p.id, p]));
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM places").run();
      for (const p of res.places) this.repos.places.upsert(p, { silent: true });
    })();
    this.version++;
    const shifted = res.places.some((p) => { const was = before.places.get(p.id); return !!was && (was.x !== p.pos.x || was.y !== p.pos.y); });
    if (this.follow && before.places.size && (moved.length || shifted)) this.follow(before, moved);
    return moved;
  }

  private compute(buildings: Building[]) {
    const occupancy = new Map<string, Map<number, string>>();
    for (const r of this.db.prepare("SELECT buildingId, n, agentId FROM desks").all() as { buildingId: string; n: number; agentId: string }[]) {
      if (!occupancy.has(r.buildingId)) occupancy.set(r.buildingId, new Map());
      occupancy.get(r.buildingId)!.set(r.n, r.agentId);
    }
    const names = new Map(this.repos.agents.all().map((a) => [a.id, a.name]));
    return computeLayout(buildings.map((b) => this.drawn(b)), this.repos.goals.where("status = 'active'"), occupancy, names, this.repos.town.get().mapLayout);
  }

  /**
   * The building as the map draws it. A headcount lowered below the desks in use (1:1 mt_cyd2t5ioob decision 5) caps
   * new forks at once (forks.ts `freeDesks`) but never takes a desk from a running one: a lab keeps its lot and desk
   * pieces up to its highest occupied desk, and shrinks as those desks free (releaseDesk rebuilds). Town Hall's
   * size and seats don't follow its headcount.
   */
  private drawn(b: Building): Building {
    if (b.kind !== "lab") return b;
    const top = (this.db.prepare("SELECT MAX(n) AS n FROM desks WHERE buildingId = ?").get(b.id) as { n: number | null }).n;
    return top != null && top >= b.headcount ? { ...b, headcount: top + 1 } : b;
  }

  /** The building's movable pieces, each with its default and current anchor (lot-relative). */
  pieces(buildingId: string): { lot: Building["lot"]; pieces: (Piece & { current: Tile })[] } {
    const b = this.repos.buildings.require(buildingId, "building");
    if (!b.lot) return { lot: undefined, pieces: [] };
    const side = this.sides.get(b.id);
    const pieces = piecesFor(b.kind, this.drawn(b).headcount, b.lot, side);
    const { anchors } = resolveFurniture(b.kind, b.lot, pieces, b.furniture, side);
    return { lot: b.lot, pieces: pieces.map((p) => ({ ...p, current: anchors[p.key] ?? p.at })) };
  }

  /**
   * Check a proposed room (`furniture`: lot-relative anchors; missing pieces stay where they are now) without
   * saving it. Returns the errors, the moved-only furniture to store, and the whole grid as it would look.
   */
  preview(buildingId: string, furniture: Furniture): { errors: LayoutError[]; furniture: Furniture; grid: Grid; places: Place[] } {
    const b = this.repos.buildings.require(buildingId, "building");
    if (!b.lot) throw new AppError("conflict", `${b.name} has no lot yet.`);
    const { pieces } = this.pieces(buildingId);
    const unknown = Object.keys(furniture).filter((k) => !pieces.some((p) => p.key === k));
    if (unknown.length) throw new AppError("bad_request", `Unknown furniture: ${unknown.join(", ")}.`);
    const anchors = Object.fromEntries(pieces.map((p) => [p.key, furniture[p.key] ?? p.current]));
    const errors = validateLayout(b.kind, b.lot, pieces, anchors, this.sides.get(b.id));
    const moved = movedOnly(pieces, anchors);
    const res = this.compute(this.repos.buildings.all().map((x) => (x.id === b.id ? { ...x, furniture: errors.length ? {} : moved } : x)));
    // an illegal draft can't be built as is: show it anyway, piece by piece, so the editor sees where things are
    if (errors.length) {
      const put = (x: number, y: number, t: number) => { if (x >= 0 && y >= 0 && x < res.grid.w && y < res.grid.h) res.grid.tiles[y * res.grid.w + x] = t; };
      for (const p of pieces) for (const c of p.cells) put(b.lot.x + p.at.x + c.dx, b.lot.y + p.at.y + c.dy, p.wall ? TILE.WALL : TILE.FLOOR);
      for (const p of pieces) for (const c of p.cells) put(b.lot.x + anchors[p.key].x + c.dx, b.lot.y + anchors[p.key].y + c.dy, c.tile);
    }
    return { errors, furniture: moved, grid: res.grid, places: res.places.filter((p) => p.buildingId === b.id) };
  }

  place(id: string): Place | undefined {
    return this.byId.get(id);
  }
  requirePlace(id: string): Place {
    const p = this.byId.get(id);
    if (!p) throw notFound("place", id);
    return p;
  }
  /** The `desk:<agentId>` place, if the agent has a desk. */
  deskOf(agentId: string): Place | undefined {
    return this.byId.get(`desk:${agentId}`);
  }
  door(buildingId: string): Tile | undefined {
    return this.doors.get(buildingId);
  }
  deskSlots(buildingId: string): DeskSlot[] {
    return this.desks.get(buildingId) ?? [];
  }

  /**
   * Give the agent the lowest free desk in the building (or desk `prefer` when it is free), never a taken one; rebuilds
   * the layout. With `grow`, a full lab grows its headcount by a desk (up to MAX_HEADCOUNT) instead of refusing.
   */
  claimDesk(buildingId: string, agentId: string, opts: { grow?: boolean; prefer?: number | null } = {}): Place {
    const existing = this.deskOf(agentId);
    if (existing) return existing;
    const b = this.repos.buildings.require(buildingId, "building");
    const taken = new Set((this.db.prepare("SELECT n FROM desks WHERE buildingId = ?").all(buildingId) as { n: number }[]).map((r) => r.n));
    // Town Hall's desks are the mod-station seats
    const capacity = b.kind === "town-hall" ? MOD_SEATS : b.headcount;
    // `prefer` (a fork's chain desk) wins when it is free and within the headcount; else the lowest free desk
    let n = opts.prefer != null && opts.prefer >= 0 && opts.prefer < capacity && !taken.has(opts.prefer) ? opts.prefer : 0;
    while (taken.has(n)) n++;
    if (n >= capacity) {
      if (!opts.grow || b.kind === "town-hall" || n >= MAX_HEADCOUNT) {
        throw new AppError("conflict", `${b.name} has no free desk (${b.kind === "town-hall" ? "mod station seats" : "headcount"} ${capacity}).`);
      }
      this.repos.buildings.upsert({ ...b, headcount: n + 1 });
    }
    this.db.prepare("INSERT INTO desks (buildingId, n, agentId) VALUES (?, ?, ?)").run(buildingId, n, agentId);
    this.rebuild();
    return this.deskOf(agentId)!;
  }
  /**
   * Startup repair: every live resident without a desk (legacy data, e.g. two residents left on one desk tile) claims
   * one in its home lab, growing the lab if it's full. Returns the residents that got a desk.
   */
  repairDesks(): { agentId: string; place: Place }[] {
    const seated = new Set((this.db.prepare("SELECT agentId FROM desks").all() as { agentId: string }[]).map((r) => r.agentId));
    const out: { agentId: string; place: Place }[] = [];
    for (const a of this.repos.agents.where("kind = 'resident' AND status NOT IN ('retired','banned') AND homeBuildingId IS NOT NULL AND forkOf IS NULL", [], "ORDER BY createdAt, id")) {
      if (seated.has(a.id)) continue;
      const b = this.repos.buildings.get(a.homeBuildingId!);
      if (!b) continue;
      try { out.push({ agentId: a.id, place: this.claimDesk(b.id, a.id, { grow: true }) }); } catch (e) { if (!(e instanceof AppError) || e.code !== "conflict") throw e; }
    }
    return out;
  }
  releaseDesk(agentId: string): void {
    this.db.prepare("DELETE FROM desks WHERE agentId = ?").run(agentId);
    this.rebuild();
  }
  deskCount(buildingId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM desks WHERE buildingId = ?").get(buildingId) as { n: number }).n;
  }

  /** Seats around a meeting-room's table (empty for other places). */
  seatsOf(placeId: string): Tile[] {
    return this.seats.get(placeId) ?? [];
  }
  /** First seat of the meeting room not in `taken` ("x,y" keys); the room's own tile if all are taken. */
  freeSeat(placeId: string, taken: Set<string>): Tile | undefined {
    const seats = this.seatsOf(placeId);
    return seats.find((s) => !taken.has(`${s.x},${s.y}`)) ?? this.place(placeId)?.pos;
  }

  isWalkable(x: number, y: number): boolean {
    return isWalkable(this.grid, x, y);
  }

  /** Building whose lot contains the tile (null = outside). */
  buildingAt(pos: Tile): Building | null {
    for (const b of this.repos.buildings.all()) {
      const l = b.lot;
      if (l && pos.x >= l.x && pos.x < l.x + l.w && pos.y >= l.y && pos.y < l.y + l.h) return b;
    }
    return null;
  }

  /** Place at or adjacent (Chebyshev <= 1) to the tile, exact match preferred. */
  placeAt(pos: Tile): Place | null {
    let best: Place | null = null, bd = 2;
    for (const p of this.places) {
      const d = Math.max(Math.abs(p.pos.x - pos.x), Math.abs(p.pos.y - pos.y));
      if (d < bd) { best = p; bd = d; }
    }
    if (bd === 0) return best;
    // a seat at a meeting table counts as that meeting room, even at the far end
    for (const [id, seats] of this.seats) if (seats.some((s) => s.x === pos.x && s.y === pos.y)) return this.byId.get(id) ?? best;
    return best;
  }
}
