/**
 * Ghost visitors (Town Hall meeting mt_dm14dgejml, agenda 1, Mitchell 2026-11-16 "your proposals are fine"): a visitor
 * agent offline for GHOST_AFTER_DAYS is retired, so disconnected visitors stop lingering at the Town Hall visitor bench.
 * Pure core: agents in, ids out, the clock passed in. The presence pass (`Presence.retireGhosts`) gathers the inputs and
 * dismisses what this returns. A visitor that manages a building (it adopted a goal) is kept: it holds that building.
 * A visitor holding a town role beyond `visitor` (the CI deployer, an admin's agent) is kept too: it is a service
 * account, and one that only calls REST (CI's POST /api/admin/redeploy) looked offline since it was made (dc_wxs73nuq93).
 */
import type { Agent } from "@muster-town/schema";

export const GHOST_AFTER_DAYS = 7;
export const GHOST_AFTER_MS = GHOST_AFTER_DAYS * 24 * 3_600_000;

type GhostCandidate = Pick<Agent, "id" | "kind" | "status" | "lastSeenAt" | "createdAt">;

/** Town roles every visitor agent holds; holding only these does not keep a visitor. */
const BASE_VISITOR_ROLES: ReadonlySet<string> = new Set(["role:visitor"]);

/** Whether a role id is a town role that keeps a visitor (town scope is `role:<name>`; building roles are `role:<building>:<name>`). */
export function keepsVisitor(roleId: string): boolean {
  return /^role:[^:]+$/.test(roleId) && !BASE_VISITOR_ROLES.has(roleId);
}

/**
 * The visitors to retire at `nowMs`: offline, quiet for GHOST_AFTER_MS or more (lastSeenAt, else createdAt), managing
 * no building and holding no town role beyond `visitor` (`roleHolderIds`: the agents with a role `keepsVisitor` accepts).
 */
export function ghostVisitors(agents: readonly GhostCandidate[], managerIds: ReadonlySet<string>, roleHolderIds: ReadonlySet<string>, nowMs: number): string[] {
  return agents
    .filter((a) => a.kind === "visitor" && a.status === "offline" && !managerIds.has(a.id) && !roleHolderIds.has(a.id))
    .filter((a) => nowMs - Date.parse(a.lastSeenAt ?? a.createdAt) >= GHOST_AFTER_MS)
    .map((a) => a.id);
}
