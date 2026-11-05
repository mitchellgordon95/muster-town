import { TOKEN_KINDS, countsOf, isBackfilled, type Assignment, type Agent, type Session, type TokenCountKind, type TokenCounts } from "@muster-town/schema";
import { bankModelOf, sessionTokens, tokenPrices } from "./bank.ts";
import { cents, sessionListUsd } from "./finance.ts";
import type { Repos } from "./store.ts";

/**
 * GET /api/finance/spend?window=today|7d → `byLaneKind` (gr_lwgus14rd2 step 1, kr_pzr1fkgas8): the window's session spend
 * as a lane × token-kind table, in adjusted tokens and dollars at API list price, with each row's cache-write share of
 * cost. Read-only over the sessions table, priced like `sessionTokens`: each kind's counters at its model's list price
 * (per model with `byModel`), converted at the session's booking model's output price (`bankModelOf`).
 *
 * Rows: a work session's lane (its own `lane`, else its assignment's: grant, exploration, directed, retainer); purpose
 * `manage` (a manager's team-lead wake) = "manager"; every other purpose (review, facilitate, summary, meeting-reply,
 * naming, estimate) and a work session with no lane recorded = "other", so the rows sum to the window's sessions.
 * Back-filled sessions (counters that are only the split of a raw total, `isBackfilled`) have no real breakdown: they
 * are left out of the rows and summed in `notCounted`.
 *
 * Window: a session counts by when it ended (or started, while running), wholly in the day it ends. `today` = the UTC
 * day so far; `7d` = the 7 full UTC days before today plus today so far.
 */
const LANE_KIND_ROWS = ["grant", "exploration", "directed", "retainer", "manager", "other"] as const;
type LaneKindRowKey = (typeof LANE_KIND_ROWS)[number];
export const LANE_KIND_WINDOWS = ["today", "7d"] as const;
export type LaneKindWindow = (typeof LANE_KIND_WINDOWS)[number];

interface LaneKindCell { tokens: number; usd: number }
interface LaneKindRow {
  lane: LaneKindRowKey | "total";
  sessions: number;
  /** per token kind: adjusted tokens and dollars at list price */
  kinds: Record<TokenCountKind, LaneKindCell>;
  tokens: number;
  usd: number;
  /** (cache write 5 min + 1 h dollars) / the row's dollars; 0 for an empty row */
  cacheWriteShare: number;
}
/** One table: the six rows (empty ones left out), their total and the back-filled sessions left out. */
export interface LaneKindTable {
  rows: LaneKindRow[];
  total: LaneKindRow;
  notCounted: { sessions: number; tokens: number; usd: number };
}
export interface SpendByLaneKind extends LaneKindTable {
  window: LaneKindWindow;
  /** the window's bounds, ISO */
  from: string;
  to: string;
  /** what the window covers, in words */
  windowNote: string;
  /** Σ sessionTokens over every session in the window (what the rows + notCounted sum to) */
  sessionsTokens: number;
  /** rows' tokens + notCounted vs sessionsTokens; ok within rounding (half a token per session) */
  check: { ok: boolean; diff: number; identity: string };
  /** the same table per building, keyed by building id ("none" = sessions with no building) */
  buildings: Record<string, LaneKindTable>;
}

const LANE_KIND_IDENTITY = "Σ lane × kind rows + not counted (back-filled) = Σ sessions in the window";
const NO_BUILDING_KEY = "none";
const DAY = 86_400_000;

type LaneKindSession = Pick<Session, "agentId" | "assignmentId" | "purpose" | "lane" | "model" | "bankModel" | "byModel" | "startedAt" | "endedAt"> & Partial<TokenCounts>;
interface LaneKindInputs {
  sessions: LaneKindSession[];
  assignments: Pick<Assignment, "id" | "buildingId" | "lane">[];
  agents: Pick<Agent, "id" | "buildingId">[];
}

/** The window's bounds for `now`. */
function laneKindWindow(window: LaneKindWindow, now: Date): { from: string; to: string; note: string } {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const from = window === "today" ? midnight : midnight - 7 * DAY;
  return {
    from: new Date(from).toISOString(), to: now.toISOString(),
    note: window === "today" ? "today so far (UTC)" : "the last 7 full UTC days and today so far",
  };
}

/** A session's row: manage → manager; work → its lane; anything else → other. */
export function laneKindRow(s: Pick<Session, "purpose" | "lane">, assignmentLane: string | null | undefined): LaneKindRowKey {
  if (s.purpose === "manage") return "manager";
  if (s.purpose !== "work") return "other";
  const lane = s.lane ?? assignmentLane;
  return lane === "grant" || lane === "exploration" || lane === "directed" || lane === "retainer" ? lane : "other";
}

/** A session's dollars per token kind at list price (per model with `byModel`, else at its model). */
function sessionKindUsd(s: Pick<Session, "model" | "byModel"> & Partial<TokenCounts>): Record<TokenCountKind, number> {
  const out = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  const parts = s.byModel && Object.keys(s.byModel).length ? Object.entries(s.byModel) : [[s.model, countsOf(s)] as const];
  for (const [m, c] of parts) {
    const p = tokenPrices(m).usdPerMTok, k = countsOf(c);
    for (const kind of TOKEN_KINDS) out[kind] += (k[kind] * p[kind]) / 1e6;
  }
  return out;
}

