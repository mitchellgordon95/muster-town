/**
 * Drag a resident to a new spot with the grasper hand (Mitchell's flag dc_mf6oelioq5). In the normal map view a human
 * with building.manage where the agent works presses on its body and drags: the cursor is a grab hand, then a closed
 * one, and the body hangs from a pixel fist (renderer.ts `drag`). On drop the server decides (core world/desk-drop.ts):
 * on another desk of its room the two desks swap; on free floor its desk moves there; anywhere else it snaps back with a
 * toast saying why. A press that doesn't move past DRAG_PX stays a click (it opens the agent's panel).
 */
import type { Agent, Tile } from "@muster-town/schema";
import { api } from "../api";
import { store } from "../state";
import type { MapRenderer } from "./renderer";

/** CSS px the pointer must travel before a press on a body becomes a drag */
const DRAG_PX = 5;

/** May the signed-in human drag this agent: a resident or visitor (not a human's avatar), managed by them. */
export function canDrag(a: Agent | undefined, can: (perm: "building.manage", buildingId: string) => boolean): boolean {
  if (!a || a.kind === "human" || a.status === "retired") return false;
  const home = a.homeBuildingId ?? a.buildingId;
  return !!home && can("building.manage", home);
}

interface Press { id: string; sx: number; sy: number; live: boolean }
let press: Press | null = null;
/** set when a drag ended on mouse-up, so the click that follows doesn't open the panel or walk */
let swallowClick = false;

export const residentDrag = {
  get active() { return !!press?.live; },
  /** Mouse down on the map: start a press if it is on a body this human may move. */
  down(r: MapRenderer, x: number, y: number): boolean {
    const id = r.hit(x, y);
    if (!id || !canDrag(store.state.agents[id], (p, b) => store.can(p, b))) return false;
    press = { id, sx: x, sy: y, live: false };
    return true;
  },
  /** Mouse move: returns the cursor while a press is held, else null. */
  move(r: MapRenderer, x: number, y: number): string | null {
    if (!press) return null;
    if (!press.live && Math.hypot(x - press.sx, y - press.sy) >= DRAG_PX) press.live = true;
    if (press.live) r.drag = { id: press.id, cx: x, cy: y };
    return press.live ? "grabbing" : "grab";
  },
  /** Mouse up: drop a live drag on the tile under the pointer. */
  up(r: MapRenderer, x: number, y: number) {
    const p = press; press = null;
    if (!p?.live) return;
    swallowClick = true;
    r.drag = { id: p.id, cx: x, cy: y };
    void drop(r, p.id, r.tileAt(x, y));
  },
  /** The pointer left the map: let go, the body snaps back. */
  cancel(r: MapRenderer) { if (press?.live) r.endDrag(false); press = null; },
  /** True once, for the click event that ends a drag. */
  swallow(): boolean { const s = swallowClick; swallowClick = false; return s; },
  /** The cursor over a body when nothing is held: a grab hand on one this human may move. */
  hoverCursor(id: string | null): string | null {
    return id && canDrag(store.state.agents[id], (p, b) => store.can(p, b)) ? "grab" : null;
  },
};

async function drop(r: MapRenderer, id: string, to: Tile) {
  const name = store.state.agents[id]?.name ?? "The agent";
  try {
    const res = await api().dropAgent(id, to);
    store.livePos.set(id, { ...res.pos, at: performance.now() });
    r.endDrag(true);
    const other = res.withAgentId ? store.state.agents[res.withAgentId]?.name : null;
    store.toast(res.kind === "swap" ? (other ? `${name} and ${other} swapped desks` : `${name} moved to the free desk`) : `${name}'s desk moved here`, "ok");
  } catch (e) {
    r.endDrag(false);
    store.toast((e as Error).message, "bad");
  }
}
