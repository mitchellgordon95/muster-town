import { BANK_LOT, type Building, type Lot } from "@muster-town/schema";
import { sizeFor, townSize } from "./layout.ts";
import { deriveRoads, doorOf, ROAD_Y } from "./road.ts";

export { doorOf };

/**
 * Town planning: the rules for where buildings may stand. One function drives the planner's dry run and the
 * server's check on Save. A building stands on any free grass on the map (not on the trunk road) with at least one
 * tile of grass on every side, the Bank included. Roads aren't planned: they are derived from the lots
 * (`deriveRoads`), one from each door to the trunk road or a road already routed, so the only road rule is that
 * every door reaches one. North of the trunk the door is bottom middle; south of it, top middle.
 */
export interface PlanError { buildingId: string | null; message: string }
export interface PlanLot { id: string; name: string; kind: Building["kind"]; headcount: number; lot: Lot }

/** Largest lot the planner allows. */
export const MAX_LOT = { w: 48, h: ROAD_Y - 2 } as const;
/** Lots stay left of this x and above this y, so the town can't be stretched without bound. */
export const MAX_TOWN_X = 240;
export const MAX_TOWN_Y = ROAD_Y + 2 + MAX_LOT.h + 1;
const hit = (a: Lot, b: Lot) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const grow = (l: Lot, n: number): Lot => ({ x: l.x - n, y: l.y - n, w: l.w + 2 * n, h: l.h + 2 * n });

/** The checks, in order; empty = legal. Each pair overlap is reported once. */
export function validatePlan(lots: PlanLot[]): PlanError[] {
  const errors: PlanError[] = [];
  for (const b of lots) {
    const { x, y, w, h } = b.lot;
    const need = b.kind === "town-hall" ? sizeFor({ kind: "town-hall" } as Building) : sizeFor({ kind: "lab", headcount: b.headcount } as Building);
    if (![x, y, w, h].every(Number.isInteger)) errors.push({ buildingId: b.id, message: `${b.name}: the lot must be whole tiles.` });
    else if (w < need.w || h < need.h) errors.push({ buildingId: b.id, message: `${b.name} needs at least ${need.w}×${need.h} tiles for ${b.kind === "town-hall" ? "its rooms" : `${b.headcount} desk${b.headcount === 1 ? "" : "s"}`}.` });
    else if (w > MAX_LOT.w || h > MAX_LOT.h) errors.push({ buildingId: b.id, message: `${b.name} can be at most ${MAX_LOT.w}×${MAX_LOT.h} tiles.` });
    else if (x < 1 || y < 1 || x + w > MAX_TOWN_X || y + h > MAX_TOWN_Y) errors.push({ buildingId: b.id, message: `${b.name} is off the edge of the map.` });
    else if (y + h > ROAD_Y && y < ROAD_Y + 2) errors.push({ buildingId: b.id, message: `${b.name} can't stand on the main road.` });
    else if (hit(grow(BANK_LOT, 1), b.lot)) errors.push({ buildingId: b.id, message: `${b.name} overlaps or touches the Bank (leave a tile between them).` });
  }
  for (let i = 0; i < lots.length; i++) for (let j = i + 1; j < lots.length; j++) {
    const a = lots[i], b = lots[j];
    if (hit(grow(a.lot, 1), b.lot)) errors.push({ buildingId: a.id, message: `${a.name} and ${b.name} overlap or touch (leave a tile between them).` });
  }
  if (errors.length) return errors;
  const size = townSize(lots.map((b) => b.lot));
  const roads = deriveRoads(lots.map((b) => ({ id: b.id, lot: b.lot })), size.w, size.h);
  for (const id of roads.unreached) {
    const b = lots.find((l) => l.id === id);
    errors.push({ buildingId: b?.id ?? null, message: `${b?.name ?? "The Bank"}: no road can reach its door (it's boxed in).` });
  }
  return errors;
}

export const planLot = (b: Building): PlanLot | null => (b.lot ? { id: b.id, name: b.name, kind: b.kind, headcount: b.headcount, lot: b.lot } : null);
