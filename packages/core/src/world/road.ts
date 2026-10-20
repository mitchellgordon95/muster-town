import type { Lot } from "@muster-town/schema";

/** y of the main road (2 tiles tall). Fixed so lots stay stable. */
export const ROAD_Y = 40;

/** A lot south of the road faces it: its door is in the top wall and its room is laid out mirrored. */
export const facesNorth = (lot: Pick<Lot, "h"> & { y?: number }) => lot.y !== undefined && lot.y >= ROAD_Y + 2;

/** The door tile: bottom middle, or top middle for a lot south of the road. */
export const doorOf = (lot: Lot) => ({ x: lot.x + Math.floor(lot.w / 2), y: facesNorth(lot) ? lot.y : lot.y + lot.h - 1 });
