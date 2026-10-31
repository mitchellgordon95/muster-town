import { countsOf, isBackfilled, rawTokens, splitRaw, type Agent, type Allocation, type Assignment, type BankDebit, type Building, type Grant, type Session, type UsageEntry } from "@muster-town/schema";
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
  /** building name, the grant's short title (`grantTitle` of its objective), assignment title, or the synthetic row's label */
  name: string;
  /** grant rows only: the grant's full objective (`name` is its first clause, at most 60 characters) */
  objective?: string;
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
  /**
   * `notFunded` by building, from the usage ledger (gr_wp2rg302qu, rule from dc_cvp89lj91o): a usage row on or after the
   * first Bank debit with no debit for the same agent within NOT_FUNDED_MATCH_MS of it. Before PR #131 (2026-10-31
   * 00:36Z) `chargeUsage` recorded usage without a debit when the building had nothing left. Sorted by tokens desc; a
   * usage row with no building is the "unattributed" row (buildingId null). A heuristic: see `notFundedSplitCheck`.
   */
  notFundedSplit: NotFundedBuilding[];
  /** the latest unpaid usage row's createdAt (when the unpaid usage stopped); null when there is none */
  notFundedLastAt: string | null;
  /**
   * An estimate (≈57k on 2026-10-28, dc_7u3s419dv0): the part of the unpaid usage a donation straight to the building
   * (an Allocation, which is spent with no Bank debit) may have paid for: Σ over buildings of min(what the building's
   * allocations spent, the building's unpaid tokens). An allocation's spend is not dated per row, so this is an upper bound.
   */
  notFundedAllocationPaid: number;
  /** the split's sum vs `notFunded` (the exact ledger number, left untouched): ok when they are equal */
  notFundedSplitCheck: { sum: number; notFunded: number; ok: boolean };
  /** buildings by tokens, then an unattributed row, a negative weight-mismatch row and a negative "Not funded" row when non-zero: these rows sum to `used` */
  rows: SpendNode[];
  /** the rows' sum vs used; ok when they match exactly */
  check: { ok: boolean; diff: number; identity: string };
  at: string;
}

/** One building's unpaid usage (FinanceSpend.notFundedSplit). */
export interface NotFundedBuilding { buildingId: string | null; buildingName: string; usageRows: number; tokens: number }

export interface SpendInputs {
  sessions: Pick<Session, "agentId" | "assignmentId" | "grantId" | "model" | "input" | "output" | "cacheRead" | "cacheWrite5m" | "cacheWrite1h" | "byModel" | "endedAt">[];
  assignments: Pick<Assignment, "id" | "buildingId" | "grantId" | "title">[];
  agents: Pick<Agent, "id" | "buildingId">[];
  buildings: Pick<Building, "id" | "name">[];
  grants: Pick<Grant, "id" | "objective">[];
  /** when the Bank converted to adjusted tokens (the `bank.converted` event's ts); null = never, so no weight mismatch */
  convertedAt: string | null;
  /** the usage ledger, Bank debits and donations for `notFundedSplit` (left out = empty) */
  usage?: Pick<UsageEntry, "agentId" | "buildingId" | "tokens" | "createdAt">[];
  debits?: Pick<BankDebit, "agentId" | "createdAt">[];
  allocations?: Pick<Allocation, "buildingId" | "spentTokens">[];
}

export const NO_BUILDING = "No building (town-wide sessions)";
export const NO_GRANT = "Not under a grant: work a human asked for, work a building took up on its own, and sessions from before grants existed";
export const NO_ASSIGNMENT = "The manager's own sessions: reading reports, running meetings and replying (no assignment)";
export const UNATTRIBUTED = "Usage from before sessions carried counters (before 2026-10-26 20:29)";
export const WEIGHT_MISMATCH = "Priced differently before the switch to adjusted tokens (nothing went unpaid)";
export const NOT_FUNDED = "Not funded: work sessions the Bank never charged";
export const NOT_FUNDED_UNATTRIBUTED = "unattributed";
/** a usage row counts as paid when a Bank debit for the same agent lies within this many ms of it (dc_cvp89lj91o) */
export const NOT_FUNDED_MATCH_MS = 2_000;

/** The longest grant row name: longer first clauses are cut at a word and end in "…". */
const GRANT_TITLE_MAX = 60;

/**
 * A grant row's name: its objective's first clause (up to the first comma, colon or semicolon), at most
 * GRANT_TITLE_MAX characters, ending in "…" whenever anything was cut (the full objective rides along as `objective`).
 */
