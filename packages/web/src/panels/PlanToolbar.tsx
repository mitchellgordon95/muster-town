/** Toolbar shown while looking at the whole town (see map/townPlan.ts): how the map is drawn, its shape, and Close. */
import { useState } from "react";
import type { GoalTreeNode, MapLayout } from "@muster-town/schema";
import { api } from "../api";
import { townPlan, useTownPlan } from "../map/townPlan";
import { store, useTown } from "../state";
import { useGoalTree } from "./GoalPicker";

/** The three shapes of the map (1:1 mt_q10xf3bkoq; mocks dc_fvgi5nq36j), in the picker's order. */
const SHAPES: { id: MapLayout; label: string; hint: string }[] = [
  { id: "fountain", label: "Town square", hint: "the Town Hall and the Bank on a square with a fountain; each first-level goal a district on its own street off the main street" },
  { id: "tree", label: "Plain tree", hint: "a street per goal, packed: the goal tree as a diagram" },
  { id: "radial", label: "Radial", hint: "the Town Hall in the middle, each first-level goal a spoke" },
];

const ownsAny = (n: GoalTreeNode, userId: string): boolean => n.ownerId === userId || n.children.some((c) => ownsAny(c, userId));

/** `inset` = the side bar's width: the toolbar centres on the map left of it. */
export function PlanToolbar({ inset = 0 }: { inset?: number }) {
  const d = useTownPlan();
  if (!d) return null;
  const sel = d.selected ? store.state.buildings.find((b) => b.id === d.selected) : null;
  return (
    <div className="layout-bar" role="toolbar" aria-label="The town map" style={inset ? { left: `calc((100% - ${inset}px) / 2)`, maxWidth: `min(640px, calc(100% - ${inset}px - 24px))` } : undefined}>
      <div className="layout-bar-title">
        <b>The town map</b>
        <span>Drawn from the goal tree: each goal is a plaza, each building stands at its goal. Click one; change its goal or desks in Settings.</span>
      </div>
      <ShapePicker />
      {sel?.lot ? <div className="plan-selected"><b>{sel.name}</b> <span className="plan-size">{sel.lot.w}×{sel.lot.h} · {sel.headcount} desk{sel.headcount === 1 ? "" : "s"}</span></div> : null}
      <div className="layout-bar-actions">
        <button className="btn" onClick={() => townPlan.cancel()} title="Esc">Close</button>
      </div>
    </div>
  );
}

/** The map's shape: town-wide, so an admin or a goal captain picks it and everyone sees it (server: World.canSetMapLayout). */
function ShapePicker() {
  const shape = useTown((s) => s.town?.mapLayout ?? "fountain");
  const me = useTown((s) => s.me);
  const root = useGoalTree();
  const [busy, setBusy] = useState(false);
  const canPick = store.can("goals.edit") || (!!me && !!root && ownsAny(root, me.user.id));
  const pick = (layout: MapLayout) => {
    if (layout === shape || busy) return;
    setBusy(true);
    api().setMapLayout(layout).then(() => store.onLayoutChanged?.(), (e: Error) => store.toast(e.message, "bad")).finally(() => setBusy(false));
  };
  return (
    <div className="plan-shape" role="radiogroup" aria-label="The map's shape">
      <span className="muted">Shape</span>
      {SHAPES.map((s) => (
        <button key={s.id} role="radio" aria-checked={s.id === shape} className={`btn${s.id === shape ? " on" : ""}`} disabled={!canPick || busy} title={canPick ? `${s.label}: ${s.hint}. Changes the map for everyone.` : `${s.label}: ${s.hint}. An admin or a goal captain picks the shape.`} onClick={() => pick(s.id)}>
          {s.label}
        </button>
      ))}
    </div>
  );
}
