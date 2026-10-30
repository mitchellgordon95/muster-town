/**
 * Town planning mode: the whole town, zoomed out, read-only (docs/goals.md "The map is the tree"). Nobody places
 * buildings any more: the server draws the map from the goal tree, a building stands at the goal it is attached to
 * and its size follows its Desks. Click a building to select it: the side bar shows what it is attached to (Change…
 * opens its Settings), its budget and its stats. Anyone can look.
 */
import { useSyncExternalStore } from "react";
import { store } from "../state";

export interface PlanDraft {
  /** the selected building's id */
  selected: string | null;
}

let draft: PlanDraft | null = null;
const listeners = new Set<() => void>();

function set(next: PlanDraft | null) { draft = next; for (const l of listeners) l(); }
const inside = (l: { x: number; y: number; w: number; h: number }, x: number, y: number) => x >= l.x && y >= l.y && x < l.x + l.w && y < l.y + l.h;

export const townPlan = {
  get draft() { return draft; },
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },

  start() {
    store.open(null);
    set({ selected: null });
  },
  cancel() { set(null); },
  /** The building standing on an absolute tile (null = none). */
  buildingAt(x: number, y: number): string | null {
    return store.state.buildings.find((b) => b.lot && inside(b.lot, x, y))?.id ?? null;
  },
  select(id: string | null) { if (draft) set({ ...draft, selected: id }); },
};

export function useTownPlan(): PlanDraft | null {
  return useSyncExternalStore(townPlan.subscribe, () => draft, () => draft);
}

/** The Town Hall map table (E or a click): the whole town, drawn from the goal tree. */
export function openTownPlanning() {
  townPlan.start();
}
