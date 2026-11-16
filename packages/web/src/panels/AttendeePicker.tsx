/** Checkbox list of who to invite to a meeting. Labs start with their residents checked; none checked = the server's defaults. */
import { useMemo } from "react";
import type { SnapshotBuilding } from "@muster-town/schema";
import { useTown } from "../state";
import { inviteCandidates } from "./attendees";
import { useDraft } from "../draft";

/** `draftKey`: the form's draft key, so the ticks survive the form closing (src/draft.ts) */
export function useAttendees(building: SnapshotBuilding, draftKey: string) {
  const agents = useTown((s) => s.agents);
  const hall = building.kind === "town-hall";
  const { home, others, unavailable } = useMemo(() => inviteCandidates(Object.values(agents), hall ? null : building.id), [agents, building.id, hall]);
  const [ids, setIds] = useDraft<string[]>(`${draftKey}:attendees`, () => home.map((a) => a.id));
  const picked = useMemo(() => new Set(ids), [ids]);
  const toggle = (id: string) => setIds((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  /** a preset's attendees: `default` = the residents checked (as on open), `none` = pick by hand */
  const reset = (to: "default" | "none") => setIds(to === "default" ? home.map((a) => a.id) : []);
  return { home, others, unavailable, picked, toggle, reset, hall };
}

export function AttendeePicker({ state }: { state: ReturnType<typeof useAttendees> }) {
  const { home, others, unavailable, picked, toggle, hall } = state;
  const box = (a: { id: string; name: string }) => (
    <label key={a.id} className="check"><input type="checkbox" checked={picked.has(a.id)} onChange={() => toggle(a.id)} /> {a.name}</label>
  );
  const dflt = hall ? "the buildings' managers" : "this building's agents";
  return (
    <details className="attendees">
      <summary>Invite: {picked.size ? `${picked.size} picked` : `default (${dflt})`}</summary>
      {home.length || unavailable.length ? (
        <div className="attendee-group"><small>This building</small>{home.map(box)}
          {unavailable.map((a) => <label key={a.id} className="check muted" title={`${a.name} is ${a.status}; resume them to invite them`}><input type="checkbox" checked={false} disabled /> {a.name} ({a.status})</label>)}
        </div>
      ) : null}
      {others.length ? <div className="attendee-group"><small>{hall ? "Agents" : "From elsewhere"}</small>{others.map(box)}</div> : null}
      <small>None checked invites the default: {dflt}.</small>
    </details>
  );
}
