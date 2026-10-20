/** Which meeting a meeting room shows: its live one, if any; finished meetings free the room for the next. */
import type { Meeting } from "@agent-town/schema";

export function roomMeetings(meetings: Meeting[], buildingId: string, isTownHall: boolean): { live: Meeting | null; last: Meeting | null } {
  const inRoom = meetings.filter((m) => m.buildingId === buildingId || (isTownHall && m.buildingId === null))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { live: inRoom.find((m) => m.phase !== "done" && m.phase !== "cancelled") ?? null, last: inRoom[0] ?? null };
}
