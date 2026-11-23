import type { Assignment, Session, TokenCounts } from "@muster-town/schema";
import { sessionTokens } from "./bank.ts";
import { cents, sessionListUsd } from "./finance.ts";
import { laneKindRow } from "./finance-lane-kind.ts";

/**
 * GET /api/finance `split` and the daily rows' `byLane` (gr_3ougmyubdm step 1, kr_6fwxvjormh, kr_sw61dw3a04): what share
 * of session spend bought goal work and what share went to managers (and the Secretary) coordinating it. Read-only over
 * the sessions table, with each session booked as the Bank books it (`sessionTokens`, adjusted tokens; $ at API list price).
 *
 * Lane rule: `laneKindRow` (finance-lane-kind.ts), the same as the Spending tab's lane × kind table. Groups:
 * work = grant + exploration + directed + retainer; coordination = manager (purpose `manage`: managers' and the
 * Secretary's team-lead wakes); other = every other purpose (review, facilitate, summary, meeting-reply, naming,
 * estimate) and a work session with no lane.
 *
 * Days: a session counts wholly on the UTC day it ended (or started, while running). A window of N days = today so far
 * and the N−1 full UTC days before it, so the 30-day window is exactly the Balance chart's 30 rows and the 7-day window
 * its last 7.
 */
export const SPLIT_LANES = ["grant", "exploration", "directed", "retainer", "manager", "other"] as const;
export type SplitLane = (typeof SPLIT_LANES)[number];
export const SPLIT_GROUPS = { work: ["grant", "exploration", "directed", "retainer"], coordination: ["manager"], other: ["other"] } as const satisfies Record<string, readonly SplitLane[]>;

interface SplitPart { tokens: number; usd: number; sessions: number; /** tokens / the window's total, 0..1 (4 decimals) */ share: number }
export interface SplitWindow {
  days: number;
  /** first and last UTC day, YYYY-MM-DD */
  from: string;
  to: string;
  total: { tokens: number; usd: number; sessions: number };
  work: SplitPart;
  coordination: SplitPart;
  other: SplitPart;
  /** the six lanes the groups are made of */
  byLane: Record<SplitLane, SplitPart>;
}
export interface FinanceSplit {
  d7: SplitWindow;
  d30: SplitWindow;
  /** which lanes make each group */
  groups: typeof SPLIT_GROUPS;
  /**
   * Per window: work + coordination + other = Σ the window's sessions (each session once), and the total = Σ the
   * matching daily rows' sessionsTokens. ok within rounding (half a token per row or session).
   */
  check: { ok: boolean; diff: number; dailyDiff: number; identity: string };
}

/** One UTC day of session spend by lane (rounded), for the Balance chart's two-tone bars. */
export interface DayLanes { byLane: Record<SplitLane, number>; sessionsTokens: number }

type SplitSession = Pick<Session, "assignmentId" | "purpose" | "lane" | "model" | "bankModel" | "byModel" | "startedAt" | "endedAt"> & Partial<TokenCounts>;
interface FinanceSplitInputs {
  sessions: SplitSession[];
  assignments: Pick<Assignment, "id" | "lane">[];
}

const DAY = 86_400_000;
const IDENTITY = "work + coordination + other = Σ sessions in the window = Σ the window's daily rows (sessionsTokens)";
const dayOf = (t: number): string => new Date(t).toISOString().slice(0, 10);
const zeroLanes = (): Record<SplitLane, number> => ({ grant: 0, exploration: 0, directed: 0, retainer: 0, manager: 0, other: 0 });

