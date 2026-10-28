import { countsOf, isBackfilled, rawTokens, splitRaw, type Agent, type Assignment, type Building, type Grant, type Session } from "@muster-town/schema";
import { adjustedOfUsage, adjustedOutputTokens } from "./bank.ts";
import type { EventLog } from "./events.ts";
import { townFinance } from "./finance.ts";
import type { Repos } from "./store.ts";

/**
 * GET /api/finance/spend: where `used` went, by building → grant → assignment (Bank Transparency grant gr_8gtgmd828o,
 * steps 1 and 2b). Built from the sessions table, because Bank debits and usage rows carry no session or assignment
 * (dc_w2k9i2mkjy). Every figure is adjusted output tokens, each session priced like Grants.spent prices it.
 *
 * The top-level rows sum to `used` exactly: the buildings (their sessions), plus `unattributed` (usage no session
 * counts: before sessions carried counters, 2026-10-26 20:29, and anything else outside the sessions table), minus
 * `weightMismatch` (sessions that ended before the Bank's conversion to adjusted tokens, `bank.converted`, whose
 * session row is priced at the session's own model while the ledger booked them with no model, at Opus weights: a
 * Fable session back-filled by migration 034 counts raw/24 here and raw/30 in the Bank, a later one its own counters at
 * Fable vs Opus weights; nothing unpaid, dc_7u3s419dv0), minus
 * `notFunded` (what is left beyond `used`: sessions nothing in the Bank or donations paid for, e.g. the Town Hall's
 * librarian). At most one of `unattributed` and `notFunded` is non-zero.
 */
export type SpendKind = "building" | "grant" | "no-grant" | "assignment" | "no-assignment" | "unattributed" | "weight-mismatch" | "not-funded";

export interface SpendNode {
  kind: SpendKind;
  /** the building, grant or assignment id; null for the synthetic rows */
  id: string | null;
  /** building name, grant objective, assignment title, or the synthetic row's label */
  name: string;
  tokens: number;
  /** tokens / used (0 when used is 0); the weight-mismatch and not-funded rows' shares are negative */
  share: number;
  sessions: number;
  children?: SpendNode[];
}

export interface FinanceSpend {
  /** FinanceSummary.used: drawn from the Bank plus spent from direct donations */
  used: number;
  /** all sessions' adjusted tokens, summed (= the buildings' rows) */
  sessionsTotal: number;
  /** used − (sessionsTotal − weightMismatch) when positive: usage no session counts (pre-counter sessions and the like) */
  unattributed: number;
  /**
   * Σ over sessions ended before `convertedAt` of (the session row's adjusted tokens − what the ledger booked for it at
   * Opus weights): the pre-conversion pricing difference, not spend. 0 when the Bank was never converted.
   */
  weightMismatch: number;
  /** one line on what `weightMismatch` is */
  weightMismatchNote: string;
  /** the `bank.converted` event's time (migration 037); null when the Bank was born adjusted */
  convertedAt: string | null;
  /** (sessionsTotal − weightMismatch) − used when positive: session spend outside the Bank and donations */
  notFunded: number;
  /** buildings by tokens, then an "Unattributed" row, a negative "Weight mismatch" row and a negative "Not funded" row when non-zero: these rows sum to `used` */
  rows: SpendNode[];
  /** the rows' sum vs used; ok when they match exactly */
  check: { ok: boolean; diff: number; identity: string };
  at: string;
}

export interface SpendInputs {
  sessions: Pick<Session, "agentId" | "assignmentId" | "grantId" | "model" | "input" | "output" | "cacheRead" | "cacheWrite5m" | "cacheWrite1h" | "byModel" | "endedAt">[];
  assignments: Pick<Assignment, "id" | "buildingId" | "grantId" | "title">[];
  agents: Pick<Agent, "id" | "buildingId">[];
  buildings: Pick<Building, "id" | "name">[];
  grants: Pick<Grant, "id" | "objective">[];
  /** when the Bank converted to adjusted tokens (the `bank.converted` event's ts); null = never, so no weight mismatch */
  convertedAt: string | null;
}

export const NO_BUILDING = "No building (town-wide sessions)";
export const NO_GRANT = "No grant (exploration, directed and earlier work)";
export const NO_ASSIGNMENT = "Manager sessions, no assignment (manage, review, facilitate, summary, meeting replies)";
export const UNATTRIBUTED = "Unattributed: usage no session counts (before sessions carried counters, 2026-10-26 20:29)";
export const WEIGHT_MISMATCH = "Weight mismatch: sessions before the Bank's conversion to adjusted tokens, counted here at their own model's weights but booked by the Bank at Opus weights (a Fable session: 24 raw per token here, 30 in the Bank); nothing unpaid";
export const NOT_FUNDED = "Not funded: session spend beyond what the Bank and donations paid for";
export const SPEND_IDENTITY = "buildings + unattributed − weight mismatch − not funded = used";

