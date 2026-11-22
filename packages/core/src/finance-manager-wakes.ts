import type { Agent, Ask, Doc, Session, TokenCounts } from "@muster-town/schema";
import { sessionTokens } from "./bank.ts";
import type { EventLog } from "./events.ts";
import { cents, sessionListUsd } from "./finance.ts";
import type { Repos } from "./store.ts";

/**
 * GET /api/finance/spend → `managerWakes` (gr_lwgus14rd2 step 3, kr_avafh64h02): each building's manager wakes per UTC
 * day beside their cost, so four wakes in fifteen minutes for four reports is a visible number. Read-only over the
 * sessions and docs tables.
 *
 * A wake = one session with purpose `manage` (a manager's team-lead session), in its agent's building, on the UTC day it
 * ended (or started, while running): the same day rule as `byLaneKind`. Tokens = Σ `sessionTokens` (adjusted, as the
 * Bank books them), $ = Σ `sessionListUsd`. Decided = docs (reports, flags, rollups of residents: anything with a
 * decision) whose `decidedBy` is the waking agent and whose `decidedAt` falls inside one of its wakes' [startedAt,
 * endedAt]; each doc counts once. A decision made outside any wake (a human's, or a fork's own) is not counted here.
 * Ask actions (gr_3ougmyubdm, kr_9ujwevkfqm) count as decided too, so the Secretary's wakes, which decide no report but
 * rank, fold, defer, overtake, rewrite and render asks, stop reading "no decisions": an ask whose history has an entry by
 * the waking agent inside the wake (create, rewritten, fold, retire, withdraw, defer, decide) counts once per wake, and
 * each ranking run (`ask.ranked` by the agent inside the wake) counts once. `askActions` is that part of `decided`.
 * perWake = tokens / wakes; perDecision = tokens / decided, null when nothing was decided.
 *
 * Window: always the last 7 full UTC days plus today so far (8 days), whatever `?window=` picks for byLaneKind: a day
 * line only means something beside the days around it. Days are newest first and only days with a wake are listed.
 */
interface ManagerWakeLine {
  wakes: number; tokens: number; usd: number;
  /** docs decided + ask actions inside the wakes */
  decided: number;
  /** the ask actions in `decided`: asks acted on (once per ask per wake) and ranking runs */
  askActions: number;
  perWake: number; perDecision: number | null;
}
interface ManagerWakeDay extends ManagerWakeLine { day: string }
interface ManagerWakesBuilding { days: ManagerWakeDay[]; total: ManagerWakeLine }
export interface ManagerWakes {
  from: string; to: string; windowNote: string;
  /** keyed by building id ("none" = a manage session whose agent has no building) */
  buildings: Record<string, ManagerWakesBuilding>;
  total: ManagerWakeLine;
  /** Σ manage sessions' tokens in the window (what the buildings' totals sum to) */
  manageTokens: number;
  /** each building's days sum to its total, and the buildings to manageTokens (within half a token per wake) */
  check: { ok: boolean; diff: number; identity: string };
}

type WakeSession = Pick<Session, "id" | "agentId" | "purpose" | "model" | "bankModel" | "byModel" | "startedAt" | "endedAt"> & Partial<TokenCounts>;
interface WakeInputs {
  sessions: WakeSession[];
  docs: Pick<Doc, "id" | "decidedBy" | "decidedAt">[];
  agents: Pick<Agent, "id" | "buildingId">[];
  /** asks with their history (who acted on each, when) */
  asks?: Pick<Ask, "id" | "history">[];
  /** the Secretary's ranking runs (`ask.ranked` events) */
  rankRuns?: { id: number; agentId: string | null; ts: string }[];
}

/** The ask-history actions that are an agent deciding something about the ask (not the town's own reopen, lint or retitle). */
const ASK_ACTIONS = new Set(["create", "rewritten", "fold", "retire", "withdraw", "defer", "decide"]);

const DAY = 86_400_000;
const IDENTITY = "Σ days = each building's total; Σ buildings = Σ manage sessions in the window";

function wakeWindow(now: Date): { from: string; to: string } {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return { from: new Date(midnight - 7 * DAY).toISOString(), to: now.toISOString() };
}

interface Acc { wakes: number; tokens: number; usd: number; decided: number; askActions: number }
const newAcc = (): Acc => ({ wakes: 0, tokens: 0, usd: 0, decided: 0, askActions: 0 });
function lineOut(a: Acc): ManagerWakeLine {
  const tokens = Math.round(a.tokens);
  return {
    wakes: a.wakes, tokens, usd: cents(a.usd), decided: a.decided, askActions: a.askActions,
    perWake: a.wakes ? Math.round(a.tokens / a.wakes) : 0,
    perDecision: a.decided ? Math.round(a.tokens / a.decided) : null,
  };
}

