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
 * `homePage2`, `homePage3`, `homeSkip`, `homeOpen` and `homeTile` (gr_ptle4vvujl) follow a homepage browser past the page
 * load: it reached the pitch card's page 2 or 3, pressed Skip or closed the card, pressed Open, or clicked a collective tile,
 * each once per UTC day. `homeCard` (step 3) is the card shown at all: it opens once per browser, so returning browsers add
 * to homeViews but not to it.
 * `sources` and `blogReads` (gr_ox3fmliv9n) say which channel brought them: a homepage or guest-card visitor's first ping of
 * the day carries a source (`funnelSource`: a ?ref= tag, else the external referrer's host, else "direct"), and each GET of a
 * blog post counts with its Referer's host, in join_funnel_sources. `hookViews` (gr_wq74nnthzl) are the same for each
 * cause's landing page /hooks/<slug>. Counts only, never a path, IP or id.
 */
import { createHash } from "node:crypto";
import type { World } from "./world.ts";

export const FUNNEL_STEPS = ["homeViews", "guestCardViews", "guestVisitors", "signInStarted", "signIns", "asked", "letIn", "declined", "acted", "doorFund", "doorCaptain", "doorAgent", "homePage2", "homePage3", "homeSkip", "homeOpen", "homeTile", "homeCard"] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];
/** The steps counted once per browser per UTC day. */
type VisitorStep = "homeViews" | "guestVisitors" | DoorStep | HomeStep;
/** The three doors (gr_y9bpvx197c): Fund, Captain a goal, Bring your agent, each a browser once per day. */
export const DOORS = { fund: "doorFund", captain: "doorCaptain", agent: "doorAgent" } as const;
export type DoorStep = (typeof DOORS)[keyof typeof DOORS];
/** The homepage pitch card and tiles (gr_ptle4vvujl): what a homepage browser did after the page loaded, each a browser once per day. */
export const HOME_STEPS = { card: "homeCard", page2: "homePage2", page3: "homePage3", skip: "homeSkip", open: "homeOpen", tile: "homeTile" } as const;
export type HomeStep = (typeof HOME_STEPS)[keyof typeof HOME_STEPS];
export type FunnelCounts = Record<FunnelStep, number>;
export interface FunnelDay extends FunnelCounts { day: string }
/** One day's count of a step from one source (gr_ox3fmliv9n): homeViews or guestVisitors, browsers once per day. */
export interface FunnelSourceRow { day: string; step: SourceStep; source: string; count: number }
/** One day's reads of a blog post from one source (gr_ox3fmliv9n): each GET of /blog/<slug>, bots left out. */
export interface BlogReadRow { day: string; slug: string; source: string; count: number }
/** One day's views of a cause's landing page /hooks/<slug> from one source (gr_wq74nnthzl): each browser GET, bots left out. */
export interface HookViewRow { day: string; slug: string; source: string; count: number }
export interface JoinFunnel { days: number; from: string; to: string; daily: FunnelDay[]; totals: FunnelCounts; decisions: number; medianDecisionMs: number | null; sources: FunnelSourceRow[]; blogReads: BlogReadRow[]; hookViews: HookViewRow[] }

export const FUNNEL_DAYS = 30;
const DAY_MS = 86_400_000;
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Never a stranger: our own checks and scripts (a headless browser, a command-line tool, no user agent at all), or a
 * crawler (Googlebot and bingbot render the page and run its pings). Crawlers name themselves "...bot/", "...bot-",
 * crawler, spider or Slurp, and nearly all give a "+http://" contact URL no browser carries.
 */
export const isAutomatedClient = (userAgent: string | undefined): boolean =>
  !userAgent || /HeadlessChrome|curl\/|wget\/|python-requests|node-fetch|undici|Playwright|Puppeteer|Lighthouse|bot\/|bot-|crawler|spider|Slurp|facebookexternalhit|Google-InspectionTool|\+https?:\/\//i.test(userAgent);

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

/** The steps a visitor's source is counted on (gr_ox3fmliv9n). */
export type SourceStep = "homeViews" | "guestVisitors";
const REF_TAG = /^[a-z0-9-]{1,24}$/;
const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;
/** A day keeps at most this many distinct sources; past it a new one counts as "other" (a flood of made-up referrers can't grow the table). */
export const MAX_SOURCES_PER_DAY = 200;

/**
 * Where a visitor came from, as one short label: a `?ref=` tag (a-z0-9-, at most 24 chars, lowercased) when the link had
 * one, else the referrer's host (no path, no port, a leading "www." dropped) when it is another site, else "direct" (no
 * referrer, our own host, or a referrer that isn't an http(s) URL). Our own host under /blog is "blog" (gr_y8buqgpata): a
 * reader who clicked through from a post or the blog index.
 */
export function funnelSource(o: { ref?: unknown; referrer?: unknown; ownHost?: string | null }): string {
  const ref = typeof o.ref === "string" ? o.ref.trim().toLowerCase() : "";
  if (REF_TAG.test(ref)) return `ref:${ref}`;
  if (typeof o.referrer !== "string" || !o.referrer) return "direct";
  let host: string, path: string;
  try {
    const u = new URL(o.referrer);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "direct";
    host = u.hostname.toLowerCase().replace(/^www\./, "");
    path = u.pathname;
  } catch { return "direct"; }
  const own = (o.ownHost ?? "").toLowerCase().replace(/:\d+$/, "").replace(/^www\./, "");
  if (host && host === own && (path === "/blog" || path.startsWith("/blog/"))) return "blog";
  if (!host || host === own || !HOST.test(host)) return "direct";
  return host;
}

