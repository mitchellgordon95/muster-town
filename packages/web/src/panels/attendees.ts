/** Who a "Call meeting" form can invite, and what it sends. Mirrors the server's rules in core/meetings.ts. */
import type { Agent } from "@agent-town/schema";

const GONE = new Set<Agent["status"]>(["stopped", "banned", "retired"]);

/** Residents and visitors who can attend; `home` = this building's residents (a lab's default invitees), `others` = everyone else. */
export function inviteCandidates(agents: Agent[], buildingId: string | null): { home: Agent[]; others: Agent[] } {
  const ok = agents.filter((a) => (a.kind === "resident" || a.kind === "visitor") && !GONE.has(a.status))
    .sort((a, b) => a.name.localeCompare(b.name));
  const isHome = (a: Agent) => !!buildingId && a.kind === "resident" && a.homeBuildingId === buildingId;
  return { home: ok.filter(isHome), others: ok.filter((a) => !isHome(a)) };
}

/** The attendeeIds to send: none picked = omit, so the server invites its defaults. */
export function attendeeInput(picked: ReadonlySet<string>): { attendeeIds?: string[] } {
  return picked.size ? { attendeeIds: [...picked] } : {};
}
