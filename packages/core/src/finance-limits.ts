import type { Assignment, Building, Goal, Session, TokenCounts } from "@muster-town/schema";
import { sessionTokens } from "./bank.ts";
import { laneKindRow } from "./finance-lane-kind.ts";
import type { DayLanes } from "./finance-split.ts";

/**
 * GET /api/finance `daily.rows[].limits`, `utilization.d7/.d30.limits` and `limitsCheck` (Bank Transparency grant
 * gr_6c24p5uy01 step 1, kr_4zg2jqsww1): what held spending back each UTC day, so a reader of "most credit expired" can
 * tell which lever moves spend: desks, the exploration cap, or grant work.
 *
 * Per day, read-only over the sessions, assignments, buildings and goals tables:
 * - desks: Σ building headcounts TODAY (headcounts are not versioned: past days use today's); deskHours = desks × the
 *   hours of the day (today: so far). deskHoursBusy = the wall time of desk (`backend` docker) sessions inside the day,
 *   each clipped to it (a running one runs until now; a finished one with no endedAt uses startedAt + wallMs, else 0
 *   and is counted in `noEnd`). Host sessions (managers, the Secretary) use no desk and are left out.
 * - exploration: the day's exploration-lane session tokens (the same lane rule and day rule as `byLane`: a session
 *   counts wholly on the UTC day it ended), today's town cap (the smallest cap on a root goal; null = uncapped) and the
 *   time the running sum first reached the cap (null = not reached).
 * - grantTokens: the day's grant-lane session tokens; grantsQueued: grant-lane assignments created that day.
 * - held: today's row only, the pending assignments the Bank or the lane gate holds now (`heldReason`); holds are not
 *   recorded, so past days are null.
 */
export interface DayLimits {
  /** desk-hours busy (2 decimals) */
  deskHoursBusy: number;
  /** desk-hours available: desks × hours of the day (today: so far), 2 decimals */
  deskHours: number;
  /** desks today (Σ building headcounts) */
  desks: number;
  exploration: { tokens: number; cap: number | null; capGoalId: string | null; reachedAt: string | null };
  grantTokens: number;
  grantsQueued: number;
  /** today: pending assignments held now; past days: null (not recorded) */
  held: number | null;
}

export interface WindowLimits {
  days: number;
  from: string;
  to: string;
  deskHoursBusy: number;
  deskHours: number;
  /** deskHoursBusy / deskHours, 0..1 (4 decimals) */
  deskShare: number;
  /** days the exploration cap was reached */
  capDays: number;
  /** days grant-lane work spent tokens */
  grantDays: number;
}

export interface LimitsCheck {
  ok: boolean;
  /** Σ days |exploration.tokens − byLane.exploration| + |grantTokens − byLane.grant| */
  diff: number;
  /** days whose busy desk-hours exceed the available ones (should be 0) */
  overDays: number;
  /** finished desk sessions in the window with no endedAt and no wallMs (counted as 0 h) */
  noEnd: number;
  identity: string;
}

export const LIMITS_IDENTITY = "each day's exploration and grant tokens = its byLane exploration and grant; desk-hours busy ≤ desk-hours available";
export const LIMITS_NOTE = "Headcounts and the exploration cap are not versioned: every day uses today's desks and today's cap (desks × the per-desk default). Held work is today's only. Host sessions (managers, the Secretary) use no desk.";

type LimitsSession = Pick<Session, "assignmentId" | "purpose" | "lane" | "backend" | "status" | "startedAt" | "endedAt" | "wallMs" | "model" | "bankModel" | "byModel"> & Partial<TokenCounts>;
export interface FinanceLimitsInputs {
  sessions: LimitsSession[];
  assignments: Pick<Assignment, "id" | "lane" | "status" | "heldReason" | "createdAt">[];
  buildings: Pick<Building, "headcount">[];
  goals: Pick<Goal, "id" | "parentId" | "desksTotal">[];
  /** the town default exploration tokens a desk buys per day (schema grantPricingOf): the root's cap = its desks × this */
  exploreTokensPerDeskPerDay: number;
  /** the days to fill, oldest first (the daily rows' days) */
  days: string[];
}

const DAY = 86_400_000;
const r2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * The town's exploration cap (gr_bre43gflz9 step 1): the root's desks × the per-desk default, its desks being the root's
 * own desk total when set, else every building's headcount (core free-tokens.ts `exploreCapsOnPath` at the root). Null = no root.
 */
export function townExploreCap(goals: FinanceLimitsInputs["goals"], desks: number, perDesk: number): { cap: number; goalId: string } | null {
  const root = goals.find((g) => !g.parentId);
  return root ? { cap: (root.desksTotal ?? desks) * perDesk, goalId: root.id } : null;
}

