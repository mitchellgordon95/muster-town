import type { Building, Lot } from "@muster-town/schema";
import { ROAD_Y, sizeFor } from "./layout.ts";

/**
 * Town planning: the rules for where buildings may stand. One function drives the planner's dry run and the
 * server's check on Save. A building sits north of the road with at least one tile of grass on every side, its
 * door (bottom middle) walks straight down to the road, and that walk may not cross another building.
 */
export interface PlanError { buildingId: string | null; message: string }
export interface PlanLot { id: string; name: string; kind: Building["kind"]; headcount: number; lot: Lot }

/** Largest lot the planner allows. */
export const MAX_LOT = { w: 48, h: ROAD_Y - 2 } as const;
/** Lots stay left of this x, so the town can't be stretched without bound. */
export const MAX_TOWN_X = 240;

export const doorOf = (lot: Lot) => ({ x: lot.x + Math.floor(lot.w / 2), y: lot.y + lot.h - 1 });
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
    else if (x < 1 || y < 1 || x + w > MAX_TOWN_X) errors.push({ buildingId: b.id, message: `${b.name} is off the edge of the map.` });
    else if (y + h > ROAD_Y) errors.push({ buildingId: b.id, message: `${b.name} must stand north of the road.` });
  }
  for (let i = 0; i < lots.length; i++) for (let j = i + 1; j < lots.length; j++) {
    const a = lots[i], b = lots[j];
    if (hit(grow(a.lot, 1), b.lot)) errors.push({ buildingId: a.id, message: `${a.name} and ${b.name} overlap or touch (leave a tile between them).` });
  }
  for (const a of lots) {
    const d = doorOf(a.lot);
    const path: Lot = { x: d.x, y: a.lot.y + a.lot.h, w: 1, h: Math.max(0, ROAD_Y - a.lot.y - a.lot.h) };
    if (!path.h) continue;
    for (const b of lots) if (b.id !== a.id && hit(path, b.lot)) errors.push({ buildingId: a.id, message: `${a.name}'s path to the road runs through ${b.name}.` });
  }
  return errors;
}

export const planLot = (b: Building): PlanLot | null => (b.lot ? { id: b.id, name: b.name, kind: b.kind, headcount: b.headcount, lot: b.lot } : null);
