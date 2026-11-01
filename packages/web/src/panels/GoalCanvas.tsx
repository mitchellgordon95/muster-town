/**
 * The goal tree as a grab-able canvas (1:1 mt_cyd2t5ioob decision 4): a textbook tree, root at the top, children in
 * rows beneath joined by lines (layout in goalCanvas.ts). Drag the empty canvas to pan; wheel, pinch or −/+ to zoom;
 * Fit (or a double-click on empty canvas) frames the whole tree. Click a box to select it; ▾/▸ collapses its subtree.
 * Drag a box onto another to move it there (the same rule and API as the Move form, after a confirm). Arrow keys walk
 * the tree, Enter opens the selection in the detail pane. An admin (town.manage_buildings) sets an attached building's
 * desks in place with the − / + beside it (mt_cyd2t5ioob decision 5): optimistic, reverted on error; a lower count
 * only caps the next fork, running ones keep their desks.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent, type PointerEvent as RPointerEvent } from "react";
import { MAX_HEADCOUNT, ROOT_GOAL_ID, type GoalTreeNode } from "@muster-town/schema";
import { api } from "../api";
import { store } from "../state";
import { deskWord, moveTargets, nodeGlance, subtreeDesks } from "./goalTree";
import { BOX, deskTotal, fitView, layoutTree, revealBox, stepTree, zoomAt, type Placed, type View } from "./goalCanvas";
import { Act } from "./ui";

type Props = {
  root: GoalTreeNode; retired: boolean; collapsed: ReadonlySet<string>; selected: string;
  /** goals the building filter keeps bright (null: all) */
  scope: ReadonlySet<string> | null;
  proposals: Map<string, number>;
  /** centre this goal when the canvas first shows (a ?goal= deep link, the Town Hall's link) */
  focusId?: string;
  canMove: (node: GoalTreeNode) => boolean;
  onSelect: (id: string) => void; onToggle: (id: string) => void; onOpen: () => void; onMoved: () => void;
};

const today = () => new Date().toISOString().slice(0, 10);
const clip = (s: string, n = 60) => s.length > n ? `${s.slice(0, n - 1)}…` : s;
type Drag = { id: string; sx: number; sy: number; dx: number; dy: number; on: boolean; over: string | null };

