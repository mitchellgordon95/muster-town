/**
 * Bank grant step 5 (gr_iq5m7dug56, plan dc_2uqmfdittg; KR kr_vyrhhiyotb): unexpected out-of-tokens deaths and the cap hold.
 * - Deaths: over a rolling 7 days, the sessions that died on the subscription cap plus the `budget.exhausted` events.
 *   The Bank warns before neither, so each one is a death it did not predict (definition in docs/bank.md).
 * - Hold: the `bank.cap` events say at what adjusted spend the subscription was capped each day. The learned daily cap is
 *   the median over the last 14 days of each day's lowest; when today's subscription spend is within one typical session
 *   of it, new subscription starts are held (unless a fallback input can take them) instead of starting to die.
 * Pure functions; Bank wires them to the event log and the sessions.
 */
import { SPEND_LIMIT, type Event } from "@muster-town/schema";
import { stamp } from "./time.ts";

const DEATH_WINDOW_DAYS = 7;
/** days of `bank.cap` events the learned cap looks back over */
const CAP_LOOKBACK_DAYS = 14;
/** ended sessions the typical session size is the median of */
export const TYPICAL_SESSIONS = 50;
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

export const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/** One `bank.cap` event's facts: its UTC day and the subscription's adjusted spend when it hit. */
interface CapPoint { day: string; subscriptionAdjustedToday: number }

/** The learned daily cap: per UTC day the lowest spend a cap hit at, then the median over the last 14 days up to `today`; null with no cap seen. */
export function learnedCap(points: CapPoint[], today: string): { cap: number; days: number } | null {
  const from = new Date(Date.parse(today) - (CAP_LOOKBACK_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
  const byDay = new Map<string, number>();
  for (const p of points) {
    if (p.day < from || p.day > today || !(p.subscriptionAdjustedToday > 0)) continue;
    byDay.set(p.day, Math.min(byDay.get(p.day) ?? Infinity, p.subscriptionAdjustedToday));
  }
  const cap = median([...byDay.values()]);
  return cap === null ? null : { cap, days: byDay.size };
}

/** Whether to hold new subscription starts: spend within one typical session of the cap (no cap or no typical size = no hold). */
export function nearCap(spentToday: number, cap: number | null, typical: number | null): boolean {
  return cap !== null && spentToday >= cap - (typical ?? 0);
}

/** The hold's reason, as shown on held assignments and the map. */
export function capReason(spentToday: number, cap: number, resetsAt: string): string {
  const m = (n: number) => `${(n / 1e6).toFixed(1)}M`;
  return `near the subscription cap (${m(spentToday)} of ~${m(cap)} adj. tokens today), resets at ${stamp(resetsAt)}`;
}
