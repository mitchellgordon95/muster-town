/**
 * The join funnel (grant gr_fibsfwr4tz step 3, findings dc_siqw9jf28w): per UTC day, how many saw the guest card, signed
 * in with GitHub, asked to join, were let in or declined, acted once let in (a member's first Say or 1:1 line, gr_58n37j410s
 * step 3), and how long each decided request waited. Counted where each step happens (the guest card's view ping,
 * `upsertGithubUser`, `requestAccess`, `decideAccess`, `countMemberAct`). Counts only: no user
 * id or login is ever stored here. GET /api/join-funnel serves it, public.
 */
import type { World } from "./world.ts";

export const FUNNEL_STEPS = ["guestCardViews", "signIns", "asked", "letIn", "declined", "acted"] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];
export type FunnelCounts = Record<FunnelStep, number>;
export interface FunnelDay extends FunnelCounts { day: string }
export interface JoinFunnel { days: number; from: string; to: string; daily: FunnelDay[]; totals: FunnelCounts; decisions: number; medianDecisionMs: number | null }

export const FUNNEL_DAYS = 30;
const DAY_MS = 86_400_000;
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Add one to a step's count for today (UTC). */
export function countFunnel(world: World, step: FunnelStep, now = Date.now()): void {
  if (!FUNNEL_STEPS.includes(step)) throw new Error(`unknown funnel step ${step}`);
  world.db.prepare(`INSERT INTO join_funnel (day, ${step}) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET ${step} = ${step} + 1`).run(utcDay(now));
}

/** A request was decided after waiting `waitMs`: count it and keep the wait (no id) for the median. */
export function countFunnelDecision(world: World, granted: boolean, waitMs: number, now = Date.now()): void {
  countFunnel(world, granted ? "letIn" : "declined", now);
  world.db.prepare("INSERT INTO join_funnel_waits (day, waitMs) VALUES (?, ?)").run(utcDay(now), Math.max(0, Math.round(waitMs)));
}

/** The last `days` UTC days (today included), one row per day with any count, the totals and the median wait. */
export function joinFunnel(world: World, days = FUNNEL_DAYS, now = Date.now()): JoinFunnel {
  const to = utcDay(now), from = utcDay(now - (days - 1) * DAY_MS);
  const daily = world.db.prepare(`SELECT day, ${FUNNEL_STEPS.join(", ")} FROM join_funnel WHERE day >= ? AND day <= ? ORDER BY day`).all(from, to) as FunnelDay[];
  const totals = Object.fromEntries(FUNNEL_STEPS.map((s) => [s, daily.reduce((n, d) => n + d[s], 0)])) as FunnelCounts;
  const waits = (world.db.prepare("SELECT waitMs FROM join_funnel_waits WHERE day >= ? AND day <= ? ORDER BY waitMs").all(from, to) as { waitMs: number }[]).map((w) => w.waitMs);
  return { days, from, to, daily, totals, decisions: waits.length, medianDecisionMs: median(waits) };
}

/** Several collectives' funnels as one: summed totals and the median over every wait. */
export function sumFunnels(worlds: World[], days = FUNNEL_DAYS, now = Date.now()): Omit<JoinFunnel, "daily"> {
  const parts = worlds.map((w) => joinFunnel(w, days, now));
  const totals = Object.fromEntries(FUNNEL_STEPS.map((s) => [s, parts.reduce((n, p) => n + p.totals[s], 0)])) as FunnelCounts;
  const to = utcDay(now), from = utcDay(now - (days - 1) * DAY_MS);
  const waits = worlds.flatMap((w) => (w.db.prepare("SELECT waitMs FROM join_funnel_waits WHERE day >= ? AND day <= ?").all(from, to) as { waitMs: number }[]).map((r) => r.waitMs)).sort((a, b) => a - b);
  return { days, from, to, totals, decisions: waits.length, medianDecisionMs: median(waits) };
}

function median(sorted: number[]): number | null {
  if (!sorted.length) return null;
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m]! : Math.round((sorted[m - 1]! + sorted[m]!) / 2);
}
