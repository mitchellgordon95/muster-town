import type { Agent, Assignment, Building, Grant, Session } from "@muster-town/schema";
import { adjustedOfUsage } from "./bank.ts";
import { townFinance } from "./finance.ts";
import type { Repos } from "./store.ts";

/**
 * GET /api/finance/spend: where `used` went, by building → grant → assignment (Bank Transparency grant gr_8gtgmd828o,
 * step 1). Built from the sessions table, because Bank debits and usage rows carry no session or assignment
 * (dc_w2k9i2mkjy). Every figure is adjusted output tokens, each session priced like Grants.spent prices it.
 *
 * The top-level rows sum to `used` exactly: the buildings (their sessions), plus `unattributed` (usage no session
 * counts: before sessions carried counters, 2026-10-26 20:29, and anything else outside the sessions table), minus
 * `notFunded` (session spend beyond `used`: sessions nothing in the Bank or donations paid for, e.g. the Town Hall's
 * librarian). At most one of `unattributed` and `notFunded` is non-zero.
 */
export type SpendKind = "building" | "grant" | "no-grant" | "assignment" | "no-assignment" | "unattributed" | "not-funded";

export interface SpendNode {
  kind: SpendKind;
  /** the building, grant or assignment id; null for the synthetic rows */
  id: string | null;
  /** building name, grant objective, assignment title, or the synthetic row's label */
  name: string;
  tokens: number;
  /** tokens / used (0 when used is 0); a not-funded row's share is negative */
  share: number;
  sessions: number;
  children?: SpendNode[];
}

export interface FinanceSpend {
  /** FinanceSummary.used: drawn from the Bank plus spent from direct donations */
  used: number;
  /** all sessions' adjusted tokens, summed (= the buildings' rows) */
  sessionsTotal: number;
  /** used − sessionsTotal when positive: usage no session counts (pre-counter sessions and the like) */
  unattributed: number;
  /** sessionsTotal − used when positive: session spend outside the Bank and donations */
  notFunded: number;
  /** buildings by tokens, then an "Unattributed" or "Not funded" row when non-zero: these rows sum to `used` */
  rows: SpendNode[];
  /** the rows' sum vs used; ok when they match exactly */
  check: { ok: boolean; diff: number; identity: string };
  at: string;
}

export interface SpendInputs {
  sessions: Pick<Session, "agentId" | "assignmentId" | "grantId" | "model" | "input" | "output" | "cacheRead" | "cacheWrite5m" | "cacheWrite1h" | "byModel">[];
  assignments: Pick<Assignment, "id" | "buildingId" | "grantId" | "title">[];
  agents: Pick<Agent, "id" | "buildingId">[];
  buildings: Pick<Building, "id" | "name">[];
  grants: Pick<Grant, "id" | "objective">[];
}

export const NO_BUILDING = "No building (town-wide sessions)";
export const NO_GRANT = "No grant (exploration, directed and earlier work)";
export const NO_ASSIGNMENT = "Manager sessions, no assignment (manage, review, facilitate, summary, meeting replies)";
export const UNATTRIBUTED = "Unattributed: usage no session counts (before sessions carried counters, 2026-10-26 20:29)";
export const NOT_FUNDED = "Not funded: session spend beyond what the Bank and donations paid";

interface Acc { kind: SpendKind; id: string | null; name: string; tokens: number; sessions: number; kids: Map<string, Acc> }
const acc = (kind: SpendKind, id: string | null, name: string): Acc => ({ kind, id, name, tokens: 0, sessions: 0, kids: new Map() });
function child(parent: Acc, key: string, make: () => Acc): Acc {
  let c = parent.kids.get(key);
  if (!c) parent.kids.set(key, c = make());
  return c;
}

/** The pure aggregation behind GET /api/finance/spend, given `used` from financeSummary. */
export function financeSpend(inp: SpendInputs, used: number, now = new Date()): FinanceSpend {
  const assignments = new Map(inp.assignments.map((a) => [a.id, a]));
  const agents = new Map(inp.agents.map((a) => [a.id, a]));
  const buildingNames = new Map(inp.buildings.map((b) => [b.id, b.name]));
  const grantNames = new Map(inp.grants.map((g) => [g.id, g.objective]));
  const root = acc("building", null, "");

  for (const s of inp.sessions) {
    const tokens = adjustedOfUsage(s.model, s, s.byModel);
    const a = s.assignmentId ? assignments.get(s.assignmentId) : undefined;
    // sessions carry no building: the assignment's, else the agent's
    const buildingId = a?.buildingId ?? agents.get(s.agentId)?.buildingId ?? null;
    const b = child(root, buildingId ?? "", () => acc("building", buildingId, buildingId ? buildingNames.get(buildingId) ?? buildingId : NO_BUILDING));
    const path: Acc[] = [b];
    if (!s.assignmentId) {
      path.push(child(b, "no-assignment", () => acc("no-assignment", null, NO_ASSIGNMENT)));
    } else {
      const grantId = s.grantId ?? a?.grantId ?? null;
      const g = grantId
        ? child(b, `grant:${grantId}`, () => acc("grant", grantId, grantNames.get(grantId) ?? grantId))
        : child(b, "no-grant", () => acc("no-grant", null, NO_GRANT));
      path.push(g, child(g, s.assignmentId, () => acc("assignment", s.assignmentId, a?.title ?? s.assignmentId!)));
    }
    for (const n of path) { n.tokens += tokens; n.sessions++; }
    root.tokens += tokens;
  }

  const share = (t: number) => (used ? Math.round((t / used) * 1e4) / 1e4 : 0);
  const out = (n: Acc): SpendNode => {
    const kids = [...n.kids.values()].sort((x, y) => y.tokens - x.tokens).map(out);
    return { kind: n.kind, id: n.id, name: n.name, tokens: n.tokens, share: share(n.tokens), sessions: n.sessions, ...(kids.length ? { children: kids } : {}) };
  };
  const rows = [...root.kids.values()].sort((x, y) => y.tokens - x.tokens).map(out);
  const sessionsTotal = root.tokens;
  const unattributed = Math.max(0, used - sessionsTotal);
  const notFunded = Math.max(0, sessionsTotal - used);
  if (unattributed) rows.push({ kind: "unattributed", id: null, name: UNATTRIBUTED, tokens: unattributed, share: share(unattributed), sessions: 0 });
  if (notFunded) rows.push({ kind: "not-funded", id: null, name: NOT_FUNDED, tokens: -notFunded, share: share(-notFunded), sessions: 0 });
  const diff = rows.reduce((s, r) => s + r.tokens, 0) - used;
  return {
    used, sessionsTotal, unattributed, notFunded, rows,
    check: { ok: diff === 0, diff, identity: "buildings + unattributed − not funded = used" },
    at: now.toISOString(),
  };
}

/** financeSpend over the world's ledgers (Bank.spend). */
export function townSpend(repos: Repos, now = new Date()): FinanceSpend {
  return financeSpend({
    sessions: repos.sessions.all(),
    assignments: repos.assignments.all(),
    agents: repos.agents.all(),
    buildings: repos.buildings.all(),
    grants: repos.grants.all(),
  }, townFinance(repos, now).used, now);
}
