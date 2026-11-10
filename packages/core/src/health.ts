import { countsOf, isBackfilled, type Assignment, type Session, type TokenCounts } from "@muster-town/schema";
import { sessionTokens } from "./bank.ts";
import { laneKindRow } from "./finance-lane-kind.ts";
import type { World } from "./world.ts";

/**
 * Town health (grant gr_8bxoy2heif; 1:1 mt_o0exccdv8g decision 3): the before-baseline for the job refactor, read-only
 * over the sessions, assignments and grant events, counts only. GET <prefix>/api/health-stats serves it; the User
 * stats stand's "Town health" tab shows it; the daily money slate carries `healthLine` (built here, no Secretary tokens).
 *
 * Per UTC day (a session counts wholly on the day it ended, or started while running: the `byLaneKind` rule) and per
 * ISO week, over the counted sessions (back-filled ones, `isBackfilled`, have no real breakdown: left out, summed in
 * `notCounted`). Tokens are adjusted, as the Bank books them (`sessionTokens`).
 * - paperwork share = (kickoff + checkpoint + manager wakes) ÷ (grant-lane sessions ∪ those). Kickoff = a work session on
 *   an assignment titled "Grant … funded: assign its first step"; checkpoint = "Write the checkpoint for …"; a manager
 *   wake = purpose manage or review. Past PAPERWORK_MAX it shows red.
 * - cache hit ratio = cacheRead ÷ (cacheRead + cacheWrite5m + cacheWrite1h), raw counters. Below HIT_MIN it shows red.
 * - median cache write per session = the median of (cacheWrite5m + cacheWrite1h) over the counted sessions, raw.
 * - overrun = tokens of a grant's sessions started after its 100% hold (`grant.checkpoint`) and before the next human
 *   decision on it (`grant.funded`: continue or adjust; `grant.closed`: cut, stop or close). Still held = up to now.
 * - tokens per report, by lane (`laneKindRow`: grant, exploration, directed, retainer, manager, other) = the lane's
 *   tokens ÷ the lane's sessions that filed a report (null when none did).
 */
export const PAPERWORK_MAX = 0.15;
export const HIT_MIN = 0.7;
const HEALTH_DAYS = 14;
const HEALTH_WEEKS = 4;
const DAY = 86_400_000;
const KICKOFF = /^Grant .+ funded: assign its first step/;
const CHECKPOINT = /^Write the checkpoint for /;

type HealthSession = Pick<Session, "id" | "assignmentId" | "purpose" | "lane" | "grantId" | "reportId" | "model" | "bankModel" | "byModel" | "startedAt" | "endedAt"> & Partial<TokenCounts>;
/** A grant's hold: from its `grant.checkpoint` to the next human decision on it (null = still held). */
export interface GrantHold { grantId: string; from: string; to: string | null }
export interface HealthInputs {
  sessions: HealthSession[];
  assignments: Pick<Assignment, "id" | "title" | "lane">[];
  holds: GrantHold[];
}

interface LaneReport { tokens: number; reports: number; perReport: number | null }
export interface HealthLine {
  sessions: number;
  tokens: number;
  paperworkTokens: number;
  /** paperwork ÷ (grant lane ∪ paperwork); null when both are 0 */
  paperworkShare: number | null;
  cacheRead: number;
  cacheWrite: number;
  /** null when no cache tokens at all */
  hitRatio: number | null;
  medianCacheWrite: number | null;
  overrunTokens: number;
  reports: number;
  /** tokens per report over every lane; null when no report */
  perReport: number | null;
  byLane: Record<string, LaneReport>;
}
export interface TownHealth {
  from: string; to: string;
  thresholds: { paperworkMax: number; hitMin: number };
  /** the last HEALTH_DAYS UTC days, oldest first (every day listed) */
  days: (HealthLine & { day: string })[];
  /** the last HEALTH_WEEKS ISO weeks (Monday start), oldest first */
  weeks: (HealthLine & { week: string })[];
  /** the last 24 hours (the digest's line) */
  last24h: HealthLine;
  notCounted: { sessions: number; tokens: number };
  definitions: Record<"paperwork" | "hitRatio" | "medianCacheWrite" | "overrun" | "perReport", string>;
}

