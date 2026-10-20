import type { Building, Place, Tile } from "@agent-town/schema";
import type { DB } from "../db.ts";
import { AppError, notFound } from "../errors.ts";
import type { Repos } from "../store.ts";
import { assignLots, computeLayout, MOD_SEATS, type DeskSlot, type Grid } from "./layout.ts";
import { isWalkable } from "./path.ts";

/** World geometry service: `world.layout`. Rebuilt whenever buildings or desk occupancy change. */
export class WorldMap {
  grid: Grid = { w: 0, h: 0, tiles: [] };
  places: Place[] = [];
  /** increments on every rebuild (lets the server know to resend the grid) */
  version = 0;
  private byId = new Map<string, Place>();
  private desks = new Map<string, DeskSlot[]>();
  private doors = new Map<string, Tile>();

  constructor(private db: DB, private repos: Repos) {}

  /** Assign missing lots, recompute grid + places, persist places. Returns buildings whose lot changed. */
  rebuild(): Building[] {
    const changed = assignLots(this.repos.buildings.all());
    for (const b of changed) this.repos.buildings.upsert(b);
    const buildings = this.repos.buildings.all();
    const occupancy = new Map<string, Map<number, string>>();
    for (const r of this.db.prepare("SELECT buildingId, n, agentId FROM desks").all() as { buildingId: string; n: number; agentId: string }[]) {
      if (!occupancy.has(r.buildingId)) occupancy.set(r.buildingId, new Map());
      occupancy.get(r.buildingId)!.set(r.n, r.agentId);
    }
    const names = new Map(this.repos.agents.all().map((a) => [a.id, a.name]));
    const res = computeLayout(buildings, occupancy, names);
    this.grid = res.grid;
    this.places = res.places;
    this.desks = res.desks;
    this.doors = res.doors;
    this.byId = new Map(res.places.map((p) => [p.id, p]));
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM places").run();
      for (const p of res.places) this.repos.places.upsert(p, { silent: true });
    })();
    this.version++;
    return changed;
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

  /** Give the agent the lowest free desk in the building; rebuilds the layout. */
  claimDesk(buildingId: string, agentId: string): Place {
    const existing = this.deskOf(agentId);
    if (existing) return existing;
    const b = this.repos.buildings.require(buildingId, "building");
    const taken = new Set((this.db.prepare("SELECT n FROM desks WHERE buildingId = ?").all(buildingId) as { n: number }[]).map((r) => r.n));
    let n = 0;
    while (taken.has(n)) n++;
    // Town Hall's desks are the mod-station seats
    const capacity = b.kind === "town-hall" ? MOD_SEATS : b.headcount;
    if (n >= capacity) throw new AppError("conflict", `${b.name} has no free desk (${b.kind === "town-hall" ? "mod station seats" : "headcount"} ${capacity}).`);
    this.db.prepare("INSERT INTO desks (buildingId, n, agentId) VALUES (?, ?, ?)").run(buildingId, n, agentId);
    this.rebuild();
    return this.deskOf(agentId)!;
  }
  releaseDesk(agentId: string): void {
    this.db.prepare("DELETE FROM desks WHERE agentId = ?").run(agentId);
    this.rebuild();
  }
  deskCount(buildingId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM desks WHERE buildingId = ?").get(buildingId) as { n: number }).n;
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
    return best;
  }
}