/**
 * When the runtime started writing the five counters into sessions and usage rows (migration 034's deploy): the earliest
 * end of a session with real counters. Sessions ended before it were back-filled by the migration from a raw total:
 * split at their model's ratio in the sessions table, at the Opus ratio in the ledger. Null when no session has real
 * counters yet (everything is a migration back-fill).
 */
export function countersSince(sessions: SpendInputs["sessions"]): string | null {
  let first: string | null = null;
  for (const s of sessions) {
    if (!s.endedAt || !rawTokens(countsOf(s)) || isBackfilled(s, s.model)) continue;
    if (!first || s.endedAt < first) first = s.endedAt;
  }
  return first;
}

/**
 * What the ledger booked for a session that ended before the conversion: its counters with no model, at Opus weights
 * (migration 037 priced every usage and debit row that way). A session back-filled by migration 034 (ended before the
 * runtime wrote counters, `countersSince`) was split at the Opus ratio in the ledger, so its raw total is re-split
 * there. From `countersSince` on, the runtime wrote the same counters into the session and its usage row (real ones,
 * or a bare total split at the session's model's ratio), so the ledger priced them as they are.
 */
export function ledgerBookedBeforeConversion(s: SpendInputs["sessions"][number], since: string | null): number {
  const backfilledByMigration = !since || (s.endedAt != null && s.endedAt < since);
  const counts = backfilledByMigration ? splitRaw(rawTokens(countsOf(s)), null) : countsOf(s);
  return adjustedOutputTokens(null, counts);
}

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
  let weightMismatch = 0, mismatched = 0;
  const since = inp.convertedAt ? countersSince(inp.sessions) : null;

  for (const s of inp.sessions) {
    const tokens = adjustedOfUsage(s.model, s, s.byModel);
    if (inp.convertedAt && s.endedAt && s.endedAt < inp.convertedAt) {
      const d = tokens - ledgerBookedBeforeConversion(s, since);
      if (d) { weightMismatch += d; mismatched++; }
    }
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
  // what the ledger booked for the sessions: the pre-conversion ones at Opus weights
  const booked = sessionsTotal - weightMismatch;
  const unattributed = Math.max(0, used - booked);
  const notFunded = Math.max(0, booked - used);
  if (unattributed) rows.push({ kind: "unattributed", id: null, name: UNATTRIBUTED, tokens: unattributed, share: share(unattributed), sessions: 0 });
  if (weightMismatch) rows.push({ kind: "weight-mismatch", id: null, name: WEIGHT_MISMATCH, tokens: -weightMismatch, share: share(-weightMismatch), sessions: mismatched });
  if (notFunded) rows.push({ kind: "not-funded", id: null, name: NOT_FUNDED, tokens: -notFunded, share: share(-notFunded), sessions: 0 });
  const diff = rows.reduce((s, r) => s + r.tokens, 0) - used;
  const converted = inp.convertedAt ? inp.convertedAt.slice(0, 16).replace("T", " ") + "Z" : "never";
  return {
    used, sessionsTotal, unattributed, weightMismatch,
    weightMismatchNote: `Sessions ended before the Bank's conversion to adjusted tokens (${converted}) are counted here at their own model's weights; the Bank booked them with no model, at Opus weights. The difference is pricing, not spend: nothing went unpaid.`,
    convertedAt: inp.convertedAt, notFunded, rows,
    check: { ok: diff === 0, diff, identity: SPEND_IDENTITY },
    at: now.toISOString(),
  };
}

/** The `bank.converted` event's time (migration 037, once per database), or null when the Bank was born adjusted. */
export const bankConvertedAt = (events: EventLog): string | null => events.list({ types: ["bank.converted"], limit: 1 })[0]?.ts ?? null;

/** financeSpend over the world's ledgers (Bank.spend). */
export function townSpend(repos: Repos, events: EventLog, now = new Date()): FinanceSpend {
  return financeSpend({
    sessions: repos.sessions.all(),
    assignments: repos.assignments.all(),
    agents: repos.agents.all(),
    buildings: repos.buildings.all(),
    grants: repos.grants.all(),
    convertedAt: bankConvertedAt(events),
  }, townFinance(repos, now).used, now);
}
