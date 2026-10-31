/**
 * Bodies go home (Mitchell's flag dc_ihwq7bfi4o): an agent with a desk stands at it unless it is in a meeting, walking
 * somewhere, in a session, or talking to someone (a `say` or a `go` to another agent in the last TALK_MS). Called when a
 * meeting ends (setMeetingPhase), when a session ends (ops.endSession), and by the runtime's tick for idle bodies left
 * elsewhere. Agents without a desk (visitors, humans, the librarian) keep today's behaviour.
 */
import type { World } from "./world.ts";

/** how long a `say` or a `go` to another agent keeps a body where it is */
export const TALK_MS = 2 * 60_000;

/** Why `agentId` stays where it is, or null if it should walk to its desk. */
export function stayReason(world: World, agentId: string, now = Date.now()): string | null {
  const a = world.agents.get(agentId);
  if (!a || a.kind === "human") return "no body to move";
  if (a.status === "banned" || a.status === "retired" || a.status === "in-meeting" || a.status === "walking") return a.status;
  if (a.currentMeetingId) return "in a meeting";
  const desk = world.layout.deskOf(a.id);
  if (!desk) return "no desk";
  if (desk.pos.x === a.pos.x && desk.pos.y === a.pos.y) return "at the desk";
  if (world.movement.isWalking(a.id)) return "walking";
  if (world.sessions.count("agentId = ? AND status = 'running'", [a.id]) > 0) return "in a session";
  const from = new Date(now - TALK_MS).toISOString();
  // newest first, stopping at the window's edge: the agent's whole history used to be walked every tick
  const talked = world.events.anySince(a.id, ["agent.said", "agent.moved"], from, (e) => e.type === "agent.said" || !!e.payload.toAgentId);
  return talked ? "talking" : null;
}

/** Walk `agentId` back to its desk unless it has a reason to stay (fire and forget). True if a walk started. */
export function walkHome(world: World, agentId: string, now = Date.now()): boolean {
  if (stayReason(world, agentId, now)) return false;
  const a = world.agents.require(agentId, "agent");
  const desk = world.layout.deskOf(a.id)!;
  world.movement.go(a, desk.pos, desk.name).catch(() => undefined);
  return true;
}

/** Runtime tick: every idle resident standing away from its desk with no reason to stay walks home. Returns who left. */
export function walkIdleHome(world: World, now = Date.now()): string[] {
  const moved: string[] = [];
  for (const a of world.agents.where("kind = 'resident' AND status IN ('idle','out-of-budget')")) {
    if (walkHome(world, a.id, now)) moved.push(a.id);
  }
  return moved;
}
