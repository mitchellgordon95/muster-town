/** Toolbar shown while planning the town (see map/townPlan.ts): hints, the server's objections, the new building's form. */
import type { Building } from "@muster-town/schema";
import { townPlan, useTownPlan } from "../map/townPlan";

export function PlanToolbar() {
  const d = useTownPlan();
  if (!d) return null;
  const c = d.create;
  const moved = Object.keys(townPlan.changed()).length;
  const dirty = townPlan.dirty();
  return (
    <div className="layout-bar" role="toolbar" aria-label="Plan the town">
      <div className="layout-bar-title">
        <b>Planning the town</b>
        <span>Drag a building to move it, its walls to resize it, empty grass to draw a new one; arrows nudge</span>
      </div>
      {c ? (
        <div className="plan-form">
          <input className="grow" aria-label="New building name" placeholder="New building name" value={c.name} onChange={(e) => townPlan.setNew({ name: e.target.value })} />
          <input className="grow" aria-label="Goal" placeholder="Goal (optional)" value={c.goal} onChange={(e) => townPlan.setNew({ goal: e.target.value })} />
          <label>Desks <input type="number" min={1} max={24} style={{ width: 52 }} value={c.headcount} onChange={(e) => townPlan.setNew({ headcount: Math.max(1, +e.target.value || 1) })} /></label>
          <select aria-label="Review policy" value={c.reviewPolicy} onChange={(e) => townPlan.setNew({ reviewPolicy: e.target.value as Building["reviewPolicy"] })}>
            <option value="human">review: human</option><option value="reviewer">review: reviewer</option><option value="auto">review: auto</option>
          </select>
          <button className="btn" onClick={() => townPlan.dropNew()} title="Delete">Remove</button>
        </div>
      ) : null}
      {d.errors.length ? <div className="layout-bar-errors">{d.errors.slice(0, 3).map((e, i) => <div key={i}>{e.message}</div>)}</div> : null}
      <div className="layout-bar-actions">
        <button className="btn" disabled={!d.history.length} onClick={() => townPlan.undo()} title="Ctrl+Z">Undo</button>
        <button className="btn" onClick={() => townPlan.cancel()} title="Esc">Cancel</button>
        <button className="btn primary" disabled={!dirty || d.errors.length > 0 || d.saving || (!!c && !c.name.trim())} onClick={() => void townPlan.save()}>
          {d.saving ? "Saving…" : c ? (moved ? `Save and build ${c.name.trim() || "it"}` : `Build ${c.name.trim() || "it"}`) : "Save"}
        </button>
      </div>
    </div>
  );
}
