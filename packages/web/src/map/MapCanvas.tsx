import { useEffect, useRef } from "react";
import { store } from "../state";
import { MapRenderer, type Target } from "./renderer";
import { layoutEdit } from "./layoutEdit";
import { openTownPlanning, townPlan, type Grab, type PlanDraft } from "./townPlan";

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
      if (townPlan.draft && !typing()) {
        // town planning: arrows nudge the selected building, Delete drops the new one, Ctrl+Z undoes, Esc cancels
        if ((e.ctrlKey || e.metaKey) && k === "z") townPlan.undo();
        else if (k === "escape") townPlan.cancel();
        else if ((k === "delete" || k === "backspace") && townPlan.draft.selected === "new") townPlan.dropNew();
        else if (NUDGE[k] && !e.ctrlKey && !e.metaKey) townPlan.nudge(...NUDGE[k]);
        else return;
        e.preventDefault(); e.stopImmediatePropagation();
        return;
      }
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
      // the Bank's town map: Esc or E puts the camera back (walking away does too)
      if (r.flow && (k === "escape" || k === "e")) { r.closeFlow(); e.preventDefault(); e.stopImmediatePropagation(); return; }
      if (MOVE_KEYS.has(k)) { r.keyDown(k); e.preventDefault(); }
      else if (k === "e" && !e.repeat) { const t = r.currentTarget; if (t) { if (t.action === "flow") r.openFlow(); else if (t.action === "plan") openTownPlanning(); else store.open(t.panel); e.preventDefault(); } }
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
  /** town planning: what's being dragged, and the draft before the drag (one Undo step) */
  const planDrag = useRef<{ grab: Grab; before: PlanDraft["history"][number] } | null>(null);
  const endPlanDrag = () => { if (planDrag.current) { townPlan.commitDrag(planDrag.current.before); planDrag.current = null; } };
  return (
    <canvas
      ref={ref}
      className="map"
      onMouseDown={(e) => {
        const plan = townPlan.draft;
        if (current && plan) {
          const t = current.tileAt(local(e).x, local(e).y);
          // a wall resizes, the inside moves, empty grass draws a new building
          const grab: Grab = townPlan.grabAt(t.x, t.y) ?? { id: "new", kind: "draw", ax: t.x, ay: t.y };
          townPlan.select(grab.id);
          planDrag.current = { grab, before: { lots: plan.lots, create: plan.create } };
          if (grab.kind === "draw") townPlan.drag(grab, t.x, t.y);
          return;
        }
        const r = current, ed = layoutEdit.draft; if (!r || !ed) return;
        const t = r.tileAt(local(e).x, local(e).y);
        const piece = layoutEdit.pieceAt(t.x, t.y);
        layoutEdit.select(piece?.key ?? null);
        if (piece) {
          const a = ed.anchors[piece.key];
          drag.current = { key: piece.key, gx: t.x - ed.lot.x - a.x, gy: t.y - ed.lot.y - a.y, before: ed.anchors };
        }
      }}
      onMouseUp={() => { endPlanDrag(); if (drag.current) { layoutEdit.commitDrag(drag.current.before); drag.current = null; } }}
      onMouseMove={(e) => {
        const r = current; if (!r) return;
        const p = local(e);
        if (townPlan.draft) {
          const t = r.tileAt(p.x, p.y);
          if (planDrag.current) townPlan.drag(planDrag.current.grab, t.x, t.y);
          const g = planDrag.current?.grab ?? townPlan.grabAt(t.x, t.y);
          ref.current!.style.cursor = !g ? "crosshair" : g.kind === "move" ? (planDrag.current ? "grabbing" : "grab") : g.kind === "draw" ? "crosshair"
            : (g.l || g.r) && (g.t || g.b) ? ((g.l && g.t) || (g.r && g.b) ? "nwse-resize" : "nesw-resize") : g.l || g.r ? "ew-resize" : "ns-resize";
          return;
        }
        const ed = layoutEdit.draft;
        if (ed) {
          const t = r.tileAt(p.x, p.y);
          if (drag.current) layoutEdit.move(drag.current.key, { x: t.x - ed.lot.x - drag.current.gx, y: t.y - ed.lot.y - drag.current.gy }, false);
          ref.current!.style.cursor = drag.current ? "grabbing" : layoutEdit.pieceAt(t.x, t.y) ? "grab" : "default";
          return;
        }
        r.hoverBlock = r.blockAt(p.x, p.y);
        const id = r.hoverBlock ? null : r.hit(p.x, p.y);
        r.hoverId = id;
        r.hoverSign = id || r.hoverBlock ? null : r.signAt(p.x, p.y);
        const table = !id && !r.hoverSign && !r.hoverBlock && (!!r.tableAt(p.x, p.y) || r.mapTableAt(p.x, p.y));
        ref.current!.style.cursor = id || r.hoverSign || r.hoverBlock || table ? "pointer" : "default";
      }}
      onMouseLeave={() => {
        if (current) { current.hoverId = null; current.hoverSign = null; current.hoverBlock = null; }
        endPlanDrag();
        if (drag.current) { layoutEdit.commitDrag(drag.current.before); drag.current = null; }
      }}
      onClick={(e) => {
        (document.activeElement as HTMLElement | null)?.blur();
        const r = current; if (!r || layoutEdit.draft || townPlan.draft) return;
        const p = local(e);
        // a red "blocked N" badge opens that agent's queue, where each row says why
        const blocked = r.blockAt(p.x, p.y);
        if (blocked?.startsWith("sched:")) { store.open({ kind: "building", id: blocked.slice(6), tab: "Overview" }); return; }
        if (blocked) { store.open({ kind: "agent", id: blocked, tab: "Assignments" }); return; }
        const id = r.hit(p.x, p.y);
        if (id) { store.open({ kind: "agent", id }); return; }
        // a building's banner opens its panel on Overview
        const sign = r.signAt(p.x, p.y);
        if (sign) { store.open({ kind: "building", id: sign, tab: "Overview" }); return; }
        // a meeting table opens its room: the building's meetings, Call a meeting, the live one
        const table = r.tableAt(p.x, p.y);
        if (table) { store.open({ kind: "meeting", id: `room:${table.buildingId ?? ""}` }); return; }
        // the Town Hall map table opens town planning
        if (r.mapTableAt(p.x, p.y)) { openTownPlanning(); return; }
        // anywhere else (a tap on a phone too): walk there, like the minimap's click; not over the Bank's town map
        if (!r.flow) { const t = r.tileAt(p.x, p.y); r.walkToTile(t.x, t.y); }
      }}
    />
  );
}
