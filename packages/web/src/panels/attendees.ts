/** Who a "Call meeting" form can invite, and what it sends. Mirrors the server's rules in core/meetings.ts. */
import type { Agent } from "@agent-town/schema";

const GONE = new Set<Agent["status"]>(["stopped", "banned", "retired"]);

/**
 * Residents and visitors who can attend; `home` = this building's residents (a lab's default invitees), `others` =
 * everyone else, `unavailable` = this building's residents who can't be invited (stopped or banned), listed so the
 * picker says why they're missing instead of dropping them silently.
 */
export function inviteCandidates(agents: Agent[], buildingId: string | null): { home: Agent[]; others: Agent[]; unavailable: Agent[] } {
  const byName = (a: Agent, b: Agent) => a.name.localeCompare(b.name);
  const isHome = (a: Agent) => !!buildingId && a.kind === "resident" && a.homeBuildingId === buildingId;
  const ok = agents.filter((a) => (a.kind === "resident" || a.kind === "visitor") && !GONE.has(a.status)).sort(byName);
  const unavailable = agents.filter((a) => isHome(a) && a.status !== "retired" && GONE.has(a.status)).sort(byName);
  return { home: ok.filter(isHome), others: ok.filter((a) => !isHome(a)), unavailable };
}

/** The attendeeIds to send: none picked = omit, so the server invites its defaults. */
export function attendeeInput(picked: ReadonlySet<string>): { attendeeIds?: string[] } {
  return picked.size ? { attendeeIds: [...picked] } : {};
}
