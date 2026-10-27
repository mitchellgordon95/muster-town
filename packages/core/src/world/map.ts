import { TILE, type Building, type Lot, type Place, type Tile } from "@muster-town/schema";
import type { DB } from "../db.ts";
import { AppError, notFound } from "../errors.ts";
import type { Repos } from "../store.ts";
import { movedOnly, piecesFor, resolveFurniture, validateLayout, type Furniture, type LayoutError, type Piece } from "./furniture.ts";
import { assignLots, computeLayout, MAX_HEADCOUNT, MOD_SEATS, type DeskSlot, type Grid } from "./layout.ts";
import { isWalkable } from "./path.ts";
import { planLot, validatePlan, type PlanError, type PlanLot } from "./plan.ts";

/** World geometry service: `world.layout`. Rebuilt whenever buildings or desk occupancy change. */
export class WorldMap {
  grid: Grid = { w: 0, h: 0, tiles: [] };
  places: Place[] = [];
  /** increments on every rebuild (lets the server know to resend the grid) */
  version = 0;
  private byId = new Map<string, Place>();
  private desks = new Map<string, DeskSlot[]>();
  private doors = new Map<string, Tile>();
  private seats = new Map<string, Tile[]>();

  constructor(private db: DB, private repos: Repos) {}

  /** Assign missing lots, recompute grid + places, persist places. Returns buildings whose lot changed. */
  rebuild(): Building[] {
    const changed = assignLots(this.repos.buildings.all());
    for (const b of changed) this.repos.buildings.upsert(b);
    const buildings = this.repos.buildings.all();
    const res = this.compute(buildings);
    this.grid = res.grid;
    this.places = res.places;
    this.desks = res.desks;
    this.doors = res.doors;
    this.seats = res.seats;
    this.byId = new Map(res.places.map((p) => [p.id, p]));
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM places").run();
      for (const p of res.places) this.repos.places.upsert(p, { silent: true });
    })();
    this.version++;
    return changed;
  }

  private compute(buildings: Building[]) {
    const occupancy = new Map<string, Map<number, string>>();
    for (const r of this.db.prepare("SELECT buildingId, n, agentId FROM desks").all() as { buildingId: string; n: number; agentId: string }[]) {
      if (!occupancy.has(r.buildingId)) occupancy.set(r.buildingId, new Map());
      occupancy.get(r.buildingId)!.set(r.n, r.agentId);
    }
    const names = new Map(this.repos.agents.all().map((a) => [a.id, a.name]));
    return computeLayout(buildings, occupancy, names);
  }

  /** The building's movable pieces, each with its default and current anchor (lot-relative). */
  pieces(buildingId: string): { lot: Building["lot"]; pieces: (Piece & { current: Tile })[] } {
    const b = this.repos.buildings.require(buildingId, "building");
    if (!b.lot) return { lot: undefined, pieces: [] };
    const pieces = piecesFor(b.kind, b.headcount, b.lot);
    const { anchors } = resolveFurniture(b.lot, pieces, b.furniture);
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
    const errors = validateLayout(b.lot, pieces, anchors);
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

  /**
   * Check a town plan (`lots`: new lot per building, left out = stays put; `create`: one new building drawn on the
   * map) without saving it. Returns the errors and the whole grid as it would look (drawn even when illegal, so the
   * planner sees where things are). The new building's id in `places` is `new`.
   */
  planPreview(lots: Record<string, Lot>, create?: { name: string; headcount?: number; lot: Lot }): { errors: PlanError[]; grid: Grid; places: Place[] } {
    const all = this.repos.buildings.all();
    const unknown = Object.keys(lots).filter((id) => !all.some((b) => b.id === id));
    if (unknown.length) throw new AppError("bad_request", `Unknown building: ${unknown.join(", ")}.`);
    const next = all.map((b) => (lots[b.id] ? { ...b, lot: lots[b.id] } : b));
    if (create) next.push({ id: "new", name: create.name || "New building", kind: "lab", headcount: create.headcount ?? 6, lot: create.lot, furniture: {} } as Building);
    const plan = next.map(planLot).filter((p): p is PlanLot => !!p);
    const errors = validatePlan(plan);
    const res = this.compute(next);
    return { errors, grid: res.grid, places: res.places };
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
   * Give the agent the lowest free desk in the building, never a taken one; rebuilds the layout. With `grow`, a full
   * lab grows its headcount by a desk (up to MAX_HEADCOUNT) instead of refusing, so it always has a desk per resident.
   */
  claimDesk(buildingId: string, agentId: string, opts: { grow?: boolean } = {}): Place {
    const existing = this.deskOf(agentId);
    if (existing) return existing;
    const b = this.repos.buildings.require(buildingId, "building");
    const taken = new Set((this.db.prepare("SELECT n FROM desks WHERE buildingId = ?").all(buildingId) as { n: number }[]).map((r) => r.n));
    let n = 0;
    while (taken.has(n)) n++;
    // Town Hall's desks are the mod-station seats
    const capacity = b.kind === "town-hall" ? MOD_SEATS : b.headcount;
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