export function GoalCanvas({ root, retired, collapsed, selected, scope, proposals, focusId, canMove, onSelect, onToggle, onOpen, onMoved }: Props) {
  const layout = useMemo(() => layoutTree(root, retired, collapsed), [root, retired, collapsed]);
  const byId = useMemo(() => new Map(layout.boxes.map((b) => [b.node.id, b])), [layout]);
  const vp = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [ask, setAsk] = useState<{ id: string; to: string } | null>(null);
  const pan = useRef<{ x: number; y: number } | null>(null);
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const dragged = useRef(false);
  const [desks, setDesks] = useState<ReadonlyMap<string, number>>(new Map());
  const canDesks = store.can("town.manage_buildings");
  const setHeadcount = (id: string, was: number, to: number) => {
    if (to < 1 || to > MAX_HEADCOUNT) return;
    const put = (n: number | null) => setDesks((m) => { const x = new Map(m); if (n == null) x.delete(id); else x.set(id, n); return x; });
    put(to);
    api().updateBuilding(id, { headcount: to }).catch((e: Error) => { put(was); store.toast(e.message || "Couldn't change the desks", "bad"); });
  };
  const size = () => { const r = vp.current?.getBoundingClientRect(); return { w: r?.width ?? 0, h: r?.height ?? 0, left: r?.left ?? 0, top: r?.top ?? 0 }; };
  const fit = () => { const s = size(); setView(fitView(layout, s.w, s.h)); };

  // first show: frame the whole tree, or centre the deep-linked goal at 1:1
  useLayoutEffect(() => {
    if (view || !layout.boxes.length) return;
    const s = size(), b = focusId && focusId !== ROOT_GOAL_ID ? byId.get(focusId) : null;
    setView(b ? revealBox({ x: 0, y: 0, k: 1 }, b, s.w, s.h, true) : fitView(layout, s.w, s.h));
  }, [layout]);
  // a selection made elsewhere (the keyboard, the breadcrumb, a new goal) pans into view when it is off screen
  useEffect(() => {
    const b = byId.get(selected), s = size();
    if (!b || !view) return;
    const next = revealBox(view, b, s.w, s.h);
    if (next) setView(next);
  }, [selected, layout]);
  // wheel zooms around the pointer (a touch-pad pinch arrives as a ctrl+wheel); needs a non-passive listener
  useEffect(() => {
    const el = vp.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const s = size();
      setView((v) => v && zoomAt(v, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - s.left, e.clientY - s.top));
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);

  const zoomBy = (f: number) => { const s = size(); setView((v) => v && zoomAt(v, f, s.w / 2, s.h / 2)); };
  const boxAt = (x: number, y: number) => (document.elementFromPoint(x, y)?.closest("[data-goal]") as HTMLElement | null)?.dataset.goal ?? null;
  const dropOk = (id: string, to: string | null) => !!to && moveTargets(root, id).some((r) => r.node.id === to);

  const down = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (e.pointerType === "touch") touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (t.closest("button, .gc-ask, .gc-zoom")) return;
    const id = (t.closest("[data-goal]") as HTMLElement | null)?.dataset.goal;
    vp.current?.focus({ preventScroll: true });
    dragged.current = false;
    if (id) {
      const node = byId.get(id)?.node;
      if (node && canMove(node)) setDrag({ id, sx: e.clientX, sy: e.clientY, dx: 0, dy: 0, on: false, over: null });
      return;
    }
    vp.current?.setPointerCapture(e.pointerId);
    pan.current = { x: e.clientX, y: e.clientY };
  };
  const move = (e: RPointerEvent<HTMLDivElement>) => {
    const t = touches.current;
    if (t.has(e.pointerId) && t.size === 2) {
      const [a, b] = [...t.values()], before = Math.hypot(a.x - b.x, a.y - b.y);
      t.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const [c, d] = [...t.values()], after = Math.hypot(c.x - d.x, c.y - d.y), s = size();
      if (before > 0) setView((v) => v && zoomAt(v, after / before, (c.x + d.x) / 2 - s.left, (c.y + d.y) / 2 - s.top));
      pan.current = null;
      return;
    }
    if (t.has(e.pointerId)) t.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (drag) {
      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy, on = drag.on || Math.hypot(dx, dy) > 6;
      if (on && !drag.on) { dragged.current = true; vp.current?.setPointerCapture(e.pointerId); }
      setDrag({ ...drag, dx, dy, on, over: on ? boxAt(e.clientX, e.clientY) : null });
      return;
    }
    if (!pan.current) return;
    const dx = e.clientX - pan.current.x, dy = e.clientY - pan.current.y;
    pan.current = { x: e.clientX, y: e.clientY };
    if (dx || dy) dragged.current = true;
    setView((v) => v && { ...v, x: v.x + dx, y: v.y + dy });
  };
  const up = (e: RPointerEvent<HTMLDivElement>) => {
    touches.current.delete(e.pointerId);
    pan.current = null;
    if (drag?.on && drag.over && drag.over !== drag.id && dropOk(drag.id, drag.over)) setAsk({ id: drag.id, to: drag.over });
    setDrag(null);
  };

  const key = (e: RKeyboardEvent) => {
    if ((e.target as HTMLElement) !== vp.current) return;
    if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      onSelect(stepTree(layout, selected, e.key));
    } else if (e.key === "Enter") { e.preventDefault(); onOpen(); }
    else if (e.key === "+" || e.key === "=") zoomBy(1.2);
    else if (e.key === "-") zoomBy(1 / 1.2);
    else if (e.key === "0") fit();
  };

  const now = today();
  const v = view ?? { x: 0, y: 0, k: 1 };
  const asked = ask ? { node: byId.get(ask.id)?.node, to: byId.get(ask.to)?.node } : null;
  return (
    <div ref={vp} className={`gc ${drag?.on ? "dragging" : ""}`} tabIndex={0} role="tree" aria-label="Goal tree canvas: drag to pan, wheel to zoom, arrows to walk"
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onKeyDown={key}
      onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest("[data-goal], button")) fit(); }}>
      <div className="gc-stage" style={{ transform: `translate(${v.x}px, ${v.y}px) scale(${v.k})`, width: layout.width, height: layout.height, visibility: view ? "visible" : "hidden" }}>
        <svg className="gc-lines" width={layout.width} height={layout.height} aria-hidden="true">
          {layout.edges.map((l) => <path key={l.to} d={l.d} className={scope && !scope.has(l.to) ? "dim" : ""} />)}
        </svg>
        {layout.boxes.map((b) => <Box key={b.node.id} b={b} on={b.node.id === selected} dim={!!scope && !scope.has(b.node.id)} now={now}
          proposals={proposals.get(b.node.id) ?? 0} desks={desks} onDesks={canDesks ? setHeadcount : null} drop={drag?.on && drag.over === b.node.id ? (dropOk(drag.id, b.node.id) ? "ok" : "no") : null}
          lift={drag?.on && drag.id === b.node.id ? { x: drag.dx / v.k, y: drag.dy / v.k } : null}
          onSelect={() => { if (!dragged.current) onSelect(b.node.id); }} onToggle={() => onToggle(b.node.id)} />)}
      </div>
      <div className="gc-zoom" role="toolbar" aria-label="Zoom">
        <button className="btn sm" title="Zoom out (−)" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.2)}>−</button>
        <span className="gc-pct">{Math.round(v.k * 100)}%</span>
        <button className="btn sm" title="Zoom in (+)" aria-label="Zoom in" onClick={() => zoomBy(1.2)}>+</button>
        <button className="btn sm" title="Frame the whole tree (0, or double-click empty canvas)" onClick={fit}>Fit</button>
      </div>
      {asked?.node && asked.to ? (
        <div className="gc-ask" role="alertdialog" aria-label="Move this goal?">
          <div>Move <b>{clip(asked.node.text)}</b> under <b>{clip(asked.to.text)}</b>? Its key results, goals below and attached buildings move with it.</div>
          <div className="actions">
            <button className="btn sm" onClick={() => setAsk(null)}>Cancel</button>
            <Act small tone="primary" run={() => api().updateGoal(asked.node!.id, { parentId: asked.to!.id }).then(() => { setAsk(null); onSelect(asked.node!.id); onMoved(); })}>Move</Act>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** One goal's box: its words (3 lines), the tags the outline showed, and the collapse handle under it. */
function Box({ b, on, dim, now, proposals, desks, onDesks, drop, lift, onSelect, onToggle }: { b: Placed; on: boolean; dim: boolean; now: string; proposals: number; desks: ReadonlyMap<string, number>; onDesks: ((id: string, was: number, to: number) => void) | null; drop: "ok" | "no" | null; lift: { x: number; y: number } | null; onSelect: () => void; onToggle: () => void }) {
  const { node } = b;
  const g = nodeGlance(node, now), d = { desks: deskTotal(node, desks), inUse: subtreeDesks(node).inUse }, open = !b.hidden;
  const cls = ["gc-box", on && "on", dim && "dim", node.status === "retired" && "retired", node.id === ROOT_GOAL_ID && "root", drop && `drop-${drop}`, lift && "lift"].filter(Boolean).join(" ");
  return (
    <div className={cls} data-goal={node.id} role="treeitem" aria-selected={on} aria-expanded={b.kids ? open : undefined} title={node.text}
      style={{ left: b.x, top: b.y, width: BOX.w, height: b.h, transform: lift ? `translate(${lift.x}px, ${lift.y}px) scale(.8)` : undefined }}
      onClick={onSelect}>
      <div className="gc-text">{node.text}</div>
      <div className="ge-node-meta">
        {node.status === "retired" ? <span className="ge-tag bad">retired</span> : <span className={`ge-tag desks ${d.desks ? "" : "none"}`} title={d.desks ? `${deskWord(d.desks)} work this goal (the headcount of every building attached here or below), ${d.inUse} in use now` : "No building is attached here or below: nobody works this goal"}>{deskWord(d.desks)}</span>}
        {node.ownerId ? <span className="ge-tag captain" title={`Captain: ${node.owner.name} (set on this goal; goals below inherit it)`}>👤 {node.owner.name}</span> : null}
        {g.open ? <span className="ge-tag" title={`${g.open} open key result${g.open === 1 ? "" : "s"}, ${g.funded} funded`}>{g.open} KR · {g.funded} funded</span> : null}
        {g.late ? <span className="ge-tag warn" title="Open key results past their due date">{g.late} late</span> : g.nextDue ? <span className="ge-tag" title="The nearest open due date">due {g.nextDue}</span> : null}
        {proposals ? <span className="ge-tag prop" title="Open proposals waiting for a decision here">{proposals} proposal{proposals === 1 ? "" : "s"}</span> : null}
      </div>
      {node.buildings.length ? <div className="gc-blds">
          {node.buildings.map((x) => {
            const n = desks.get(x.id) ?? x.headcount;
            const step = (to: number, label: string) => <button className="gc-step" aria-label={`${label} a desk: ${x.name}`} title={`${label === "Add" ? "Add" : "Remove"} a desk (${x.name} to ${to}); a lower count only stops new forks, running ones keep their desks`}
              disabled={to < 1 || to > MAX_HEADCOUNT} onClick={(e) => { e.stopPropagation(); onDesks!(x.id, n, to); }}>{label === "Add" ? "+" : "−"}</button>;
            return <span key={x.id} className={`ge-tag building ${onDesks ? "steps" : ""}`} title={`${x.name} is attached here: ${deskWord(n)}, ${x.inUse} in use`}>
              {onDesks ? step(n - 1, "Remove") : null}{x.name} · {n}{onDesks ? step(n + 1, "Add") : null}
            </span>;
          })}
      </div> : null}
      {b.kids ? <button className="gc-chev" aria-label={open ? "Collapse" : "Expand"} aria-expanded={open} title={open ? "Collapse the goals below" : `Show the ${b.hidden} goal${b.hidden === 1 ? "" : "s"} below`}
        onClick={(e) => { e.stopPropagation(); onToggle(); }}>{open ? "▾" : <>▸ <span className="gc-count">{b.hidden}</span></>}</button> : null}
    </div>
  );
}
