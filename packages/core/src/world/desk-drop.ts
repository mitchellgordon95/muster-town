import type { Lot, Tile } from "@muster-town/schema";
import { validateLayout, type Furniture, type Piece } from "./furniture.ts";
import type { Side } from "./road.ts";

/**
 * Drag a resident on the map (Mitchell's flag dc_mf6oelioq5): where a dropped agent's desk goes. Pure: the room, its
 * desks and the drop tile in, the furniture change (or why not) out; the shell (entities.ts `dropAgent`) saves it with
 * `updateFurniture`, whose rebuild moves the bodies.
 *
 * - On another desk of the same room (its cells or the tile its sitter stands on): the two desk pieces swap places, so
 *   the agent now sits where that desk was and that desk's sitter, if any, sits where the agent's was. The `desks` rows
 *   are left alone: a desk number is a fork's sandbox slot (forks.ts `desk_slots`), which must not change mid-session.
 * - On free floor of its own room: its desk piece moves so the agent stands on the drop tile, under the furniture rules.
 * - Anywhere else (another building, outside, the Town Hall's fixed seats): refused, with the reason in plain words.
 */
interface DeskDropRoom {
  kind: "lab" | "town-hall";
  name: string;
  /** absolute lot */
  lot: Lot;
  side?: Side;
  /** every movable piece with its current lot-relative anchor */
  pieces: (Piece & { current: Tile })[];
}

type DeskDrop =
  | { ok: true; kind: "swap" | "move"; furniture: Furniture; withAgentN: number | null }
  | { ok: false; message: string };

/** `deskN`: the dragged agent's desk number in this room (null = none here); `to`: the absolute drop tile. */
export function deskDrop(room: DeskDropRoom, agentName: string, deskN: number | null, to: Tile): DeskDrop {
  const { lot } = room;
  if (deskN == null) return { ok: false, message: `${agentName} has no desk in ${room.name}.` };
  const inLot = to.x >= lot.x && to.y >= lot.y && to.x < lot.x + lot.w && to.y < lot.y + lot.h;
  if (!inLot) return { ok: false, message: `${agentName} works in ${room.name}. Drop them inside it.` };
  if (room.kind !== "lab") return { ok: false, message: `${room.name}'s seats are fixed. Use Edit layout to move the furniture.` };
  const mine = room.pieces.find((p) => p.key === `desk:${deskN}`);
  if (!mine) return { ok: false, message: `${agentName}'s desk is not in ${room.name}'s layout.` };
  const rel = { x: to.x - lot.x, y: to.y - lot.y };
  const covers = (p: Piece & { current: Tile }) =>
    p.cells.some((c) => p.current.x + c.dx === rel.x && p.current.y + c.dy === rel.y) ||
    p.stands.some((s) => p.current.x + s.x === rel.x && p.current.y + s.y === rel.y);
  const anchors = Object.fromEntries(room.pieces.map((p) => [p.key, p.current]));
  /** the first rule the change breaks, or null */
  const check = (change: Furniture): string | null => validateLayout(room.kind, lot, room.pieces, { ...anchors, ...change }, room.side)[0]?.message ?? null;
  if (covers(mine)) return { ok: false, message: `${agentName} is already at that desk.` };
  const other = room.pieces.find((p) => p.key.startsWith("desk:") && covers(p));
  if (other) {
    // desks share one shape, so a swap keeps a legal room legal; checked anyway
    const change = { [mine.key]: other.current, [other.key]: mine.current };
    const bad = check(change);
    if (bad) return { ok: false, message: bad };
    return { ok: true, kind: "swap", furniture: change, withAgentN: Number(other.key.slice(5)) };
  }
  const stand = mine.stands[0] ?? { x: 0, y: 0 };
  const change = { [mine.key]: { x: rel.x - stand.x, y: rel.y - stand.y } };
  const bad = check(change);
  if (bad) return { ok: false, message: `Can't put ${agentName}'s desk there: ${bad}` };
  return { ok: true, kind: "move", furniture: change, withAgentN: null };
}