/** Add one to (today, source, step) in join_funnel_sources; a day past MAX_SOURCES_PER_DAY sources folds new ones into "other". */
function countSource(world: World, step: string, source: string, now: number): void {
  const day = utcDay(now);
  const known = world.db.prepare("SELECT 1 FROM join_funnel_sources WHERE day = ? AND source = ? LIMIT 1").get(day, source);
  if (!known && source !== "direct" && source !== "other") {
    const { n } = world.db.prepare("SELECT COUNT(DISTINCT source) AS n FROM join_funnel_sources WHERE day = ?").get(day) as { n: number };
    if (n >= MAX_SOURCES_PER_DAY) source = "other";
  }
  world.db.prepare("INSERT INTO join_funnel_sources (day, source, step, n) VALUES (?, ?, ?, 1) ON CONFLICT(day, source, step) DO UPDATE SET n = n + 1").run(day, source, step);
  world.db.prepare("DELETE FROM join_funnel_sources WHERE day < ?").run(utcDay(now - FUNNEL_DAYS * DAY_MS));
}

/**
 * A homepage or guest-card visitor (gr_ox3fmliv9n): `countVisitor`, and when it is this browser's first time today on that
 * step, one more for its source. So each day's sources add up to that day's homeViews (or guestVisitors); a browser that
 * comes back the same day by another channel keeps its first source.
 */
export function countVisitorFrom(world: World, step: SourceStep, visitorId: string, source: string, now = Date.now()): boolean {
  if (!countVisitor(world, step, visitorId, now)) return false;
  countSource(world, step, source, now);
  return true;
}

/** One read of a blog post (gr_ox3fmliv9n): the caller has left bots out and checked the slug is a public post. */
export function countBlogRead(world: World, slug: string, source: string, now = Date.now()): void {
  countSource(world, `blog:${slug}`, source, now);
}

/** One view of a cause's landing page /hooks/<slug> (gr_wq74nnthzl): the caller has left bots out and checked the page exists. */
export function countHookView(world: World, slug: string, source: string, now = Date.now()): void {
  countSource(world, `hook:${slug}`, source, now);
}

function sourceRows(world: World, from: string, to: string): { sources: FunnelSourceRow[]; blogReads: BlogReadRow[]; hookViews: HookViewRow[] } {
  const rows = world.db.prepare("SELECT day, source, step, n FROM join_funnel_sources WHERE day >= ? AND day <= ? ORDER BY day, n DESC, source").all(from, to) as { day: string; source: string; step: string; n: number }[];
  const sources: FunnelSourceRow[] = [], blogReads: BlogReadRow[] = [], hookViews: HookViewRow[] = [];
  for (const r of rows) {
    if (r.step.startsWith("blog:")) blogReads.push({ day: r.day, slug: r.step.slice(5), source: r.source, count: r.n });
    else if (r.step.startsWith("hook:")) hookViews.push({ day: r.day, slug: r.step.slice(5), source: r.source, count: r.n });
    else sources.push({ day: r.day, step: r.step as SourceStep, source: r.source, count: r.n });
  }
  return { sources, blogReads, hookViews };
}

/** Rows from several collectives as one: the same (day, key, source) summed, ordered by day then count. */
function sumRows<T extends { day: string; source: string; count: number }>(parts: T[][], key: (r: T) => string): T[] {
  const by = new Map<string, T>();
  for (const r of parts.flat()) {
    const k = `${r.day}\u0000${key(r)}\u0000${r.source}`;
    const had = by.get(k);
    by.set(k, had ? { ...had, count: had.count + r.count } : { ...r });
  }
  return [...by.values()].sort((a, b) => a.day.localeCompare(b.day) || b.count - a.count || a.source.localeCompare(b.source));
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
  return { days, from, to, daily, totals, decisions: waits.length, medianDecisionMs: median(waits), ...sourceRows(world, from, to) };
}

/** Several collectives' funnels as one: summed totals and the median over every wait. */
export function sumFunnels(worlds: World[], days = FUNNEL_DAYS, now = Date.now()): Omit<JoinFunnel, "daily"> {
  const parts = worlds.map((w) => joinFunnel(w, days, now));
  const totals = Object.fromEntries(FUNNEL_STEPS.map((s) => [s, parts.reduce((n, p) => n + p.totals[s], 0)])) as FunnelCounts;
  const to = utcDay(now), from = utcDay(now - (days - 1) * DAY_MS);
  const waits = worlds.flatMap((w) => (w.db.prepare("SELECT waitMs FROM join_funnel_waits WHERE day >= ? AND day <= ?").all(from, to) as { waitMs: number }[]).map((r) => r.waitMs)).sort((a, b) => a - b);
  const sources = sumRows(parts.map((p) => p.sources), (r) => r.step);
  const blogReads = sumRows(parts.map((p) => p.blogReads), (r) => r.slug);
  const hookViews = sumRows(parts.map((p) => p.hookViews), (r) => r.slug);
  return { days, from, to, totals, decisions: waits.length, medianDecisionMs: median(waits), sources, blogReads, hookViews };
}

function median(sorted: number[]): number | null {
  if (!sorted.length) return null;
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m]! : Math.round((sorted[m - 1]! + sorted[m]!) / 2);
}