/** The pure aggregation behind `split` and each daily row's `byLane` (`days` = the chart's window, 30). */
export function financeSplit(inp: FinanceSplitInputs, now = new Date(), days = 30): { split: FinanceSplit; byDay: Map<string, DayLanes> } {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const lanes = new Map(inp.assignments.map((a) => [a.id, a.lane]));
  // per day per lane: raw tokens, dollars and sessions
  const raw = new Map<string, { tokens: Record<SplitLane, number>; usd: Record<SplitLane, number>; sessions: Record<SplitLane, number> }>();
  for (let i = days - 1; i >= 0; i--) raw.set(dayOf(midnight - i * DAY), { tokens: zeroLanes(), usd: zeroLanes(), sessions: zeroLanes() });
  // each window's straight sum over its sessions, for the check
  const windows = [7, 30].map((n) => ({ n, from: dayOf(midnight - (n - 1) * DAY), tokens: 0, count: 0 }));
  for (const s of inp.sessions) {
    const at = Date.parse(s.endedAt ?? s.startedAt);
    if (!(at <= now.getTime())) continue;
    const d = raw.get(dayOf(at));
    const tokens = sessionTokens(s);
    for (const w of windows) if (dayOf(at) >= w.from && d) { w.tokens += tokens; w.count++; }
    if (!d) continue;
    const lane = laneKindRow(s, s.assignmentId ? lanes.get(s.assignmentId) : undefined);
    d.tokens[lane] += tokens; d.usd[lane] += sessionListUsd(s); d.sessions[lane]++;
  }

  const byDay = new Map<string, DayLanes>();
  for (const [day, d] of raw) {
    const byLane = zeroLanes();
    let sum = 0;
    for (const l of SPLIT_LANES) { byLane[l] = Math.round(d.tokens[l]); sum += d.tokens[l]; }
    byDay.set(day, { byLane, sessionsTokens: Math.round(sum) });
  }

  let diff = 0, dailyDiff = 0, ok = true;
  const out = windows.map((w) => {
    const acc = { tokens: zeroLanes(), usd: zeroLanes(), sessions: zeroLanes() };
    let dailyTokens = 0, rows = 0;
    for (const [day, d] of raw) {
      if (day < w.from) continue;
      rows++;
      dailyTokens += byDay.get(day)!.sessionsTokens;
      for (const l of SPLIT_LANES) { acc.tokens[l] += d.tokens[l]; acc.usd[l] += d.usd[l]; acc.sessions[l] += d.sessions[l]; }
    }
    const totalTokens = SPLIT_LANES.reduce((n, l) => n + acc.tokens[l], 0);
    const part = (ls: readonly SplitLane[]): SplitPart => {
      const tokens = ls.reduce((n, l) => n + acc.tokens[l], 0);
      return {
        tokens: Math.round(tokens), usd: cents(ls.reduce((n, l) => n + acc.usd[l], 0)), sessions: ls.reduce((n, l) => n + acc.sessions[l], 0),
        share: totalTokens > 0 ? Math.round((tokens / totalTokens) * 1e4) / 1e4 : 0,
      };
    };
    const byLane = {} as Record<SplitLane, SplitPart>;
    for (const l of SPLIT_LANES) byLane[l] = part([l]);
    const win: SplitWindow = {
      days: w.n, from: w.from, to: dayOf(midnight),
      total: { tokens: Math.round(totalTokens), usd: cents(SPLIT_LANES.reduce((n, l) => n + acc.usd[l], 0)), sessions: w.count },
      work: part(SPLIT_GROUPS.work), coordination: part(SPLIT_GROUPS.coordination), other: part(SPLIT_GROUPS.other), byLane,
    };
    // the groups' rounded parts against the straight sum over the window's sessions; the daily rows against the total
    const d1 = win.work.tokens + win.coordination.tokens + win.other.tokens - Math.round(w.tokens);
    const d2 = dailyTokens - win.total.tokens;
    if (Math.abs(d1) > Math.max(1, w.count / 2) || Math.abs(d2) > Math.max(1, rows / 2)) ok = false;
    if (Math.abs(d1) > Math.abs(diff)) diff = d1;
    if (Math.abs(d2) > Math.abs(dailyDiff)) dailyDiff = d2;
    return win;
  });
  return { split: { d7: out[0]!, d30: out[1]!, groups: SPLIT_GROUPS, check: { ok, diff, dailyDiff, identity: IDENTITY } }, byDay };
}
