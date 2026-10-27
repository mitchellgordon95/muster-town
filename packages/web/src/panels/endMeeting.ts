import type { Meeting } from "@muster-town/schema";

/** The question to ask before "End meeting", or null to end on one click.
 *  Only a meeting still collecting summaries (not started) asks: ending it then
 *  throws the standup away (mt_h9xvyaiwdu was closed 3.4 s after it was called). */
export function endMeetingConfirm(m: Pick<Meeting, "phase" | "startedAt">): string | null {
  if (m.phase !== "collecting" || m.startedAt) return null;
  return "This meeting hasn't started yet; end it anyway? Summaries collected so far are lost.";
}
