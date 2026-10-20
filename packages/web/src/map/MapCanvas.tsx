import { useEffect, useRef } from "react";
import { store } from "../state";
import { MapRenderer, type Target } from "./renderer";
import { layoutEdit } from "./layoutEdit";

const NUDGE: Record<string, [number, number]> = { arrowup: [0, -1], w: [0, -1], arrowdown: [0, 1], s: [0, 1], arrowleft: [-1, 0], a: [-1, 0], arrowright: [1, 0], d: [1, 0] };

const MOVE_KEYS = new Set(["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"]);

export function typing(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.tagName === "SELECT" || el.isContentEditable);
}

let current: MapRenderer | null = null;
export const mapRenderer = () => current;

export function MapCanvas(props: { panelInset: number; onTarget: (t: Target | null) => void; onMove: (x: number, y: number) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const cbs = useRef(props);
  cbs.current = props;

  useEffect(() => {
    const r = new MapRenderer(ref.current!);
    current = r;
    store.walkTo = (placeId, panel) => r.walkToPlace(placeId, panel);
    r.onTarget = (t) => cbs.current.onTarget(t);
    r.onMove = (x, y) => cbs.current.onMove(x, y);
    const down = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (layoutEdit.draft && !typing()) {
        // edit layout: arrows nudge the selected piece, Ctrl+Z undoes, Esc throws the draft away
        if ((e.ctrlKey || e.metaKey) && k === "z") layoutEdit.undo();
        else if (k === "escape") layoutEdit.cancel();
        else if (NUDGE[k] && !e.ctrlKey && !e.metaKey) layoutEdit.nudge(...NUDGE[k]);
        else return;
        e.preventDefault(); e.stopImmediatePropagation();
        return;
      }
      if (typing() || e.metaKey || e.ctrlKey || e.altKey) return;
      if (MOVE_KEYS.has(k)) { r.keyDown(k); e.preventDefault(); }
      else if (k === "e" && !e.repeat) { const t = r.currentTarget; if (t) { store.open(t.panel); e.preventDefault(); } }
      else if (k === "tab" && r.cycleTarget(e.shiftKey ? -1 : 1)) e.preventDefault();
      else if (k === "-" || k === "_") r.zoom = Math.max(2, r.zoom - 1);
      else if (k === "=" || k === "+") r.zoom = Math.min(5, r.zoom + 1);
    };
    const up = (e: KeyboardEvent) => r.keyUp(e.key.toLowerCase());
    const blur = () => r.clearKeys();
    const focusin = () => { if (typing()) r.clearKeys(); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    document.addEventListener("focusin", focusin);
    return () => {
      r.destroy(); current = null;
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
      document.removeEventListener("focusin", focusin);
    };
  }, []);

  useEffect(() => { if (current) current.panelInset = props.panelInset; }, [props.panelInset]);

  const local = (e: React.MouseEvent) => {
    const b = ref.current!.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  };
  /** the piece being dragged: which, where it was grabbed (tiles from its anchor), the draft before the drag */
  const drag = useRef<{ key: string; gx: number; gy: number; before: Record<string, { x: number; y: number }> } | null>(null);
  return (
    <canvas
      ref={ref}
      className="map"
      onMouseDown={(e) => {
        const r = current, ed = layoutEdit.draft; if (!r || !ed) return;
        const t = r.tileAt(local(e).x, local(e).y);
        const piece = layoutEdit.pieceAt(t.x, t.y);
        layoutEdit.select(piece?.key ?? null);
        if (piece) {
          const a = ed.anchors[piece.key];
          drag.current = { key: piece.key, gx: t.x - ed.lot.x - a.x, gy: t.y - ed.lot.y - a.y, before: ed.anchors };
        }
      }}
      onMouseUp={() => { if (drag.current) { layoutEdit.commitDrag(drag.current.before); drag.current = null; } }}
      onMouseMove={(e) => {
        const r = current; if (!r) return;
        const p = local(e);
        const ed = layoutEdit.draft;
        if (ed) {
          const t = r.tileAt(p.x, p.y);
          if (drag.current) layoutEdit.move(drag.current.key, { x: t.x - ed.lot.x - drag.current.gx, y: t.y - ed.lot.y - drag.current.gy }, false);
          ref.current!.style.cursor = drag.current ? "grabbing" : layoutEdit.pieceAt(t.x, t.y) ? "grab" : "default";
          return;
        }
        const id = r.hit(p.x, p.y);
        r.hoverId = id;
        ref.current!.style.cursor = id ? "pointer" : "default";
      }}
      onMouseLeave={() => {
        if (current) current.hoverId = null;
        if (drag.current) { layoutEdit.commitDrag(drag.current.before); drag.current = null; }
      }}
      onClick={(e) => {
        (document.activeElement as HTMLElement | null)?.blur();
        const r = current; if (!r || layoutEdit.draft) return;
        const p = local(e);
        const id = r.hit(p.x, p.y);
        if (id) store.open({ kind: "agent", id });
      }}
    />
  );
}
