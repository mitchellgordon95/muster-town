import { sessionTokens } from "./bank.ts";
import { homeOf } from "./domain.ts";
import { askToFileOnce } from "./explore.ts";
import type { World } from "./world.ts";

/**
 * The one per-session limit (docs/legible-delegation.md §7.3): about the largest session ever seen, in adjusted tokens.
 * It catches runaways only; long sessions are legitimate build steps, so there is no other per-session cap.
 */
export const SESSION_CIRCUIT_BREAKER = 500_000;
/** At this share of the breaker a session is told once to write its draft and pages and file (as an explorer at 90% of its chunk). */
const WARN_SHARE = 0.9;

/**
 * The runtime tick's circuit breaker: every running work or manage session whose booked adjusted tokens reach 90% of
 * SESSION_CIRCUIT_BREAKER is asked once to wrap up and file (`askToFileOnce`, the explorer's mechanism); at 100% it is
 * logged once and its agent id returned, and the runtime ends the session the way a drain cuts one (`abortWork`: the
 * session's own end books it and files the fallback report). Returns the agent ids to cut now.
 */
export function circuitBreakerTick(world: World): string[] {
  const cut: string[] = [];
  const warnAt = WARN_SHARE * SESSION_CIRCUIT_BREAKER;
  for (const s of world.sessions.where("status = 'running' AND purpose IN ('work', 'manage')")) {
    const spent = Math.round(sessionTokens(s));
    if (spent < warnAt) continue;
    const agent = world.agents.get(s.agentId);
    const buildingId = agent ? homeOf(agent) : null;
    const name = world.nameOf(s.agentId);
    const fmt = (n: number) => n.toLocaleString("en-US");
    if (spent < SESSION_CIRCUIT_BREAKER) {
      askToFileOnce(world, "circuitBreaker", s.id, s.agentId,
        `This session has used ${fmt(spent)} adjusted tokens; the town ends any session at ${fmt(SESSION_CIRCUIT_BREAKER)}. Don't start anything new: commit and push what you changed, write your draft and your wiki pages, then \`submit_report\` now (verdict continue if the work is unfinished, with what the next session needs in Findings).`,
        "The circuit breaker", { buildingId, text: `${name}'s session reached ${Math.round(WARN_SHARE * 100)}% of the session circuit breaker and was asked to file`, payload: { sessionId: s.id, assignmentId: s.assignmentId, spentTokens: spent, limitTokens: SESSION_CIRCUIT_BREAKER } });
      continue;
    }
    if (world.db.prepare("SELECT 1 FROM events WHERE type = 'system' AND json_extract(payload, '$.circuitBreakerCut') = ? LIMIT 1").get(s.id)) continue;
    world.events.append({ type: "system", agentId: s.agentId, buildingId, text: `${name}'s session reached the session circuit breaker (${fmt(spent)} of ${fmt(SESSION_CIRCUIT_BREAKER)} adjusted tokens): ended`, payload: { circuitBreakerCut: s.id, assignmentId: s.assignmentId, spentTokens: spent, limitTokens: SESSION_CIRCUIT_BREAKER } });
    cut.push(s.agentId);
  }
  return cut;
}
