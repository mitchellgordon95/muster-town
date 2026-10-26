/**
 * The guest card's "who is here now" (KR 2): the agents working at this moment, ordered so the busiest building comes
 * first (its names are what the guest camera lands on, see renderer.ts), the resting count, and humans active lately.
 * Human bodies never go offline, so a human counts as around only with activity in the last ten minutes.
 */
import type { Agent } from "@muster-town/schema";

export const HUMAN_ACTIVE_MS = 10 * 60_000;

export interface WhoIsHere { working: Agent[]; resting: number; humans: number }

export function whoIsHere(agents: Record<string, Agent>, now = Date.now()): WhoIsHere {
  const all = Object.values(agents);
  const ai = all.filter((a) => a.kind === "resident" || a.kind === "visitor");
  const working = ai.filter((a) => a.status === "working" || a.status === "in-meeting");
  const perBuilding = new Map<string | null, number>();
  for (const a of working) perBuilding.set(a.buildingId, (perBuilding.get(a.buildingId) ?? 0) + 1);
  working.sort((a, b) => (perBuilding.get(b.buildingId)! - perBuilding.get(a.buildingId)!) || a.name.localeCompare(b.name));
  const resting = ai.filter((a) => a.status === "idle" || a.status === "walking").length;
  const humans = all.filter((a) => a.kind === "human" && a.lastActiveAt && now - Date.parse(a.lastActiveAt) < HUMAN_ACTIVE_MS).length;
  return { working, resting, humans };
}
