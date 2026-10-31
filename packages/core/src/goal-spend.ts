import { ROOT_GOAL_ID, type Assignment, type Building, type Grant, type GoalSpend, type KeyResult, type Session, type SpendByLane } from "@muster-town/schema";
import { adjustedOfUsage } from "./bank.ts";
import { funderWeights } from "./funders.ts";
import type { World } from "./world.ts";

/**
 * A goal's Spend tab (docs/goals.md "Spend tab", build step 4): its subtree's spend over a window, read from the
 * sessions table only. Nothing here reads or writes the Bank's ledgers: each session is priced the way GET
 * /api/finance/spend prices it (adjusted output tokens, `adjustedOfUsage`), so the two views agree.
 *
 * A session belongs to a goal by its lane: `grant` → the grant's key result's goal; a session whose assignment names a
 * key result (exploration, directed) → that key result's goal; anything else (a gap, directed work with no key result,
 * a manager's session with no assignment) → its building's attachment.
 */
export interface GoalSpendInputs {
  /** the goal and every goal under it (retired ones too: their past spend stays theirs) */
  subtree: Set<string>;
  sessions: Pick<Session, "id" | "agentId" | "assignmentId" | "grantId" | "lane" | "model" | "input" | "output" | "cacheRead" | "cacheWrite5m" | "cacheWrite1h" | "byModel" | "startedAt" | "endedAt">[];
  assignments: Pick<Assignment, "id" | "buildingId" | "grantId" | "keyResultId" | "lane">[];
  agents: { id: string; buildingId: string | null; homeBuildingId?: string | null }[];
  buildings: Pick<Building, "id" | "name" | "goalId">[];
  grants: Pick<Grant, "id" | "keyResultId" | "buildingId">[];
  keyResults: Pick<KeyResult, "id" | "text" | "goalId" | "status" | "updatedAt">[];
  /** the root's id: a building with no attachment hangs there */
  rootId: string;
  /** the funder filter (build step 8): the part of each session one funder paid (1 = whole, a share = pro rata); sessions not in it are left out */
  weights?: Map<string, number>;
}

const DAY = 86_400_000;
const lanes = (): SpendByLane => ({ grant: 0, exploration: 0, directed: 0, none: 0 });

/** The pure aggregation behind GET /api/goals/:id/spend. `days` counts back from `now`; a session counts by when it ended (or started, while running). */
export function goalSpend(goalId: string, inp: GoalSpendInputs, days = 7, now = new Date()): GoalSpend {
  const to = now.getTime(), from = to - days * DAY;
  const unit: GoalSpend["seriesUnit"] = days <= 14 ? "day" : "week";
  const step = unit === "day" ? DAY : 7 * DAY;
  const buckets = Math.ceil(days * DAY / step);
  const series = Array.from({ length: buckets }, (_, i) => ({ start: new Date(to - (buckets - i) * step).toISOString(), tokens: 0, byLane: lanes() }));
  const assignments = new Map(inp.assignments.map((a) => [a.id, a]));
  const agents = new Map(inp.agents.map((a) => [a.id, a]));
  const buildings = new Map(inp.buildings.map((b) => [b.id, b]));
  const grants = new Map(inp.grants.map((g) => [g.id, g]));
  const krs = new Map(inp.keyResults.map((k) => [k.id, k]));
  const byBuilding = new Map<string, GoalSpend["byBuilding"][number]>();
  const byKr = new Map<string, GoalSpend["byKeyResult"][number]>();
  const out: GoalSpend = { goalId, days, from: new Date(from).toISOString(), to: now.toISOString(), total: 0, sessions: 0, byLane: lanes(), series, seriesUnit: unit, byBuilding: [], byKeyResult: [], results: [] };

  for (const s of inp.sessions) {
    const at = Date.parse(s.endedAt ?? s.startedAt);
    if (!(at > from && at <= to)) continue;
    const a = s.assignmentId ? assignments.get(s.assignmentId) : undefined;
    const grantId = s.grantId ?? a?.grantId ?? null;
    const g = grantId ? grants.get(grantId) : undefined;
    const krId = g?.keyResultId ?? a?.keyResultId ?? null;
    const kr = krId ? krs.get(krId) : undefined;
    const agent = agents.get(s.agentId);
    const buildingId = a?.buildingId ?? g?.buildingId ?? agent?.homeBuildingId ?? agent?.buildingId ?? null;
    const b = buildingId ? buildings.get(buildingId) : undefined;
    const node = kr?.goalId ?? b?.goalId ?? (b ? inp.rootId : null);
    if (!node || !inp.subtree.has(node)) continue;
    const weight = inp.weights ? inp.weights.get(s.id) ?? 0 : 1;
    if (!weight) continue;
    const tokens = Math.round(adjustedOfUsage(s.model, s, s.byModel) * weight);
    const lane = (s.lane ?? a?.lane ?? "none") as keyof SpendByLane;
    out.total += tokens; out.sessions++; out.byLane[lane] += tokens;
    const i = Math.min(buckets - 1, Math.max(0, Math.floor((at - (to - buckets * step)) / step)));
    series[i]!.tokens += tokens; series[i]!.byLane[lane] += tokens;
    if (b) {
      let row = byBuilding.get(b.id);
      if (!row) byBuilding.set(b.id, row = { id: b.id, name: b.name, tokens: 0, sessions: 0, byLane: lanes() });
      row.tokens += tokens; row.sessions++; row.byLane[lane] += tokens;
    }
    if (kr) {
      let row = byKr.get(kr.id);
      if (!row) byKr.set(kr.id, row = { id: kr.id, text: kr.text, goalId: kr.goalId!, status: kr.status, tokens: 0, sessions: 0 });
      row.tokens += tokens; row.sessions++;
    }
  }
  out.byBuilding = [...byBuilding.values()].sort((x, y) => y.tokens - x.tokens);
  out.byKeyResult = [...byKr.values()].sort((x, y) => y.tokens - x.tokens);
  out.results = inp.keyResults
    .filter((k) => (k.status === "met" || k.status === "missed") && k.goalId && inp.subtree.has(k.goalId) && Date.parse(k.updatedAt) > from && Date.parse(k.updatedAt) <= to)
    .map((k) => ({ id: k.id, text: k.text, status: k.status as "met" | "missed", at: k.updatedAt }))
    .sort((x, y) => x.at.localeCompare(y.at));
  return out;
}

/** goalSpend over the world's tables (read-only); `funderUserId`: only what that funder paid for (the funder filter, step 8). */
export function worldGoalSpend(world: World, goalId: string, days = 7, now = new Date(), funderUserId?: string | null): GoalSpend {
  world.goalTree.require(goalId);
  const since = new Date(now.getTime() - days * DAY).toISOString();
  return goalSpend(goalId, {
    subtree: world.goalTree.subtreeIds(goalId),
    sessions: world.sessions.where("COALESCE(endedAt, startedAt) > ?", [since]),
    assignments: world.assignments.all(),
    agents: world.agents.all(),
    buildings: world.buildings.all(),
    grants: world.grants.all(),
    keyResults: world.keyResults.all(),
    rootId: ROOT_GOAL_ID,
    weights: funderUserId ? funderWeights(world, funderUserId, days, now) : undefined,
  }, days, now);
}
