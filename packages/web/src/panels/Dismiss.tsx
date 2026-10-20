/** Dismiss (retire) a resident, with the confirm step inside the panel (no browser dialog). */
import { useState } from "react";
import type { Agent } from "@muster-town/schema";
import { api } from "../api";
import { store } from "../state";
import { Act } from "./ui";

/** Who may dismiss: building.manage (or building.dismiss) on the agent's home building; admins pass `can`. */
export function canDismiss(a: Agent): boolean {
  if (a.kind !== "resident" || a.status === "retired") return false;
  return store.can("building.manage", a.homeBuildingId) || store.can("building.dismiss", a.homeBuildingId);
}

export function DismissButton({ agent, small, onDone }: { agent: Agent; small?: boolean; onDone?: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [purge, setPurge] = useState(false);
  if (!confirming) return <button className={`btn bad ${small ? "sm" : ""}`} onClick={() => setConfirming(true)}>Dismiss</button>;
  return (
    <div className="confirm">
      <div className="confirm-text">
        Dismiss <b>{agent.name}</b>? Their session stops, the desk is freed, their assignments are cancelled. Their documents stay, credited to them.
      </div>
      <label className="check"><input type="checkbox" checked={purge} onChange={(e) => setPurge(e.target.checked)} /> Also delete their desk's home volume</label>
      <div className="actions">
        <Act small tone="bad" run={async () => {
          await api().dismiss(agent.id, purge);
          store.toast(`${agent.name} was dismissed`, "ok");
          setConfirming(false);
          onDone?.();
        }}>Confirm dismiss</Act>
        <button className="btn sm" onClick={() => setConfirming(false)}>Cancel</button>
      </div>
    </div>
  );
}
