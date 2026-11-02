/**
 * Bank grant step 5 (gr_iq5m7dug56, plan dc_2uqmfdittg; KR kr_vyrhhiyotb): unexpected out-of-tokens deaths.
 * Over a rolling 7 days, the sessions that died on the subscription cap plus the `budget.exhausted` events (definition in
 * docs/bank.md). A metric only. The learned daily cap and the hold near it were removed on 2026-11-01: a cap inferred
 * from where one session died is not a limit (one Fable-only limit was learned as an 8.7M daily cap and froze the town).
 * Availability is observed per credential instead (docs/bank.md "Promised and available").
 * Pure functions; Bank wires them to the event log.
 */
import { SPEND_LIMIT, type Event } from "@muster-town/schema";

const DEATH_WINDOW_DAYS = 7;
/** before 119bd70 the desk only echoed the SDK's cap result as a thought: "You've hit your org's monthly spend limit · resets …" */
export const CAP_THOUGHT = /^You've hit your/;

export interface DeathRow { ts: string; kind: "cap" | "exhausted"; agentId: string | null; buildingId: string | null; sessionId: string | null; text: string }
export interface BankDeaths {
  /** start of the window (now − 7 days) */
  since: string;
  /** distinct sessions that died on the subscription cap */
  capDeaths: number;
  /** `budget.exhausted` events (an agent's daily allowance or a building's budget ran out) */
  exhausted: number;
  total: number;
  /** newest first */
  events: DeathRow[];
}

/** Whether an event is a cap death, and for which session: `bank.cap`, a SPEND_LIMIT `session.ended`, or the desk's echoed cap thought. */
function capSession(e: Event): string | null | undefined {
  const sid = typeof e.payload.sessionId === "string" ? e.payload.sessionId : null;
  if (e.type === "bank.cap") return sid;
  if (e.type === "session.ended" && typeof e.payload.error === "string" && SPEND_LIMIT.test(e.payload.error)) return sid;
  if (e.type === "agent.thought" && CAP_THOUGHT.test(e.text) && SPEND_LIMIT.test(e.text)) return sid;
  return undefined;
}

/** The deaths among `events` (any order) in the 7 days before `now`: cap deaths counted once per session, every `budget.exhausted`. */
export function countDeaths(events: Event[], now: Date): BankDeaths {
  const since = new Date(now.getTime() - DEATH_WINDOW_DAYS * 86_400_000).toISOString();
  const seen = new Set<string>();
  const rows: DeathRow[] = [];
  for (const e of [...events].sort((a, b) => a.id - b.id)) {
    if (e.ts < since || e.ts > now.toISOString()) continue;
    const row = { ts: e.ts, agentId: e.agentId ?? null, buildingId: e.buildingId ?? null, text: e.text.slice(0, 300) };
    if (e.type === "budget.exhausted") { rows.push({ ...row, kind: "exhausted", sessionId: null }); continue; }
    const sid = capSession(e);
    if (sid === undefined) continue;
    // one death per session (bank.cap and session.ended both name it); a cap with no session id counts as its own
    const key = sid ?? `event:${e.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ ...row, kind: "cap", sessionId: sid });
  }
  const capDeaths = rows.filter((r) => r.kind === "cap").length;
  return { since, capDeaths, exhausted: rows.length - capDeaths, total: rows.length, events: rows.reverse() };
}