interface Acc { sessions: number; usd: Record<TokenCountKind, number>; tokens: Record<TokenCountKind, number> }
const zero = (): Record<TokenCountKind, number> => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
const newAcc = (): Acc => ({ sessions: 0, usd: zero(), tokens: zero() });
interface TableAcc { rows: Map<LaneKindRowKey, Acc>; notCounted: { sessions: number; tokens: number; usd: number } }
const newTable = (): TableAcc => ({ rows: new Map(), notCounted: { sessions: 0, tokens: 0, usd: 0 } });

function rowOut(lane: LaneKindRow["lane"], a: Acc): LaneKindRow {
  const kinds = {} as Record<TokenCountKind, LaneKindCell>;
  let tokens = 0, usd = 0;
  for (const k of TOKEN_KINDS) { kinds[k] = { tokens: Math.round(a.tokens[k]), usd: cents(a.usd[k]) }; tokens += a.tokens[k]; usd += a.usd[k]; }
  const share = usd > 0 ? (a.usd.cacheWrite5m + a.usd.cacheWrite1h) / usd : 0;
  return { lane, sessions: a.sessions, kinds, tokens: Math.round(tokens), usd: cents(usd), cacheWriteShare: Math.round(share * 1e4) / 1e4 };
}

function tableOut(t: TableAcc): LaneKindTable {
  const total = newAcc();
  const rows: LaneKindRow[] = [];
  for (const lane of LANE_KIND_ROWS) {
    const a = t.rows.get(lane);
    if (!a) continue;
    rows.push(rowOut(lane, a));
    total.sessions += a.sessions;
    for (const k of TOKEN_KINDS) { total.tokens[k] += a.tokens[k]; total.usd[k] += a.usd[k]; }
  }
  return { rows, total: rowOut("total", total), notCounted: { ...t.notCounted, usd: cents(t.notCounted.usd) } };
}

/** The pure aggregation behind `byLaneKind`. */
export function spendByLaneKind(inp: LaneKindInputs, window: LaneKindWindow, now = new Date()): SpendByLaneKind {
  const w = laneKindWindow(window, now);
  const from = Date.parse(w.from), to = now.getTime();
  const assignments = new Map(inp.assignments.map((a) => [a.id, a]));
  const agents = new Map(inp.agents.map((a) => [a.id, a]));
  const town = newTable();
  const byBuilding = new Map<string, TableAcc>();
  let sessionsTokens = 0, n = 0;
  for (const s of inp.sessions) {
    const at = Date.parse(s.endedAt ?? s.startedAt);
    if (!(at >= from && at <= to)) continue;
    n++;
    const booked = sessionTokens(s);
    sessionsTokens += booked;
    const a = s.assignmentId ? assignments.get(s.assignmentId) : undefined;
    const buildingId = a?.buildingId ?? agents.get(s.agentId)?.buildingId ?? NO_BUILDING_KEY;
    let bt = byBuilding.get(buildingId);
    if (!bt) byBuilding.set(buildingId, bt = newTable());
    if (isBackfilled(countsOf(s), s.model)) {
      const usd = sessionListUsd(s);
      for (const t of [town, bt]) { t.notCounted.sessions++; t.notCounted.tokens += booked; t.notCounted.usd += usd; }
      continue;
    }
    const lane = laneKindRow(s, a?.lane);
    const usd = sessionKindUsd(s);
    const unit = tokenPrices(bankModelOf(s)).usdPerMTok.output;
    for (const t of [town, bt]) {
      let r = t.rows.get(lane);
      if (!r) t.rows.set(lane, r = newAcc());
      r.sessions++;
      for (const k of TOKEN_KINDS) { r.usd[k] += usd[k]; r.tokens[k] += (usd[k] * 1e6) / unit; }
    }
  }
  const out = tableOut(town);
  const diff = out.total.tokens + out.notCounted.tokens - sessionsTokens;
  const buildings: Record<string, LaneKindTable> = {};
  for (const [id, t] of byBuilding) buildings[id] = tableOut(t);
  return {
    window, from: w.from, to: w.to, windowNote: w.note, ...out, sessionsTokens,
    check: { ok: Math.abs(diff) <= Math.max(1, n / 2), diff, identity: LANE_KIND_IDENTITY },
    buildings,
  };
}

/** spendByLaneKind over the world's tables (read-only): only the sessions that could fall in the window are loaded. */
export function townSpendByLaneKind(repos: Repos, window: LaneKindWindow, now = new Date()): SpendByLaneKind {
  const { from } = laneKindWindow(window, now);
  return spendByLaneKind({
    sessions: repos.sessions.where("COALESCE(endedAt, startedAt) >= ?", [from]),
    assignments: repos.assignments.all(),
    agents: repos.agents.all(),
  }, window, now);
}