/** The pure join behind `managerWakes`. */
export function managerWakes(inp: WakeInputs, now = new Date()): ManagerWakes {
  const w = wakeWindow(now);
  const from = Date.parse(w.from), to = now.getTime();
  const agents = new Map(inp.agents.map((a) => [a.id, a.buildingId]));
  const decisions = new Map<string, { id: string; at: number }[]>();
  for (const d of inp.docs) {
    if (!d.decidedBy || !d.decidedAt) continue;
    const list = decisions.get(d.decidedBy) ?? [];
    list.push({ id: d.id, at: Date.parse(d.decidedAt) });
    decisions.set(d.decidedBy, list);
  }
  // ask actions by agent: one key per ask (or per ranking run), with when
  const actions = new Map<string, { key: string; at: number }[]>();
  const addAction = (by: string | null, key: string, at: string) => {
    if (!by) return;
    const list = actions.get(by) ?? [];
    list.push({ key, at: Date.parse(at) });
    actions.set(by, list);
  };
  for (const a of inp.asks ?? []) for (const h of a.history) if (ASK_ACTIONS.has(h.action)) addAction(h.by, a.id, h.at);
  for (const e of inp.rankRuns ?? []) addAction(e.agentId, `ranked:${e.id}`, e.ts);
  const counted = new Set<string>();
  const byBuilding = new Map<string, Map<string, Acc>>();
  let manageTokens = 0, n = 0;
  for (const s of inp.sessions) {
    if (s.purpose !== "manage") continue;
    const at = Date.parse(s.endedAt ?? s.startedAt);
    if (!(at >= from && at <= to)) continue;
    n++;
    const tokens = sessionTokens(s);
    manageTokens += tokens;
    const start = Date.parse(s.startedAt), end = s.endedAt ? Date.parse(s.endedAt) : to;
    let decided = 0;
    for (const d of decisions.get(s.agentId) ?? []) {
      if (d.at >= start && d.at <= end && !counted.has(d.id)) { counted.add(d.id); decided++; }
    }
    const acted = new Set<string>();
    for (const x of actions.get(s.agentId) ?? []) if (x.at >= start && x.at <= end) acted.add(x.key);
    decided += acted.size;
    const b = agents.get(s.agentId) ?? "none";
    const day = new Date(at).toISOString().slice(0, 10);
    let days = byBuilding.get(b);
    if (!days) byBuilding.set(b, days = new Map());
    let a = days.get(day);
    if (!a) days.set(day, a = newAcc());
    a.wakes++; a.tokens += tokens; a.usd += sessionListUsd(s); a.decided += decided; a.askActions += acted.size;
  }
  const buildings: Record<string, ManagerWakesBuilding> = {};
  const town = newAcc();
  let daysDiff = 0;
  for (const [id, days] of byBuilding) {
    const t = newAcc();
    for (const a of days.values()) { t.wakes += a.wakes; t.tokens += a.tokens; t.usd += a.usd; t.decided += a.decided; t.askActions += a.askActions; }
    const out = [...days.entries()].sort(([x], [y]) => (x < y ? 1 : -1)).map(([day, a]) => ({ day, ...lineOut(a) }));
    const total = lineOut(t);
    daysDiff += out.reduce((sum, d) => sum + d.tokens, 0) - total.tokens;
    buildings[id] = { days: out, total };
    town.wakes += t.wakes; town.tokens += t.tokens; town.usd += t.usd; town.decided += t.decided; town.askActions += t.askActions;
  }
  const total = lineOut(town);
  const diff = Math.round(total.tokens - manageTokens);
  const tol = Math.max(1, n / 2);
  return {
    from: w.from, to: w.to, windowNote: "the last 7 full UTC days and today so far",
    buildings, total, manageTokens: Math.round(manageTokens),
    check: { ok: Math.abs(diff) <= tol && Math.abs(daysDiff) <= tol, diff, identity: IDENTITY },
  };
}

/** managerWakes over the world's tables (read-only): only manage sessions and decisions that could fall in the window. */
export function townManagerWakes(repos: Repos, events: EventLog, now = new Date()): ManagerWakes {
  const { from } = wakeWindow(now);
  const since = new Date(Date.parse(from) - DAY).toISOString();
  return managerWakes({
    sessions: repos.sessions.where("purpose = 'manage' AND COALESCE(endedAt, startedAt) >= ?", [from]),
    // a wake ending in the window may have started up to a day before it
    docs: repos.docs.where("decidedBy IS NOT NULL AND decidedAt >= ?", [since]),
    agents: repos.agents.columns<Pick<Agent, "id" | "buildingId">>(["id", "buildingId"]),
    // an ask touched in the window was updated in it (or later)
    asks: repos.asks.where("updatedAt >= ?", [since]),
    rankRuns: events.list({ types: ["ask.ranked"], from: since, limit: 5000 }).map((e) => ({ id: e.id, agentId: e.agentId, ts: e.ts })),
  }, now);
}
