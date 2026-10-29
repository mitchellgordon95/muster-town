/**
 * Town planning mode: the Edit layout idea one level up. A client-side draft of every building's lot, shown in the
 * same zoomed-out view as the Bank's town map. Drag a building to move it, drag its walls to resize it, drag on
 * empty grass to draw a new one. Every change asks the server for a dry run (its rules are final: no overlaps,
 * a tile of grass between buildings, every door reachable by a road) and shows the grid it returns, with the roads
 * routed from the drafted lots; Save sends the moved lots and the new building in one call. Humans with town.manage_buildings only.
 */
import { useSyncExternalStore } from "react";
import type { Lot, Place } from "@muster-town/schema";
import { api, type Grid } from "../api";
import { store } from "../state";

export interface NewBuilding { lot: Lot; name: string; goal: string; headcount: number }
/** What a drag grabs: the whole lot, some of its walls, or the corner a new lot is drawn from. */
export type Grab = { id: string; kind: "move"; gx: number; gy: number } | { id: string; kind: "resize"; l: boolean; r: boolean; t: boolean; b: boolean } | { id: "new"; kind: "draw"; ax: number; ay: number };

export interface PlanDraft {
  /** every building's lot as drafted (by building id) */
  lots: Record<string, Lot>;
  /** the lots when planning started */
  original: Record<string, Lot>;
  create: NewBuilding | null;
  history: { lots: Record<string, Lot>; create: NewBuilding | null }[];
  /** building id, or `new` */
  selected: string | null;
  errors: { buildingId: string | null; message: string }[];
  /** the server's dry-run grid and places for the draft (null until the first answer) */
  preview: Grid | null;
  places: Place[] | null;
  previewVersion: number;
  saving: boolean;
}

/** Smallest lab lot for a headcount (mirrors core's `labSize`; the server's check is final). */
export function labSize(headcount: number): { w: number; h: number } {
  const n = Math.max(1, headcount);
  const cols = Math.min(3, n), rows = Math.ceil(n / cols);
  return { w: Math.max(cols * 4 + 3, 13), h: rows * 3 + 6 };
}
/** Most desks a lot holds (up to the form's 24); 0 = too small for one. Drawing or resizing the new building sets its desks to this. */
export function desksFor(lot: { w: number; h: number }): number {
  for (let n = 24; n >= 1; n--) { const s = labSize(n); if (lot.w >= s.w && lot.h >= s.h) return n; }
  return 0;
}

let draft: PlanDraft | null = null;
const listeners = new Set<() => void>();
let seq = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

function set(next: PlanDraft | null) { draft = next; for (const l of listeners) l(); }
const sameLot = (a: Lot | undefined, b: Lot | undefined) => !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
const inside = (l: Lot, x: number, y: number) => x >= l.x && y >= l.y && x < l.x + l.w && y < l.y + l.h;
const snap = (d: PlanDraft) => ({ lots: d.lots, create: d.create });

