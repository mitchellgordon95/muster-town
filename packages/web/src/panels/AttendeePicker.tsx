/** Checkbox list of who to invite to a meeting. Labs start with their residents checked; none checked = the server's defaults. */
import { useMemo, useState } from "react";
import type { SnapshotBuilding } from "@agent-town/schema";
import { useTown } from "../state";
import { inviteCandidates } from "./attendees";

export function useAttendees(building: SnapshotBuilding) {
  const agents = useTown((s) => s.agents);
  const hall = building.kind === "town-hall";
  const { home, others, unavailable } = useMemo(() => inviteCandidates(Object.values(agents), hall ? null : building.id), [agents, building.id, hall]);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(home.map((a) => a.id)));
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return { home, others, unavailable, picked, toggle, hall };
}

export function AttendeePicker({ state }: { state: ReturnType<typeof useAttendees> }) {
  const { home, others, unavailable, picked, toggle, hall } = state;
  const box = (a: { id: string; name: string }) => (
    <label key={a.id} className="check"><input type="checkbox" checked={picked.has(a.id)} onChange={() => toggle(a.id)} /> {a.name}</label>
  );
  const dflt = hall ? "managers, reviewers and moderators" : "this building's residents";
  return (
    <details className="attendees">
      <summary>Invite: {picked.size ? `${picked.size} picked` : `default (${dflt})`}</summary>
      {home.length || unavailable.length ? (
        <div className="attendee-group"><small>Residents</small>{home.map(box)}
          {unavailable.map((a) => <label key={a.id} className="check muted" title={`${a.name} is ${a.status}; resume them to invite them`}><input type="checkbox" checked={false} disabled /> {a.name} ({a.status})</label>)}
        </div>
      ) : null}
      {others.length ? <div className="attendee-group"><small>{hall ? "Agents" : "From elsewhere"}</small>{others.map(box)}</div> : null}
      <small>None checked invites the default: {dflt}.</small>
    </details>
  );
}
