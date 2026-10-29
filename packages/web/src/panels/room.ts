/** Which meeting a meeting room shows: its live one, if any; finished meetings free the room for the next. The room (its table on the map) is also where a building's meetings are listed and called. */
import type { Meeting } from "@muster-town/schema";
import type { PanelRef } from "../state";

const inBuilding = (m: Meeting, buildingId: string, isTownHall: boolean) => m.buildingId === buildingId || (isTownHall && m.buildingId === null);
const newestFirst = (a: Meeting, b: Meeting) => b.createdAt.localeCompare(a.createdAt);
const finished = (m: Meeting) => m.phase === "done" || m.phase === "cancelled";

export function roomMeetings(meetings: Meeting[], buildingId: string, isTownHall: boolean): { live: Meeting | null; last: Meeting | null } {
  // a 1:1 happens at the manager's desk, not in the room
  const inRoom = meetings.filter((m) => m.kind !== "one-on-one").filter((m) => inBuilding(m, buildingId, isTownHall)).sort(newestFirst);
  return { live: inRoom.find((m) => !finished(m)) ?? null, last: inRoom[0] ?? null };
}

/** Every meeting of a building (1:1s included), split into upcoming (not finished) and past, newest first. */
export function buildingMeetings(meetings: Meeting[], buildingId: string, isTownHall: boolean): { upcoming: Meeting[]; past: Meeting[] } {
  const all = meetings.filter((m) => inBuilding(m, buildingId, isTownHall)).sort(newestFirst);
  return { upcoming: all.filter((m) => !finished(m)), past: all.filter(finished) };
}

/** The building panel's Meetings tab is gone (Mitchell, 1:1 mt_auczm6f1j1): a link into it opens the building's meeting room. */
export function redirectPanel(p: PanelRef | null): PanelRef | null {
  if (p?.kind === "admin") return { ...p, kind: "planning" };
  if (p?.kind === "building" && p.id && p.tab === "Meetings") return { kind: "meeting", id: `room:${p.id}` };
  return p;
}

export function phaseTone(p: Meeting["phase"]) { return p === "collecting" ? "warn" : p === "discussing" ? "ok" : p === "done" ? "" : p === "cancelled" ? "bad" : "info"; }
