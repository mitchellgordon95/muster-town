/** Dismiss (retire) a resident from its agent panel: admins only, with the confirm step inside the panel (no browser dialog). */
import { useState } from "react";
import type { Agent } from "@muster-town/schema";
import { api } from "../api";
import { store } from "../state";
import { Act } from "./ui";

/** Admins may dismiss a live resident that is not its building's manager; forks retire on their own (1:1 mt_lb7tm75jgb). */
export function canDismiss(a: Agent, managerAgentId: string | null | undefined, isAdmin: boolean): boolean {
  return isAdmin && a.kind === "resident" && !a.forkOf && a.id !== managerAgentId && a.status !== "retired" && a.status !== "banned";
}

export function DismissButton({ agent }: { agent: Agent }) {
  const [confirming, setConfirming] = useState(false);
  const [purge, setPurge] = useState(false);
  if (!confirming) return <button className="btn bad" onClick={() => setConfirming(true)}>Dismiss</button>;
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
        }}>Confirm dismiss</Act>
        <button className="btn sm" onClick={() => setConfirming(false)}>Cancel</button>
      </div>
    </div>
  );
}
