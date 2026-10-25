/** The manager's 1:1 (docs/waterfall.md §3.4): "Talk to ★ <manager>" opens a meeting with the building's manager agent. */
import { api } from "../api";
import { store } from "../state";

/** A human who can facilitate or review in the building opens 1:1s there; others keep the direct message. */
export const canOneOnOne = (buildingId: string | null | undefined) => !!buildingId && (store.can("meeting.facilitate", buildingId) || store.can("building.review", buildingId));

/** Open (or return to) my 1:1 with the building's manager agent, in the meeting panel. */
export async function openOneOnOne(buildingId: string): Promise<void> {
  const m = await api().openOneOnOne(buildingId);
  store.putMeeting(m);
  store.open({ kind: "meeting", id: m.id });
}
