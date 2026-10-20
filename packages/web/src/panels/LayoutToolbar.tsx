/** Toolbar shown while editing a room's layout (see map/layoutEdit.ts). */
import { layoutEdit, useLayoutDraft } from "../map/layoutEdit";

export function LayoutToolbar() {
  const d = useLayoutDraft();
  if (!d) return null;
  const sel = d.pieces.find((p) => p.key === d.selected);
  const dirty = layoutEdit.dirty();
  return (
    <div className="layout-bar" role="toolbar" aria-label="Edit layout">
      <div className="layout-bar-title">
        <b>Editing {d.name}</b>
        <span>{sel ? sel.label : "Click a piece, drag it; arrow keys nudge"}</span>
      </div>
      {d.errors.length ? <div className="layout-bar-errors">{d.errors.slice(0, 2).map((e, i) => <div key={i}>{e.message}</div>)}</div> : null}
      <div className="layout-bar-actions">
        <button className="btn" disabled={!d.history.length} onClick={() => layoutEdit.undo()} title="Ctrl+Z">Undo</button>
        <button className="btn" disabled={!sel} onClick={() => layoutEdit.resetPiece()}>Reset piece</button>
        <button className="btn" onClick={() => { if (confirm(`Put every piece in ${d.name} back where it started?`)) layoutEdit.resetRoom(); }}>Reset room</button>
        <button className="btn" onClick={() => layoutEdit.cancel()} title="Esc">Cancel</button>
        <button className="btn primary" disabled={!dirty || d.errors.length > 0 || d.saving} onClick={() => void layoutEdit.save()}>{d.saving ? "Saving…" : "Save"}</button>
      </div>
    </div>
  );
}
