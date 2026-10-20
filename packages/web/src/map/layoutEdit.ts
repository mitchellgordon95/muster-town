/**
 * "Edit layout" mode: a client-side draft of one room's furniture. Every change asks the server for a dry run
 * (its rules are final) and shows the grid it returns; Save sends the whole draft. Humans with building.manage only.
 */
import { useSyncExternalStore } from "react";
import type { Lot, Tile } from "@agent-town/schema";
import { api, type Grid, type LayoutPiece } from "../api";
import { store } from "../state";

export interface LayoutDraft {
  buildingId: string;
  name: string;
  lot: Lot;
  pieces: LayoutPiece[];
  /** lot-relative anchor per piece */
  anchors: Record<string, Tile>;
  /** anchors before each change, for Undo */
  history: Record<string, Tile>[];
  selected: string | null;
  errors: { key: string | null; message: string }[];
  /** the server's dry-run grid for the draft (null until the first answer) */
  preview: Grid | null;
  previewVersion: number;
  saving: boolean;
}

let draft: LayoutDraft | null = null;
const listeners = new Set<() => void>();
let seq = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

function set(next: LayoutDraft | null) { draft = next; for (const l of listeners) l(); }
const same = (a: Record<string, Tile>, b: Record<string, Tile>) => Object.keys(a).every((k) => a[k].x === b[k]?.x && a[k].y === b[k]?.y);

export const layoutEdit = {
  get draft() { return draft; },
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },

  async start(buildingId: string) {
    const b = store.state.buildings.find((x) => x.id === buildingId);
    const room = await api().layout(buildingId);
    if (!b || !room.lot) throw new Error("This building has no room to edit yet.");
    store.open(null);
    set({
      buildingId, name: b.name, lot: room.lot, pieces: room.pieces,
      anchors: Object.fromEntries(room.pieces.map((p) => [p.key, p.current])),
      history: [], selected: null, errors: [], preview: null, previewVersion: 0, saving: false,
    });
    check();
  },
  cancel() { clearTimeout(timer); seq++; set(null); },

  /** The piece covering an absolute tile, if any. */
  pieceAt(x: number, y: number): LayoutPiece | null {
    if (!draft) return null;
    const { lot, anchors } = draft;
    return draft.pieces.find((p) => p.cells.some((c) => lot.x + anchors[p.key].x + c.dx === x && lot.y + anchors[p.key].y + c.dy === y)) ?? null;
  },
  select(key: string | null) { if (draft) set({ ...draft, selected: key }); },

  /** Put a piece's anchor at a lot-relative tile. `record` = false while dragging (the drop records it once). */
  move(key: string, to: Tile, record = true) {
    if (!draft) return;
    const cur = draft.anchors[key];
    if (cur.x === to.x && cur.y === to.y) return;
    set({ ...draft, anchors: { ...draft.anchors, [key]: to }, history: record ? [...draft.history, draft.anchors] : draft.history });
    check();
  },
  /** After a drag: one Undo step back to where it started. */
  commitDrag(before: Record<string, Tile>) {
    if (draft && !same(before, draft.anchors)) set({ ...draft, history: [...draft.history, before] });
  },
  nudge(dx: number, dy: number) {
    if (!draft?.selected) return;
    const a = draft.anchors[draft.selected];
    this.move(draft.selected, { x: a.x + dx, y: a.y + dy });
  },
  undo() {
    if (!draft?.history.length) return;
    set({ ...draft, anchors: draft.history[draft.history.length - 1], history: draft.history.slice(0, -1) });
    check();
  },
  resetPiece() {
    const p = draft?.pieces.find((x) => x.key === draft!.selected);
    if (p) this.move(p.key, p.at);
  },
  resetRoom() {
    if (!draft) return;
    const anchors = Object.fromEntries(draft.pieces.map((p) => [p.key, p.at]));
    if (same(anchors, draft.anchors)) return;
    set({ ...draft, anchors, history: [...draft.history, draft.anchors] });
    check();
  },
  /** True when the draft differs from what the room has now. */
  dirty(): boolean { return !!draft && draft.pieces.some((p) => draft!.anchors[p.key].x !== p.current.x || draft!.anchors[p.key].y !== p.current.y); },

  async save() {
    if (!draft || draft.errors.length || draft.saving) return;
    const d = draft;
    set({ ...d, saving: true });
    try {
      await api().saveLayout(d.buildingId, d.anchors);
      clearTimeout(timer); seq++;
      set(null);
      store.toast(`${d.name} layout saved`, "ok");
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
    const mine = ++seq, { buildingId, anchors } = draft;
    try {
      const r = await api().previewLayout(buildingId, anchors);
      if (mine !== seq || !draft) return;
      set({ ...draft, errors: r.errors, preview: r.grid, previewVersion: draft.previewVersion + 1 });
    } catch (e) {
      if (mine === seq && draft) set({ ...draft, errors: [{ key: null, message: (e as Error).message }] });
    }
  }, 120);
}

export function useLayoutDraft(): LayoutDraft | null {
  return useSyncExternalStore(layoutEdit.subscribe, () => draft);
}
