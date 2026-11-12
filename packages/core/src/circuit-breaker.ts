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

/** A session the breaker cuts: the runtime ends it only while it is still the agent's live session. */
export interface CircuitCut { agentId: string; sessionId: string }

/**
 * The runtime tick's circuit breaker: every running work or manage session whose booked adjusted tokens reach 90% of
 * SESSION_CIRCUIT_BREAKER is asked once to wrap up (`askToFileOnce`, the explorer's mechanism), in words for its kind: a
 * work session writes its draft and files, a manage session finishes the decision in hand and ends. At 100% a work
 * session is logged once and returned, and the runtime ends it the way a drain cuts one (`abortWork` with the drain's
 * kill grace: the session's own end books it and files the fallback report). A manage session is never cut: the limit
 * came from grant-lane work sessions, a manager's turn is far below it, and a wrong cut there costs more than the tokens.
 * Returns the sessions to cut now.
 */
export function circuitBreakerTick(world: World): CircuitCut[] {
  const cut: CircuitCut[] = [];
  const warnAt = WARN_SHARE * SESSION_CIRCUIT_BREAKER;
  for (const s of world.sessions.where("status = 'running' AND purpose IN ('work', 'manage')")) {
    const spent = Math.round(sessionTokens(s));
    if (spent < warnAt) continue;
    const agent = world.agents.get(s.agentId);
    const buildingId = agent ? homeOf(agent) : null;
    const name = world.nameOf(s.agentId);
    const fmt = (n: number) => n.toLocaleString("en-US");
    const manage = s.purpose === "manage";
    if (spent < SESSION_CIRCUIT_BREAKER || manage) {
      askToFileOnce(world, "circuitBreaker", s.id, s.agentId,
        manage
          ? `This session has used ${fmt(spent)} adjusted tokens, far past a manager's usual turn. Don't start anything new: finish the decision in hand, then end the session (just stop: a team-lead session files no report).`
          : `This session has used ${fmt(spent)} adjusted tokens; the town ends any work session at ${fmt(SESSION_CIRCUIT_BREAKER)}. Don't start anything new: commit and push what you changed, write your draft and your wiki pages, then \`submit_report\` now (verdict continue if the work is unfinished, with what the next session needs in Findings).`,
        "The circuit breaker", { buildingId, text: `${name}'s ${manage ? "manage" : "work"} session reached ${Math.round(WARN_SHARE * 100)}% of the session circuit breaker and was asked to ${manage ? "finish and end" : "file"}`, payload: { sessionId: s.id, assignmentId: s.assignmentId, purpose: s.purpose, spentTokens: spent, limitTokens: SESSION_CIRCUIT_BREAKER } });
      continue;
    }
    if (world.db.prepare("SELECT 1 FROM events WHERE type = 'system' AND json_extract(payload, '$.circuitBreakerCut') = ? LIMIT 1").get(s.id)) continue;
    world.events.append({ type: "system", agentId: s.agentId, buildingId, text: `${name}'s session reached the session circuit breaker (${fmt(spent)} of ${fmt(SESSION_CIRCUIT_BREAKER)} adjusted tokens): ended`, payload: { circuitBreakerCut: s.id, assignmentId: s.assignmentId, spentTokens: spent, limitTokens: SESSION_CIRCUIT_BREAKER } });
    cut.push({ agentId: s.agentId, sessionId: s.id });
  }
  return cut;
}