const DEFINITIONS: TownHealth["definitions"] = {
  paperwork: "Kickoff, checkpoint and manager-wake sessions' tokens ÷ (grant-lane sessions plus those). Red above 15%.",
  hitRatio: "Cache reads ÷ (cache reads + cache writes), raw tokens. Red below 70%.",
  medianCacheWrite: "The median session's cache writes (5 min + 1 h), raw tokens.",
  overrun: "Tokens of a grant's sessions started after its 100% hold and before a human continued, adjusted, cut or closed it.",
  perReport: "A lane's tokens ÷ its sessions that filed a report.",
};

interface Acc { sessions: number; tokens: number; paperwork: number; grantOrPaper: number; read: number; write: number; writes: number[]; overrun: number; lanes: Map<string, { tokens: number; reports: number }> }
const newAcc = (): Acc => ({ sessions: 0, tokens: 0, paperwork: 0, grantOrPaper: 0, read: 0, write: 0, writes: [], overrun: 0, lanes: new Map() });
const ratio = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1e4) / 1e4 : null);
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

function lineOut(a: Acc): HealthLine {
  const byLane: Record<string, LaneReport> = {};
  let reports = 0;
  for (const [lane, l] of a.lanes) {
    byLane[lane] = { tokens: Math.round(l.tokens), reports: l.reports, perReport: l.reports ? Math.round(l.tokens / l.reports) : null };
    reports += l.reports;
  }
  return {
    sessions: a.sessions, tokens: Math.round(a.tokens), paperworkTokens: Math.round(a.paperwork), paperworkShare: ratio(a.paperwork, a.grantOrPaper),
    cacheRead: a.read, cacheWrite: a.write, hitRatio: ratio(a.read, a.read + a.write), medianCacheWrite: median(a.writes),
    overrunTokens: Math.round(a.overrun), reports, perReport: reports ? Math.round(a.tokens / reports) : null, byLane,
  };
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** The Monday (UTC) of the ISO week holding `ms`, as YYYY-MM-DD. */
export function isoWeekStart(ms: number): string {
  const d = new Date(ms), dow = (d.getUTCDay() + 6) % 7;
  return utcDay(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - dow * DAY);
}

/** Whether a session falls in a grant's hold: same grant, started at or after the hold, before its release. */
function inHold(s: HealthSession, holds: Map<string, GrantHold[]>): boolean {
  if (!s.grantId) return false;
  const at = Date.parse(s.startedAt);
  return (holds.get(s.grantId) ?? []).some((h) => at >= Date.parse(h.from) && (h.to === null || at < Date.parse(h.to)));
}

/** The pure aggregation behind `townHealth`. */
export function healthOf(inp: HealthInputs, now = new Date()): TownHealth {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dayFrom = midnight - (HEALTH_DAYS - 1) * DAY;
  const weekFrom = Date.parse(isoWeekStart(now.getTime())) - (HEALTH_WEEKS - 1) * 7 * DAY;
  const from = Math.min(dayFrom, weekFrom), to = now.getTime(), since24 = to - DAY;
  const titles = new Map(inp.assignments.map((a) => [a.id, a]));
  const holds = new Map<string, GrantHold[]>();
  for (const h of inp.holds) { const l = holds.get(h.grantId) ?? []; l.push(h); holds.set(h.grantId, l); }
  const days = new Map<string, Acc>(), weeks = new Map<string, Acc>(), last = newAcc();
  for (let t = dayFrom; t <= midnight; t += DAY) days.set(utcDay(t), newAcc());
  for (let t = weekFrom; t <= midnight; t += 7 * DAY) weeks.set(utcDay(t), newAcc());
  const notCounted = { sessions: 0, tokens: 0 };
  for (const s of inp.sessions) {
    const at = Date.parse(s.endedAt ?? s.startedAt);
    if (!(at >= from && at <= to)) continue;
    const tokens = sessionTokens(s);
    const k = countsOf(s);
    if (isBackfilled(k, s.model)) { notCounted.sessions++; notCounted.tokens += tokens; continue; }
    const a = s.assignmentId ? titles.get(s.assignmentId) : undefined;
    const lane = laneKindRow(s, a?.lane);
    const paper = s.purpose === "manage" || s.purpose === "review" || (s.purpose === "work" && !!a && (KICKOFF.test(a.title) || CHECKPOINT.test(a.title)));
    const write = k.cacheWrite5m + k.cacheWrite1h;
    const overrun = inHold(s, holds);
    const accs = [days.get(utcDay(at)), weeks.get(isoWeekStart(at)), at > since24 ? last : undefined].filter((x): x is Acc => !!x);
    for (const acc of accs) {
      acc.sessions++; acc.tokens += tokens;
      if (paper) acc.paperwork += tokens;
      if (paper || lane === "grant") acc.grantOrPaper += tokens;
      acc.read += k.cacheRead; acc.write += write; acc.writes.push(write);
      if (overrun) acc.overrun += tokens;
      const l = acc.lanes.get(lane) ?? { tokens: 0, reports: 0 };
      l.tokens += tokens; if (s.reportId) l.reports++;
      acc.lanes.set(lane, l);
    }
  }
  return {
    from: new Date(from).toISOString(), to: now.toISOString(),
    thresholds: { paperworkMax: PAPERWORK_MAX, hitMin: HIT_MIN },
    days: [...days].map(([day, a]) => ({ day, ...lineOut(a) })),
    weeks: [...weeks].map(([week, a]) => ({ week, ...lineOut(a) })),
    last24h: lineOut(last),
    notCounted: { sessions: notCounted.sessions, tokens: Math.round(notCounted.tokens) },
    definitions: DEFINITIONS,
  };
}

/** Each grant's 100% holds from the event log: a `grant.checkpoint` until the next `grant.funded` or `grant.closed`. */
export function grantHolds(world: World): GrantHold[] {
  const rows = world.db.prepare("SELECT ts, type, json_extract(payload, '$.grantId') AS grantId FROM events WHERE type IN ('grant.checkpoint', 'grant.funded', 'grant.closed') ORDER BY ts, rowid").all() as { ts: string; type: string; grantId: string | null }[];
  const open = new Map<string, GrantHold>(), out: GrantHold[] = [];
  for (const r of rows) {
    if (!r.grantId) continue;
    if (r.type === "grant.checkpoint") {
      if (!open.has(r.grantId)) { const h = { grantId: r.grantId, from: r.ts, to: null }; open.set(r.grantId, h); out.push(h); }
    } else {
      const h = open.get(r.grantId);
      if (h) { h.to = r.ts; open.delete(r.grantId); }
    }
  }
  return out;
}

/** This collective's town health now (see `healthOf`). */
export function townHealth(world: World, now = new Date()): TownHealth {
  const since = new Date(now.getTime() - 40 * DAY).toISOString();
  const sessions = world.sessions.where("COALESCE(endedAt, startedAt) >= ?", [since]);
  const ids = new Set(sessions.map((s) => s.assignmentId).filter(Boolean));
  const assignments = world.assignments.where("createdAt >= ?", [new Date(now.getTime() - 120 * DAY).toISOString()]).filter((a) => ids.has(a.id));
  return healthOf({ sessions, assignments, holds: grantHolds(world) }, now);
}

const pct = (x: number | null) => (x === null ? "n/a" : `${Math.round(x * 100)}%`);
const k = (n: number | null) => (n === null ? "n/a" : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** The digest's one Health line over the last 24 h, built in code. */
export function healthLine(h: Pick<TownHealth, "last24h">): string {
  const l = h.last24h;
  return `Health: paperwork ${pct(l.paperworkShare)} · cache hits ${pct(l.hitRatio)} · overrun ${k(l.overrunTokens)} · ${k(l.perReport)}/report (last 24 h)`;
}
