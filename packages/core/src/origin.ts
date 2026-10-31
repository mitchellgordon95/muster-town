/**
 * Wakes step 1 (docs/wakes.md §2 "Human origin"): who a chain of work traces to. The town stamps an origin when a human
 * acts, sessions inherit it, and `tell` / `assign` / @mentions pass it on with one more hop. Agents never set it.
 */
import type { Agent, Meeting, Origin } from "@muster-town/schema";
import { meetingHadHuman } from "./lanes.ts";
import { nowIso } from "./util.ts";
import type { World } from "./world.ts";

/** A human's own act (hops 0). */
export function humanOrigin(userId: string, via: string | null, at = nowIso()): Origin {
  return { userId, via, hops: 0, at };
}

/** A meeting a human took part in: the 1:1's human, else the last human who spoke, via the meeting; null if none did. */
export function meetingOrigin(m: Meeting): Origin | null {
  if (!meetingHadHuman(m)) return null;
  const last = [...m.transcript].reverse().find((u) => u.speakerKind === "user");
  const userId = m.withUserId ?? last?.speakerId;
  return userId ? humanOrigin(userId, m.id, last?.at ?? m.createdAt) : null;
}

/** The origin of the agent's acting session: its most recently started running session (null = none or no origin). */
function sessionOrigin(world: World, agentId: string): Origin | null {
  return world.sessions.first("agentId = ? AND status = 'running'", [agentId], "ORDER BY startedAt DESC, rowid DESC")?.origin ?? null;
}

/**
 * The origin an act by `me` carries: a human's avatar stamps a fresh one (via `via`); an agent passes on its acting
 * session's origin with one more hop; null when there is none.
 */
export function actOrigin(world: World, me: Agent, via: string | null): Origin | null {
  if (me.kind === "human") return me.ownerUserId ? humanOrigin(me.ownerUserId, via) : null;
  const o = sessionOrigin(world, me.id);
  return o ? { ...o, hops: o.hops + 1 } : null;
}
