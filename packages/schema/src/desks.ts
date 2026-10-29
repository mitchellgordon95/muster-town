/**
 * A lab's desks follow its floor space (Mitchell's flag dc_1hjoh9aurq): one desk per TILES_PER_DESK floor tiles inside
 * its walls, never more than its lot physically holds. Shared so core (every route that creates or resizes a building)
 * and the town planner (the read-only count while you draw or resize) agree.
 */

/** Floor tiles (inside the walls) per desk. 26 keeps every lab of the live town as it was when desks became derived (15×12 → 5, 15×9 → 3, 13×9 → 2). */
export const TILES_PER_DESK = 26;
/** Most desks a lab can have (the tallest lab that still fits north of the trunk road: rows*3 + 6 <= 38). */
export const MAX_HEADCOUNT = 30;

/** Smallest lab lot for a headcount: three desks a row, 4 tiles each, 3 tiles a row, plus walls and the door row. */
export function labSize(headcount: number): { w: number; h: number } {
  const n = Math.max(1, headcount);
  const cols = Math.min(3, n), rows = Math.ceil(n / cols);
  return { w: Math.max(cols * 4 + 3, 13), h: rows * 3 + 6 };
}

/** Floor tiles inside a lot's walls. */
export const floorTiles = (lot: { w: number; h: number }): number => Math.max(0, lot.w - 2) * Math.max(0, lot.h - 2);

/** Most desks whose lab fits the lot (0 = not even one). */
export function deskRoom(lot: { w: number; h: number }): number {
  for (let n = MAX_HEADCOUNT; n >= 1; n--) { const s = labSize(n); if (lot.w >= s.w && lot.h >= s.h) return n; }
  return 0;
}

/** A lab's desks for its lot: floor tiles / TILES_PER_DESK rounded down, at least 1, at most what the lot holds. */
export function desksForLot(lot: { w: number; h: number }): number {
  return Math.max(1, Math.min(Math.floor(floorTiles(lot) / TILES_PER_DESK), deskRoom(lot)));
}

/** The lot a building made without a drawn lot (the Planning desk's "New building" form, POST /api/buildings) gets: a 6-desk lab's size. Its desks are desksForLot of it. */
export const NEW_LAB_LOT: { w: number; h: number } = labSize(6);
