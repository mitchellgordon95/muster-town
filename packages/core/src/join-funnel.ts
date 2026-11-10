/**
 * The join funnel (grant gr_fibsfwr4tz step 3, findings dc_siqw9jf28w): per UTC day, how many saw the guest card, signed
 * in with GitHub, asked to join, were let in or declined, acted once let in (a member's first Say or 1:1 line, gr_58n37j410s
 * step 3), and how long each decided request waited. Counted where each step happens (the guest card's view ping,
 * `upsertGithubUser`, `requestAccess`, `decideAccess`, `countMemberAct`). Counts only: no user
 * id or login is ever stored here. GET /api/join-funnel serves it, public.
 * The top steps measure real strangers (gr_zoo2cf2zpp, findings dc_dmmktg7x3w): `homeViews` and `guestVisitors` count a
 * browser once per UTC day (`countVisitor`: the browser sends a random id, only its sha256 is kept, in join_funnel_visitors),
 * `guestCardViews` stays one per page load, and `signInStarted` is Sign in pressed (GET /auth/github with no session).
 * `doorFund`, `doorCaptain` and `doorAgent` (gr_y9bpvx197c) count a browser once per door per UTC day when it opens that
 * door from the guest card or the You're-in card.
 */
import { createHash } from "node:crypto";
import type { World } from "./world.ts";

export const FUNNEL_STEPS = ["homeViews", "guestCardViews", "guestVisitors", "signInStarted", "signIns", "asked", "letIn", "declined", "acted", "doorFund", "doorCaptain", "doorAgent"] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];
/** The steps counted once per browser per UTC day. */
type VisitorStep = "homeViews" | "guestVisitors" | DoorStep;
/** The three doors (gr_y9bpvx197c): Fund, Captain a goal, Bring your agent, each a browser once per day. */
export const DOORS = { fund: "doorFund", captain: "doorCaptain", agent: "doorAgent" } as const;
export type DoorStep = (typeof DOORS)[keyof typeof DOORS];
export type FunnelCounts = Record<FunnelStep, number>;
export interface FunnelDay extends FunnelCounts { day: string }
export interface JoinFunnel { days: number; from: string; to: string; daily: FunnelDay[]; totals: FunnelCounts; decisions: number; medianDecisionMs: number | null }

export const FUNNEL_DAYS = 30;
const DAY_MS = 86_400_000;
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Our own checks and scripts, never a stranger: a headless browser, a command-line tool, or no user agent at all. */
export const isAutomatedClient = (userAgent: string | undefined): boolean => !userAgent || /HeadlessChrome|curl\/|wget\/|python-requests|node-fetch|undici|Playwright|Puppeteer/i.test(userAgent);

/** Add one to a step's count for today (UTC). */
export function countFunnel(world: World, step: FunnelStep, now = Date.now()): void {
  if (!FUNNEL_STEPS.includes(step)) throw new Error(`unknown funnel step ${step}`);
  world.db.prepare(`INSERT INTO join_funnel (day, ${step}) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET ${step} = ${step} + 1`).run(utcDay(now));
}

/**
 * A browser (its random id, sent by the page; 8-128 chars) reached a step: count it the first time per step per UTC day.
 * Returns whether it counted. Only sha256(id) is stored; rows older than the window are dropped as it goes.
 */
export function countVisitor(world: World, step: VisitorStep, visitorId: string, now = Date.now()): boolean {
  if (typeof visitorId !== "string" || visitorId.length < 8 || visitorId.length > 128) return false;
  const day = utcDay(now);
  const idHash = createHash("sha256").update(visitorId).digest("hex");
  const r = world.db.prepare("INSERT OR IGNORE INTO join_funnel_visitors (day, step, idHash) VALUES (?, ?, ?)").run(day, step, idHash);
  if (r.changes === 0) return false;
  world.db.prepare("DELETE FROM join_funnel_visitors WHERE day < ?").run(utcDay(now - FUNNEL_DAYS * DAY_MS));
  countFunnel(world, step, now);
  return true;
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
