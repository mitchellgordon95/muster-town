/** Redeploy status for the HUD and the map: the latest redeploy `system` event carries the whole run (`payload.run`). */
import type { Event, RedeployRun } from "@muster-town/schema";

export interface RedeployStatus extends RedeployRun { at: number; eventId: number; text: string }

/** How long a finished (or failed) redeploy stays on the HUD. */
export const SHOW_FINISHED_MS = 10 * 60_000;

let memo: { events: Event[]; status: RedeployStatus | null } | null = null;

/** The latest redeploy's status, or null when none is recent. Memoised on the events array (the renderer calls it every frame). */
export function redeployStatus(events: Event[], now = Date.now()): RedeployStatus | null {
  if (memo?.events !== events) {
    let status: RedeployStatus | null = null;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      const run = e.type === "system" ? (e.payload as { redeploy?: boolean; run?: RedeployRun }).run : undefined;
      if (run && (e.payload as { redeploy?: boolean }).redeploy) { status = { ...run, at: Date.parse(e.ts), eventId: e.id, text: e.text }; break; }
    }
    memo = { events, status };
  }
  const s = memo.status;
  if (s && (s.state === "done" || s.state === "failed") && now - s.at > SHOW_FINISHED_MS) return null;
  return s;
}

/** Agent ids whose work a draining redeploy is holding (badged on the map). */
export function blockedByRedeploy(events: Event[]): Set<string> {
  const s = redeployStatus(events);
  return new Set(s?.state === "scheduled" ? s.blocked : []);
}

const changes = (n: number | null) => n === null ? "" : `${n} change${n === 1 ? "" : "s"}`;

/** One line for the HUD. */
export function redeployLine(s: RedeployStatus, name: (id: string) => string): string {
  const c = changes(s.commits);
  switch (s.state) {
    case "running": return `Redeploying${s.requestedBy ? ` (by ${s.requestedBy})` : ""}: pulling and building${c ? `, ${c} waiting` : ""}…`;
    case "scheduled": return `Redeploy scheduled: ${c || "changes"} waiting; restarts when ${s.working.length === 1 ? "1 session finishes" : `${s.working.length} sessions finish`} (${s.working.map(name).join(", ")})${s.blocked.length ? `; ${s.blocked.map(name).join(", ")} wait${s.blocked.length === 1 ? "s" : ""} for it` : ""}`;
    case "restarting": return `Redeploy: restarting the server${c ? ` with ${c}` : ""}…`;
    case "done": return `Redeploy finished${c ? `: ${c} live` : ""}`;
    case "failed": return s.text;
  }
}
