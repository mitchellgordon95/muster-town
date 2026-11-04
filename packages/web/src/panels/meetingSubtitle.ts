import type { Meeting } from "@muster-town/schema";

/** Each meeting kind in plain words for the panel header (never the slug). */
export const MEETING_KIND_WORDS: Record<Meeting["kind"], string> = {
  "standup": "Standup",
  "retro": "Retro",
  "planning": "Planning meeting",
  "town-hall": "Town hall meeting",
  "one-on-one": "1:1",
  "in-tray-review": "In-tray review",
  "ad-hoc": "Meeting",
};

/** The subtitle of a (non-1:1) meeting: "Standup · UI / UX · facilitated by Teo".
 *  The building name is left out when it is empty or repeats the kind (a town-hall meeting). */
export function meetingSubtitle(kind: Meeting["kind"], buildingName: string | null | undefined, facilitator: string): string {
  const parts = [MEETING_KIND_WORDS[kind] ?? "Meeting"];
  if (buildingName && kind !== "town-hall") parts.push(buildingName);
  parts.push(`facilitated by ${facilitator}`);
  return parts.join(" · ");
}
