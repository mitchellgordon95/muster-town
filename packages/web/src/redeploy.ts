/**
 * Redeploy status for the HUD and the map: the latest redeploy `system` event carries the whole run (`payload.run`);
 * a run is over once an event with `payload.terminal` (or a terminal run state) follows it. `GET /api/admin/redeploy`
 * (the runtime's live view, refetched on each redeploy event) overrides a banner the events say is still in flight.
 */
import type { Event, RedeployLive, RedeployRun } from "@muster-town/schema";

export interface RedeployStatus extends RedeployRun { at: number; eventId: number; text: string }

/** How long a finished (or failed, or interrupted) redeploy stays on the HUD. */
export const SHOW_FINISHED_MS = 10 * 60_000;

const FINISHED = new Set<RedeployRun["state"]>(["done", "failed", "aborted"]);

let memo: { events: Event[]; status: RedeployStatus | null } | null = null;

/** The latest redeploy's status from the events alone, or null when none is recent. Memoised on the events array (the renderer calls it every frame). */
export function redeployStatus(events: Event[], now = Date.now()): RedeployStatus | null {
  if (memo?.events !== events) {
    let status: RedeployStatus | null = null;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type !== "system") continue;
      const p = e.payload as { redeploy?: boolean; run?: RedeployRun; terminal?: boolean; ok?: boolean; aborted?: boolean };
      if (!p.redeploy) continue;
      const base = { at: Date.parse(e.ts), eventId: e.id, text: e.text };
      if (p.run) {
        // an interrupted run's terminal event may carry the old run: the flag decides
        const state: RedeployRun["state"] = p.terminal && p.aborted ? "aborted" : p.run.state;
        status = { ...p.run, state, ...(FINISHED.has(state) ? { working: [], blocked: [] } : {}), ...base };
        break;
      }
      if (p.terminal) {
        status = { state: p.aborted ? "aborted" : p.ok ? "done" : "failed", requestedBy: "", commits: null, working: [], blocked: [], ...base };
        break;
      }
    }
    memo = { events, status };
  }
  const s = memo.status;
  if (s && FINISHED.has(s.state) && now - s.at > SHOW_FINISHED_MS) return null;
  return s;
}

/** The runtime's live view, tagged with the latest redeploy event id it was fetched after. */
export interface RedeployLiveAt { live: RedeployLive; afterEventId: number }

/**
 * The banner's status: the events', checked against the runtime's live view when that was fetched after the latest
 * redeploy event. Live says nothing runs while the events say running/draining: the run died without a terminal event.
 */
export function effectiveRedeploy(events: Event[], live: RedeployLiveAt | null, now = Date.now()): RedeployStatus | null {
  const s = redeployStatus(events, now);
  if (!s || !live || live.afterEventId < s.eventId) return s;
  if (!live.live.running && (s.state === "running" || s.state === "scheduled")) return { ...s, state: "aborted", working: [], blocked: [] };
  return s;
}

/** Agent ids whose work a draining redeploy is holding (badged on the map). */
export function blockedByRedeploy(events: Event[]): Set<string> {
  const s = redeployStatus(events);
  return new Set(s?.state === "scheduled" ? s.blocked : []);
}

const changes = (n: number | null) => n === null ? "" : `${n} change${n === 1 ? "" : "s"}`;

/** One line for the HUD. `waitingFor` (names, from the live view) replaces the event's list while draining. */
export function redeployLine(s: RedeployStatus, name: (id: string) => string, waitingFor?: string[]): string {
  const c = changes(s.commits);
  switch (s.state) {
    case "running": return `Redeploying${s.requestedBy ? ` (by ${s.requestedBy})` : ""}: pulling and building${c ? `, ${c} waiting` : ""}…`;
    case "scheduled": {
      const w = waitingFor ?? s.working.map(name);
      return `Redeploy scheduled: ${c || "changes"} waiting; restarts when ${w.length === 1 ? "1 session finishes" : `${w.length} sessions finish`} (${w.join(", ")})${s.blocked.length ? `; ${s.blocked.map(name).join(", ")} wait${s.blocked.length === 1 ? "s" : ""} for it` : ""}`;
    }
    case "restarting": return `Redeploy: restarting the server${c ? ` with ${c}` : ""}…`;
    case "done": return `Redeploy finished${c ? `: ${c} live` : ""}`;
    case "failed": return s.text;
    case "aborted": return "Redeploy interrupted by a restart; nothing is waiting.";
  }
}

/** The tone of the HUD notice. */
export function redeployTone(s: RedeployStatus): "ok" | "bad" | "warn" {
  return s.state === "done" ? "ok" : s.state === "failed" ? "bad" : "warn";
}

/** Whether every session slot is taken: the latest `alert: slots-full|slots-free` event, else the snapshot's `health.slots`. */
export function slotsFull(events: Event[], health: { slots?: { running: number; max: number } } | null): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const a = (events[i].payload as { alert?: unknown }).alert;
    if (events[i].type === "system" && (a === "slots-full" || a === "slots-free")) return a === "slots-full";
  }
  return !!health?.slots && health.slots.running >= health.slots.max;
}

/** Whether docker is down: the latest `alert: docker-down|docker-up` event, else the snapshot's `health.docker`. */
export function dockerDown(events: Event[], health: { docker: boolean } | null): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const a = (events[i].payload as { alert?: unknown }).alert;
    if (events[i].type === "system" && (a === "docker-down" || a === "docker-up")) return a === "docker-down";
  }
  return health ? !health.docker : false;
}

/** System events the Bank raises about credentials (post-mortem 2026-10-30): an old desk's in-session failover, a desk claiming a funding it was not handed, a day's spend the Bank can't explain. */
const FUNDING_ALERTS = new Set(["funding-failover", "funding-mismatch", "funding-reconcile"]);

/** The latest funding alert of the last day (`alert: funding-failover | funding-mismatch | funding-reconcile`), or null. */
export function fundingAlert(events: Event[], now = Date.now()): Event | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== "system" || !FUNDING_ALERTS.has(String((e.payload as { alert?: unknown }).alert))) continue;
    return now - Date.parse(e.ts) < 24 * 3600_000 ? e : null;
  }
  return null;
}
