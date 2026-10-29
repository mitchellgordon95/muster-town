/** Toolbar shown while planning the town (see map/townPlan.ts): hints, the server's objections, the new building's form. */
import { townPlan, useTownPlan } from "../map/townPlan";
import { store } from "../state";

/** `inset` = the side bar's width: the toolbar centres on the map left of it. */
export function PlanToolbar({ inset = 0 }: { inset?: number }) {
  const d = useTownPlan();
  if (!d) return null;
  const c = d.create;
  const moved = Object.keys(townPlan.changed()).length;
  const dirty = townPlan.dirty();
  const sel = d.selected, lot = sel ? townPlan.lotOf(sel) : null, desks = sel ? townPlan.desksOf(sel) : null;
  const selName = sel === "new" ? null : store.state.buildings.find((b) => b.id === sel)?.name;
  /** The drafted size and the desks it gives, read-only: desks follow floor space (one per 26 tiles inside the walls). */
  const size = lot && desks != null ? <span className="plan-size" title="Desks follow the floor space: one per 26 tiles inside the walls, never below the desks in use. Resize the building to change them.">{lot.w}×{lot.h} · {desks} desk{desks === 1 ? "" : "s"}</span> : null;
  return (
    <div className="layout-bar" role="toolbar" aria-label="Plan the town" style={inset ? { left: `calc((100% - ${inset}px) / 2)`, maxWidth: `min(640px, calc(100% - ${inset}px - 24px))` } : undefined}>
      <div className="layout-bar-title">
        <b>Planning the town</b>
        <span>Drag a building anywhere on the grass to move it, its walls to resize it, empty grass to draw a new one; roads route themselves; arrows nudge</span>
      </div>
      {c ? (
        <div className="plan-form">
          <input className="grow" aria-label="New building name" placeholder="New building name" value={c.name} onChange={(e) => townPlan.setNew({ name: e.target.value })} />
          <input className="grow" aria-label="Goal" placeholder="Goal (optional)" value={c.goal} onChange={(e) => townPlan.setNew({ goal: e.target.value })} />
          {sel === "new" ? size : null}
          <button className="btn" onClick={() => townPlan.dropNew()} title="Delete">Remove</button>
        </div>
      ) : null}
      {sel && sel !== "new" && selName ? <div className="plan-selected"><b>{selName}</b> {size}</div> : null}
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
