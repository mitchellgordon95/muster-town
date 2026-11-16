/**
 * Ghost visitors (Town Hall meeting mt_dm14dgejml, agenda 1, Mitchell 2026-11-16 "your proposals are fine"): a visitor
 * agent offline for GHOST_AFTER_DAYS is retired, so disconnected visitors stop lingering at the Town Hall visitor bench.
 * Pure core: agents in, ids out, the clock passed in. The presence pass (`Presence.retireGhosts`) gathers the inputs and
 * dismisses what this returns. A visitor that manages a building (it adopted a goal) is kept: it holds that building.
 */
import type { Agent } from "@muster-town/schema";

export const GHOST_AFTER_DAYS = 7;
export const GHOST_AFTER_MS = GHOST_AFTER_DAYS * 24 * 3_600_000;

type GhostCandidate = Pick<Agent, "id" | "kind" | "status" | "lastSeenAt" | "createdAt">;

/** The visitors to retire at `nowMs`: offline, quiet for GHOST_AFTER_MS or more (lastSeenAt, else createdAt), managing no building. */
export function ghostVisitors(agents: readonly GhostCandidate[], managerIds: ReadonlySet<string>, nowMs: number): string[] {
  return agents
    .filter((a) => a.kind === "visitor" && a.status === "offline" && !managerIds.has(a.id))
    .filter((a) => nowMs - Date.parse(a.lastSeenAt ?? a.createdAt) >= GHOST_AFTER_MS)
    .map((a) => a.id);
}
