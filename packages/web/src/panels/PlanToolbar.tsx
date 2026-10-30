/** Toolbar shown while looking at the whole town (see map/townPlan.ts): how the map is drawn, and Close. */
import { townPlan, useTownPlan } from "../map/townPlan";
import { store } from "../state";

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
      {sel?.lot ? <div className="plan-selected"><b>{sel.name}</b> <span className="plan-size">{sel.lot.w}×{sel.lot.h} · {sel.headcount} desk{sel.headcount === 1 ? "" : "s"}</span></div> : null}
      <div className="layout-bar-actions">
        <button className="btn" onClick={() => townPlan.cancel()} title="Esc">Close</button>
      </div>
    </div>
  );
}