/** The pure aggregation: one DayLimits per day, plus how many finished desk sessions had no end. */
export function financeLimits(inp: FinanceLimitsInputs, now = new Date()): { byDay: Map<string, DayLimits>; noEnd: number } {
  const nowMs = now.getTime();
  const desks = inp.buildings.reduce((s, b) => s + b.headcount, 0);
  const capRow = townExploreCap(inp.goals, desks, inp.exploreTokensPerDeskPerDay);
  const lanes = new Map(inp.assignments.map((a) => [a.id, a.lane]));
  const today = now.toISOString().slice(0, 10);
  const acc = new Map<string, { busyMs: number; explore: { at: number; tokens: number }[]; exploreSum: number; grant: number; queued: number }>();
  for (const d of inp.days) acc.set(d, { busyMs: 0, explore: [], exploreSum: 0, grant: 0, queued: 0 });
  const first = inp.days.length ? Date.parse(`${inp.days[0]}T00:00:00.000Z`) : nowMs;

  let noEnd = 0;
  for (const s of inp.sessions) {
    // desk time, clipped to each day it overlaps
    if (s.backend === "docker") {
      const start = Date.parse(s.startedAt);
      let end = s.endedAt ? Date.parse(s.endedAt) : s.status === "running" ? nowMs : s.wallMs != null ? start + s.wallMs : NaN;
      if (!s.endedAt && s.status !== "running" && s.wallMs == null && start >= first) noEnd++;
      if (Number.isFinite(start) && Number.isFinite(end)) {
        end = Math.min(end, nowMs);
        for (let t = Math.max(start, first) - (Math.max(start, first) % DAY); t < end; t += DAY) {
          const a = acc.get(new Date(t).toISOString().slice(0, 10));
          const part = Math.min(end, t + DAY) - Math.max(start, t);
          if (a && part > 0) a.busyMs += part;
        }
      }
    }
    // tokens: the same lane rule, day rule and summing order as finance-split's byLane (so the check is exact)
    const at = Date.parse(s.endedAt ?? s.startedAt);
    if (!(at <= nowMs)) continue;
    const a = acc.get(new Date(at).toISOString().slice(0, 10));
    if (!a) continue;
    const lane = laneKindRow(s, s.assignmentId ? lanes.get(s.assignmentId) : undefined);
    if (lane === "exploration") { const t = sessionTokens(s); a.explore.push({ at, tokens: t }); a.exploreSum += t; }
    else if (lane === "grant") a.grant += sessionTokens(s);
  }
  for (const x of inp.assignments) {
    if (x.lane !== "grant") continue;
    const a = acc.get(x.createdAt.slice(0, 10));
    if (a) a.queued++;
  }
  const held = inp.assignments.filter((x) => x.status === "pending" && x.heldReason).length;

  const byDay = new Map<string, DayLimits>();
  for (const [day, a] of acc) {
    const dayStart = Date.parse(`${day}T00:00:00.000Z`);
    const hours = Math.max(0, Math.min(DAY, nowMs - dayStart)) / 3_600_000;
    a.explore.sort((x, y) => x.at - y.at);
    let sum = 0, reachedAt: string | null = null;
    for (const e of a.explore) {
      sum += e.tokens;
      if (capRow && reachedAt === null && sum >= capRow.cap) reachedAt = new Date(e.at).toISOString();
    }
    byDay.set(day, {
      deskHoursBusy: r2(a.busyMs / 3_600_000), deskHours: r2(desks * hours), desks,
      exploration: { tokens: Math.round(a.exploreSum), cap: capRow?.cap ?? null, capGoalId: capRow?.goalId ?? null, reachedAt },
      grantTokens: Math.round(a.grant), grantsQueued: a.queued, held: day === today ? held : null,
    });
  }
  return { byDay, noEnd };
}

/** A window's summary over its rows (the last `n` of the daily rows). */
export function windowLimits(rows: { day: string; limits?: DayLimits }[], from: string, to: string, days: number): WindowLimits {
  let busy = 0, avail = 0, capDays = 0, grantDays = 0;
  for (const r of rows) {
    if (r.day < from || r.day > to || !r.limits) continue;
    busy += r.limits.deskHoursBusy; avail += r.limits.deskHours;
    if (r.limits.exploration.reachedAt) capDays++;
    if (r.limits.grantTokens > 0) grantDays++;
  }
  return { days, from, to, deskHoursBusy: r2(busy), deskHours: r2(avail), deskShare: avail > 0 ? Math.round((busy / avail) * 1e4) / 1e4 : 0, capDays, grantDays };
}

/** limitsCheck: each day's limits against its byLane (finance-split). */
export function limitsCheck(rows: { byLane: DayLanes["byLane"]; limits?: DayLimits }[], noEnd: number): LimitsCheck {
  let diff = 0, overDays = 0;
  for (const r of rows) {
    if (!r.limits) continue;
    diff += Math.abs(r.limits.exploration.tokens - r.byLane.exploration) + Math.abs(r.limits.grantTokens - r.byLane.grant);
    if (r.limits.deskHoursBusy > r.limits.deskHours + 0.01) overDays++;
  }
  return { ok: diff === 0 && overDays === 0, diff, overDays, noEnd, identity: LIMITS_IDENTITY };
}
