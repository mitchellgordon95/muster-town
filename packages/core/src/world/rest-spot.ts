import { TILE, WALKABLE, type Lot, type Tile } from "@muster-town/schema";
import type { Grid } from "./layout.ts";

/**
 * Drag only the body (Mitchell's flag dc_d2wkuhoh1l, after PR #477 moved the desk with it): a human drops an agent
 * with the grasper hand and the drop tile becomes where it rests. Pure: the grid, the lots and the tile in, the spot to
 * store (or why not) out. The shell (entities.ts `dropAgent`) saves it in `rest_spots`; computeLayout then puts the
 * agent's `desk:<agentId>` place there, so everything that walks a body home (session start, idle tick, meeting end,
 * restart re-seating, a map rebuild) goes to the spot. The desk furniture never moves.
 */
export interface RestSpot {
  /** the building whose lot `x`, `y` are relative to (the spot follows the building when the map redraws); null = absolute */
  buildingId: string | null;
  x: number;
  y: number;
}

type RestDrop = { ok: true; spot: RestSpot | null } | { ok: false; message: string };

const tileAt = (grid: Grid, t: Tile) => (t.x >= 0 && t.y >= 0 && t.x < grid.w && t.y < grid.h ? grid.tiles[t.y * grid.w + t.x] : -1);

/** Can a body rest on this tile: on the map, walkable (no wall, furniture or water), not a doorway. */
function canRest(grid: Grid, t: Tile): boolean {
  const tile = tileAt(grid, t);
  return WALKABLE.has(tile) && tile !== TILE.DOOR;
}

/** The absolute tile of a stored spot, or null when its building is gone or the tile can't be stood on now (then the default spot holds). */
export function restTile(spot: RestSpot, lots: ReadonlyMap<string, Lot>, grid: Grid): Tile | null {
  let t: Tile = { x: spot.x, y: spot.y };
  if (spot.buildingId) {
    const lot = lots.get(spot.buildingId);
    if (!lot) return null;
    t = { x: lot.x + spot.x, y: lot.y + spot.y };
  }
  return canRest(grid, t) ? t : null;
}

/**
 * Where a dropped agent rests. `home`: its default spot (its desk's stand tile, or its Town Hall rest); dropping it
 * there clears the stored spot (spot null). Anywhere else that a body can stand becomes its spot, kept relative to the
 * building it is in, if any.
 */
export function restDrop(grid: Grid, lots: ReadonlyMap<string, Lot>, name: string, home: Tile, to: Tile): RestDrop {
  if (to.x === home.x && to.y === home.y) return { ok: true, spot: null };
  const tile = tileAt(grid, to);
  if (tile === -1) return { ok: false, message: `That is off the map. Drop ${name} on the town.` };
  if (tile === TILE.DOOR) return { ok: false, message: `${name} would block the door. Drop them beside it.` };
  if (!WALKABLE.has(tile)) return { ok: false, message: `${name} can't stand there: it is a wall, furniture or water.` };
  for (const [buildingId, l] of lots) {
    if (to.x >= l.x && to.y >= l.y && to.x < l.x + l.w && to.y < l.y + l.h) return { ok: true, spot: { buildingId, x: to.x - l.x, y: to.y - l.y } };
  }
  return { ok: true, spot: { buildingId: null, x: to.x, y: to.y } };
}