export function grantTitle(objective: string): string {
  const full = objective.trim().replace(/\s+/g, " ");
  const clause = full.split(/[,:;]/)[0].trim();
  if (clause.length <= GRANT_TITLE_MAX) return clause.length < full.length ? `${clause}…` : clause;
  const cut = clause.slice(0, GRANT_TITLE_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > GRANT_TITLE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
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

/**
 * The usage rows the Bank never debited (rule from dc_cvp89lj91o, validated in SQL on a seeded world): on or after the
 * first debit, with no debit for the same agent within NOT_FUNDED_MATCH_MS. Grouped by building, tokens desc.
 */
export function notFundedUsage(inp: Pick<SpendInputs, "usage" | "debits" | "allocations" | "buildings">):
  { split: NotFundedBuilding[]; lastAt: string | null; allocationPaid: number } {
  const usage = inp.usage ?? [], debits = inp.debits ?? [];
  const byAgent = new Map<string, number[]>();
  let first = Infinity;
  for (const d of debits) {
    const t = Date.parse(d.createdAt);
    if (t < first) first = t;
    let ts = byAgent.get(d.agentId);
    if (!ts) byAgent.set(d.agentId, ts = []);
    ts.push(t);
  }
  for (const ts of byAgent.values()) ts.sort((a, b) => a - b);
  // is there a t in sorted `ts` with |t − u| ≤ NOT_FUNDED_MATCH_MS?
  const near = (ts: number[] | undefined, u: number) => {
    if (!ts) return false;
    let lo = 0, hi = ts.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ts[mid] < u - NOT_FUNDED_MATCH_MS) lo = mid + 1; else hi = mid; }
    return lo < ts.length && ts[lo] <= u + NOT_FUNDED_MATCH_MS;
  };
  const names = new Map(inp.buildings.map((b) => [b.id, b.name]));
  const groups = new Map<string, NotFundedBuilding>();
  let lastAt: string | null = null, last = -Infinity;
  for (const u of usage) {
    const t = Date.parse(u.createdAt);
    if (!(t >= first) || near(byAgent.get(u.agentId), t)) continue;
    const key = u.buildingId ?? "";
    let g = groups.get(key);
    if (!g) groups.set(key, g = { buildingId: u.buildingId, buildingName: u.buildingId ? names.get(u.buildingId) ?? u.buildingId : NOT_FUNDED_UNATTRIBUTED, usageRows: 0, tokens: 0 });
    g.usageRows++;
    g.tokens += u.tokens;
    if (t > last) { last = t; lastAt = u.createdAt; }
  }
  const split = [...groups.values()].sort((a, b) => b.tokens - a.tokens);
  const allocated = new Map<string, number>();
  for (const a of inp.allocations ?? []) allocated.set(a.buildingId, (allocated.get(a.buildingId) ?? 0) + a.spentTokens);
  const allocationPaid = split.reduce((t, g) => t + (g.buildingId ? Math.min(allocated.get(g.buildingId) ?? 0, g.tokens) : 0), 0);
  return { split, lastAt, allocationPaid };
}

interface Acc { kind: SpendKind; id: string | null; name: string; objective?: string; tokens: number; sessions: number; kids: Map<string, Acc> }
const acc = (kind: SpendKind, id: string | null, name: string, objective?: string): Acc => ({ kind, id, name, ...(objective != null ? { objective } : {}), tokens: 0, sessions: 0, kids: new Map() });
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
        ? child(b, `grant:${grantId}`, () => {
          const objective = grantNames.get(grantId);
          return objective ? acc("grant", grantId, grantTitle(objective), objective) : acc("grant", grantId, grantId);
        })
        : child(b, "no-grant", () => acc("no-grant", null, NO_GRANT));
      path.push(g, child(g, s.assignmentId, () => acc("assignment", s.assignmentId, a?.title ?? s.assignmentId!)));
    }
    for (const n of path) { n.tokens += tokens; n.sessions++; }
    root.tokens += tokens;
  }

  const share = (t: number) => (used ? Math.round((t / used) * 1e4) / 1e4 : 0);
  const out = (n: Acc): SpendNode => {
    const kids = [...n.kids.values()].sort((x, y) => y.tokens - x.tokens).map(out);
    return { kind: n.kind, id: n.id, name: n.name, ...(n.objective != null ? { objective: n.objective } : {}), tokens: n.tokens, share: share(n.tokens), sessions: n.sessions, ...(kids.length ? { children: kids } : {}) };
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
  const nf = notFundedUsage(inp);
  const splitSum = nf.split.reduce((t, g) => t + g.tokens, 0);
  const converted = inp.convertedAt ? inp.convertedAt.slice(0, 16).replace("T", " ") + "Z" : "never";
  return {
    used, sessionsTotal, unattributed, weightMismatch,
    weightMismatchNote: `Sessions that ended before the Bank switched to adjusted tokens (${converted}) are priced here at their own model's rate and in the Bank at one rate for every model. The difference is pricing, not spend: nothing went unpaid.`,
    convertedAt: inp.convertedAt, notFunded,
    notFundedSplit: nf.split, notFundedLastAt: nf.lastAt, notFundedAllocationPaid: nf.allocationPaid,
    notFundedSplitCheck: { sum: splitSum, notFunded, ok: splitSum === notFunded },
    rows,
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
    usage: repos.usage.all(),
    debits: repos.bankDebits.all(),
    allocations: repos.allocations.all(),
  }, townFinance(repos, now).used, now);
}