export const townPlan = {
  get draft() { return draft; },
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },

  start() {
    const lots = Object.fromEntries(store.state.buildings.filter((b) => b.lot).map((b) => [b.id, b.lot!]));
    store.open(null);
    set({ lots, original: lots, create: null, history: [], selected: null, errors: [], preview: null, places: null, previewVersion: 0, saving: false });
    check();
  },
  cancel() { clearTimeout(timer); seq++; set(null); },

  /** The lot `id` as drafted (`new` = the building being drawn). */
  lotOf(id: string): Lot | null { return id === "new" ? draft?.create?.lot ?? null : draft?.lots[id] ?? null; },
  /** What a press on an absolute tile grabs: a wall resizes, the inside moves; null = empty grass. */
  grabAt(x: number, y: number): Grab | null {
    if (!draft) return null;
    const ids = [...(draft.create ? ["new"] : []), ...Object.keys(draft.lots)];
    for (const id of ids) {
      const l = this.lotOf(id)!;
      if (!inside(l, x, y)) continue;
      const e = { l: x === l.x, r: x === l.x + l.w - 1, t: y === l.y, b: y === l.y + l.h - 1 };
      if (e.l || e.r || e.t || e.b) return { id, kind: "resize", ...e };
      return { id, kind: "move", gx: x - l.x, gy: y - l.y };
    }
    return null;
  },
  select(id: string | null) { if (draft) set({ ...draft, selected: id }); },

  /** Put lot `id` somewhere new. `record` = false while dragging (the drop records it once). */
  setLot(id: string, lot: Lot, record = true) {
    if (!draft || sameLot(this.lotOf(id) ?? undefined, lot)) return;
    const history = record ? [...draft.history, snap(draft)] : draft.history;
    if (id === "new") { if (draft.create) set({ ...draft, create: { ...draft.create, lot }, history }); }
    else set({ ...draft, lots: { ...draft.lots, [id]: lot }, history });
    check();
  },
  /** Apply a drag to the tile under the pointer. */
  drag(g: Grab, x: number, y: number) {
    const cur = this.lotOf(g.id);
    if (g.kind === "draw") {
      const lot = { x: Math.min(g.ax, x), y: Math.min(g.ay, y), w: Math.abs(x - g.ax) + 1, h: Math.abs(y - g.ay) + 1 };
      if (!draft!.create) { set({ ...draft!, create: { lot, name: "", goal: "", headcount: desksFor(lot) || 6 }, selected: "new" }); check(); }
      else { this.setLot("new", lot, false); this.fitDesks(); }
      return;
    }
    if (!cur) return;
    if (g.kind === "move") { this.setLot(g.id, { ...cur, x: x - g.gx, y: y - g.gy }, false); return; }
    let { x: x0, y: y0 } = cur, x1 = cur.x + cur.w - 1, y1 = cur.y + cur.h - 1;
    if (g.l) x0 = Math.min(x, x1 - 2); if (g.r) x1 = Math.max(x, x0 + 2);
    if (g.t) y0 = Math.min(y, y1 - 2); if (g.b) y1 = Math.max(y, y0 + 2);
    this.setLot(g.id, { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }, false);
    if (g.id === "new") this.fitDesks();
  },
  /** The new building's desks follow its drawn size (a lot too small for one desk keeps the last count; the drop grows it). */
  fitDesks() {
    const c = draft?.create, n = c ? desksFor(c.lot) : 0;
    if (c && n && n !== c.headcount) set({ ...draft!, create: { ...c, headcount: n } });
  },
  /** After a drag: one Undo step back to where it started. A tiny new lot grows to the smallest that fits. */
  commitDrag(before: PlanDraft["history"][number]) {
    if (!draft) return;
    const c = draft.create;
    if (c) {
      const need = labSize(c.headcount);
      if (c.lot.w < need.w || c.lot.h < need.h) this.setLot("new", { ...c.lot, w: Math.max(c.lot.w, need.w), h: Math.max(c.lot.h, need.h) }, false);
    }
    if (draft.lots !== before.lots || draft.create !== before.create) set({ ...draft, history: [...draft.history, before] });
  },
  nudge(dx: number, dy: number) {
    const l = draft?.selected ? this.lotOf(draft.selected) : null;
    if (l) this.setLot(draft!.selected!, { ...l, x: l.x + dx, y: l.y + dy });
  },
  /** Name, goal, desks or review policy of the new building; more desks grow its lot to fit. */
  setNew(patch: Partial<Omit<NewBuilding, "lot">>) {
    if (!draft?.create) return;
    const c = { ...draft.create, ...patch };
    const need = labSize(c.headcount);
    c.lot = { ...c.lot, w: Math.max(c.lot.w, need.w), h: Math.max(c.lot.h, need.h) };
    set({ ...draft, create: c });
    if (patch.headcount !== undefined) check();
  },
  dropNew() {
    if (!draft?.create) return;
    set({ ...draft, create: null, selected: draft.selected === "new" ? null : draft.selected, history: [...draft.history, snap(draft)] });
    check();
  },
  undo() {
    if (!draft?.history.length) return;
    const prev = draft.history[draft.history.length - 1];
    set({ ...draft, ...prev, history: draft.history.slice(0, -1) });
    check();
  },
  /** Moved or resized lots only. */
  changed(): Record<string, Lot> {
    if (!draft) return {};
    return Object.fromEntries(Object.entries(draft.lots).filter(([id, l]) => !sameLot(l, draft!.original[id])));
  },
  dirty(): boolean { return !!draft && (!!draft.create || Object.keys(this.changed()).length > 0); },

  async save() {
    if (!draft || draft.errors.length || draft.saving) return;
    const d = draft, c = d.create;
    if (c && !c.name.trim()) { store.toast("Name the new building first.", "bad"); return; }
    set({ ...d, saving: true });
    try {
      const r = await api().savePlan(this.changed(), c ? { ...c, name: c.name.trim(), goal: c.goal.trim() } : undefined);
      clearTimeout(timer); seq++;
      set(null);
      const n = r.buildings.length;
      store.toast([n ? `${n} building${n === 1 ? "" : "s"} moved` : "", r.created ? `${r.created.name} built` : ""].filter(Boolean).join(" · ") || "Plan saved", "ok");
    } catch (e) {
      if (draft) set({ ...draft, saving: false });
      store.toast((e as Error).message, "bad");
    }
  },
};

/** Ask for a dry run of the current draft (debounced; stale answers are dropped). */
function check() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    if (!draft) return;
    const mine = ++seq, c = draft.create;
    try {
      const r = await api().previewPlan(townPlan.changed(), c ? { ...c, name: c.name.trim() || "New building" } : undefined);
      if (mine !== seq || !draft) return;
      set({ ...draft, errors: r.errors, preview: r.grid, places: r.places, previewVersion: draft.previewVersion + 1 });
    } catch (e) {
      if (mine === seq && draft) set({ ...draft, errors: [{ buildingId: null, message: (e as Error).message }] });
    }
  }, 120);
}

export function useTownPlan(): PlanDraft | null {
  return useSyncExternalStore(townPlan.subscribe, () => draft);
}

/** The Town Hall map table (E or a click): start town planning, or say why not. */
export function openTownPlanning() {
  if (api().mock) { store.toast("Town planning needs the real server.", "bad"); return; }
  if (!store.can("town.manage_buildings")) { store.toast("Town planning is for humans with town.manage_buildings: sign in as an admin to move, resize and draw buildings.", "bad"); return; }
  townPlan.start();
}
