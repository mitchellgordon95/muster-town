import { grantName, countsOf, estimateRangeOf, isBackfilled, rawTokens, splitRaw, type Agent, type Allocation, type Assignment, type BankDebit, type Building, type Grant, type GrantEstimate, type GrantOutcome, type GrantStatus, type KeyResult, type Session, type UsageEntry } from "@muster-town/schema";
import { adjustedOutputTokens, sessionTokens } from "./bank.ts";
import type { EventLog } from "./events.ts";
import { sourceOrigin } from "./origin.ts";
import { bankTokensUsd, cents, sessionListUsd, townFinance } from "./finance.ts";
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
export type SpendKind = "building" | "grant" | "no-grant" | "lane" | "assignment" | "no-assignment" | "unattributed" | "weight-mismatch" | "not-funded";

/**
 * The lane rows under a building's "Not under a grant" row (gr_utygatbi85, kr_k76nyweby5): a session's own lane
 * (directed, exploration, retainer); `manager` = a non-work session (review, meeting, summary, …) on an assignment, or a
 * grant-lane session whose grant is not recorded; `before` = a work session with no lane recorded (before lanes existed,
 * migration 025). The assignment's lane is not used: assignments from before lanes were back-filled `directed`.
 */
export type NoGrantLane = "directed" | "exploration" | "retainer" | "manager" | "before";
export const NO_GRANT_LANES: readonly NoGrantLane[] = ["directed", "exploration", "retainer", "manager", "before"];
export const NO_GRANT_LANE_NAME: Record<NoGrantLane, string> = {
  directed: "Asked for by a human (directed)",
  exploration: "Exploration: a building looking for its next grant",
  retainer: "Retainers: a schedule's runs",
  manager: "Manager's assigned work: reviews, meetings and other non-work sessions on an assignment",
  before: "Before lanes: work sessions from before lanes were recorded",
};

/** A directed assignment row's human source (kr_v5419kedhk): the meeting, doc or tell it traces to, and who asked. */
export interface SpendSource {
  /** Assignment.sourceId (mt_, dc_ or ms_); null = a human created the work directly, or nothing was recorded */
  id: string | null;
  kind: "meeting" | "doc" | "tell" | null;
  /** the human it traces to: the source's human, else the assignment's origin, else a human creator; null = not known */
  askedById: string | null;
  askedBy: string | null;
}
/** An exploration assignment row's outcome (kr_v5419kedhk): the proposal its fork filed, or null = no proposal. */
export interface SpendProposal {
  id: string;
  title: string;
  /** funded (funded at any point, incl. closed), rejected, withdrawn, or open (draft, proposed, countered) */
  state: "funded" | "rejected" | "withdrawn" | "open";
}

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
  /** the row's dollars at API list price, to the cent: each session at its booking model's output price; the synthetic rows' tokens at BANK_MODEL's ($20/M) */
  usd: number;
  /** grant rows of a known grant only: the tokens a human granted it (`Grant.grantTokens`, raised at each top-up; null until funded) */
  grantTokens?: number | null;
  /** grant rows of a known grant only: its status (funded, checkpoint, closed, …) */
  status?: GrantStatus;
  /** grant rows of a known grant only: its outcome once closed (done, cut, stopped, …); null while open */
  outcome?: GrantOutcome | null;
  /** grant rows of a known grant only: which of the three groups of `FinanceSpend.grants.byOutcome` it counts in (`spendOutcome`) */
  outcomeGroup?: SpendOutcome;
  /** grant rows of a known grant only: its key results by status; `open` = not-started, on-track or at-risk */
  krCounts?: KrCounts;
  /** lane rows (kind "lane") only: which lane */
  lane?: NoGrantLane;
  /** assignment rows under the directed lane row only: its human source */
  source?: SpendSource;
  /** assignment rows under the exploration lane row only: the proposal it ended in; null = no proposal */
  proposal?: SpendProposal | null;
  children?: SpendNode[];
}

/** FinanceSpend.noGrant: every building's "Not under a grant" row summed, split by lane, and what the exploration rows ended in. */
export interface SpendNoGrant {
  tokens: number;
  sessions: number;
  usd: number;
  byLane: Record<NoGrantLane, { tokens: number; sessions: number; usd: number; assignments: number }>;
  /** exploration assignment rows (each counted once per building row): how many ended in a proposal, by its state */
  exploration: { assignments: number; proposals: number; funded: number; rejected: number; withdrawn: number; open: number };
  /** directed assignment rows: how many name a human source, how many name who asked */
  directed: { assignments: number; withSource: number; withAsker: number };
}

/** The three groups the Spending tab totals grants by: closed with the work done, closed without it, still open. */
export type SpendOutcome = "done" | "cut" | "open";
export interface KrCounts { met: number; missed: number; claimed: number; open: number }

/**
 * A grant's group on the Spending tab: closed as `done` or `met` → done; closed any other way (`cut`, `stopped`, `spent`)
 * or rejected → cut; everything else (funded, checkpoint, and the not-yet-funded statuses) → open.
 */
export function spendOutcome(g: Pick<Grant, "status" | "outcome">): SpendOutcome {
  if (g.status === "closed") return g.outcome === "done" || g.outcome === "met" ? "done" : "cut";
  return g.status === "rejected" ? "cut" : "open";
}

/** What the grant rows add up to, by outcome (FinanceSpend.grants); each grant counts once however many buildings its sessions came from. */
export interface SpendGrants {
  /** distinct known grants with a row in the tree */
  count: number;
  /** Σ their grantTokens (null counts 0) */
  funded: number;
  /** Σ the grant rows' tokens, across all buildings */
  spent: number;
  byOutcome: Record<SpendOutcome, { count: number; tokens: number }>;
  /** the grants whose spend (all their rows) is above grantTokens, and Σ (spent − grantTokens) over them */
  overFunding: { count: number; tokens: number };
  /**
   * The closed grants that carry a cost estimate (docs/how-work-gets-done.md §4) and how many spent inside it (the
   * model's range when it answered, else the similar grants'). Ranges are adjusted tokens; `badRanges` lists any whose
   * low is above its high (npm run check:finance holds it empty).
   */
  estimates: { closed: number; inside: number; unit: "adjusted tokens"; badRanges: string[] };
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
   * usage row with no building is the "unattributed" row (buildingId null). A heuristic: see `notFundedSplitCheck`. Each building's rows are netted against what its allocations (donations) spent: Budget.charge with an allocation draws no Bank debit.
   */
  notFundedSplit: NotFundedBuilding[];
  /** the latest unpaid usage row's createdAt (when the unpaid usage stopped); null when there is none */
  notFundedLastAt: string | null;
  /**
   * What donations straight to a building paid of its undebited usage rows, already taken out of `notFundedSplit` (an
   * Allocation is spent with no Bank debit, Budget.charge): Σ over buildings of min(what the building's allocations
   * spent, the building's undebited tokens). An allocation's spend is not dated per row, so this is an estimate.
   */
  notFundedAllocationPaid: number;
  /** the split's sum vs `notFunded` (the exact ledger number, left untouched): ok when they are equal */
  notFundedSplitCheck: { sum: number; notFunded: number; ok: boolean; reason?: string };
  /** buildings by tokens, then an unattributed row, a negative weight-mismatch row and a negative "Not funded" row when non-zero: these rows sum to `used` */
  rows: SpendNode[];
  /** the rows' sum vs used; ok when they match exactly */
  check: { ok: boolean; diff: number; identity: string };
  /**
   * The same in dollars at API list price (gr_gmzli3f96j): `sessionsTotal` is Σ sessions' list-price cost (each at its
   * booking model's output price, a pre-076 Fable session at $50/M), the synthetic rows are priced at BANK_MODEL ($20/M),
   * and `used` = sessionsTotal + (used − sessionsTotal tokens) × $20/M, equal to GET /api/finance `usd.used`.
   */
  usd: { used: number; sessionsTotal: number; unattributed: number; weightMismatch: number; notFunded: number };
  /** the rows' dollars (each rounded to the cent) summed vs `usd.used`; ok when |diff| is under a cent, or half a cent per row (rounding) when there are more than two rows */
  usdSumCheck: { ok: boolean; diff: number; identity: string };
  /** the grant rows (of known grants) summed by outcome (gr_dt1l35tydx) */
  grants: SpendGrants;
  /** byOutcome done + cut + open tokens vs Σ the grant rows' tokens; ok when they are equal */
  grantsCheck: { ok: boolean; diff: number; identity: string };
  /** the non-grant half by lane (gr_utygatbi85) */
  noGrant: SpendNoGrant;
  /** every lane row's tokens vs its "Not under a grant" row's, summed over buildings; ok when equal */
  noGrantCheck: { ok: boolean; diff: number; identity: string };
  at: string;
}

/** One building's unpaid usage (FinanceSpend.notFundedSplit). */
export interface NotFundedBuilding { buildingId: string | null; buildingName: string; usageRows: number; tokens: number }

export interface SpendInputs {
  sessions: (Pick<Session, "agentId" | "assignmentId" | "grantId" | "model" | "input" | "output" | "cacheRead" | "cacheWrite5m" | "cacheWrite1h" | "byModel" | "bankModel" | "endedAt"> & Partial<Pick<Session, "purpose" | "lane" | "startedAt">>)[];
  assignments: (Pick<Assignment, "id" | "buildingId" | "grantId" | "title"> & Partial<Pick<Assignment, "sourceId" | "origin" | "createdBy" | "createdByKind" | "reportId">>)[];
  agents: Pick<Agent, "id" | "buildingId">[];
  buildings: Pick<Building, "id" | "name">[];
  grants: (Pick<Grant, "id" | "objective"> & Partial<Pick<Grant, "title" | "buildingId" | "grantTokens" | "status" | "outcome" | "estimate" | "proposedBy" | "createdAt" | "fundedAt" | "findingsDocIds" | "history">>)[];
  /** names of the humans directed rows name (left out = ids only) */
  users?: { id: string; name: string }[];
  /** a directed source's human (core origin.ts `sourceOrigin`), keyed by source id; left out = none known */
  sourceAskers?: Map<string, string | null>;
  /** the grants' key results, for each grant row's `krCounts` (left out = none) */
  keyResults?: Pick<KeyResult, "grantId" | "status">[];
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
/** why the split by building can differ from notFunded (shown instead of a bare "these differ") */
export const NOT_FUNDED_SPLIT_REASON = "Not funded is a net total (what sessions counted, less everything paid), so a session paid more than it counted cancels part of it; the split by building counts each undebited usage row in full, after what donations to that building paid, so it is an estimate that can come out higher.";
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
  // usage a donation to the building paid (Budget.charge with an allocation draws no Bank debit, budget.ts charge): net
  // each building's unmatched rows against what its allocations spent, so those rows no longer count as unpaid
  const allocated = new Map<string, number>();
  for (const a of inp.allocations ?? []) allocated.set(a.buildingId, (allocated.get(a.buildingId) ?? 0) + a.spentTokens);
  let allocationPaid = 0;
  const netted = new Set<NotFundedBuilding>();
  for (const g of groups.values()) {
    const paid = g.buildingId ? Math.min(allocated.get(g.buildingId) ?? 0, g.tokens) : 0;
    if (paid) { g.tokens -= paid; allocationPaid += paid; netted.add(g); }
  }
  const split = [...groups.values()].filter((g) => g.tokens > 0 || !netted.has(g)).sort((a, b) => b.tokens - a.tokens);
  return { split, lastAt, allocationPaid };
}

interface Acc { kind: SpendKind; id: string | null; name: string; objective?: string; grant?: GrantFields; extra?: Pick<SpendNode, "lane" | "source" | "proposal">; tokens: number; usd: number; sessions: number; kids: Map<string, Acc> }
type GrantFields = Required<Pick<SpendNode, "grantTokens" | "status" | "outcome" | "outcomeGroup" | "krCounts">>;
const acc = (kind: SpendKind, id: string | null, name: string, objective?: string, grant?: GrantFields): Acc => ({ kind, id, name, ...(objective != null ? { objective } : {}), ...(grant ? { grant } : {}), tokens: 0, usd: 0, sessions: 0, kids: new Map() });
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
  const grantsById = new Map(inp.grants.map((g) => [g.id, g]));
  const krs = new Map<string, KrCounts>();
  for (const k of inp.keyResults ?? []) {
    if (!k.grantId) continue;
    let c = krs.get(k.grantId);
    if (!c) krs.set(k.grantId, c = { met: 0, missed: 0, claimed: 0, open: 0 });
    if (k.status === "met" || k.status === "missed" || k.status === "claimed") c[k.status]++;
    else c.open++;
  }
  const grantFields = (g: SpendInputs["grants"][number]): GrantFields | undefined => g.status === undefined ? undefined : {
    grantTokens: g.grantTokens ?? null, status: g.status, outcome: g.outcome ?? null, outcomeGroup: spendOutcome({ status: g.status, outcome: g.outcome ?? null }),
    krCounts: krs.get(g.id) ?? { met: 0, missed: 0, claimed: 0, open: 0 },
  };
  const root = acc("building", null, "");
  let weightMismatch = 0, mismatched = 0;
  const since = inp.convertedAt ? countersSince(inp.sessions) : null;

  for (const s of inp.sessions) {
    const tokens = sessionTokens(s), usd = sessionListUsd(s);
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
          const gr = grantsById.get(grantId);
          return gr ? acc("grant", grantId, grantName(gr), gr.objective, grantFields(gr)) : acc("grant", grantId, grantId);
        })
        : child(b, "no-grant", () => acc("no-grant", null, NO_GRANT));
      let parent = g;
      if (!grantId) {
        const lane = noGrantLane(s);
        path.push(g);
        parent = child(g, `lane:${lane}`, () => ({ ...acc("lane", lane, NO_GRANT_LANE_NAME[lane]), extra: { lane } }));
      }
      path.push(parent, child(parent, s.assignmentId, () => acc("assignment", s.assignmentId, a?.title ?? s.assignmentId!)));
    }
    for (const n of path) { n.tokens += tokens; n.usd += usd; n.sessions++; }
    root.tokens += tokens;
    root.usd += usd;
  }

  const share = (t: number) => (used ? Math.round((t / used) * 1e4) / 1e4 : 0);
  const out = (n: Acc): SpendNode => {
    const kids = [...n.kids.values()].sort((x, y) => y.tokens - x.tokens).map(out);
    return { kind: n.kind, id: n.id, name: n.name, ...(n.objective != null ? { objective: n.objective } : {}), tokens: n.tokens, share: share(n.tokens), sessions: n.sessions, usd: cents(n.usd), ...n.grant, ...n.extra, ...(kids.length ? { children: kids } : {}) };
  };
  annotateNoGrant(root, inp, now);
  const rows = [...root.kids.values()].sort((x, y) => y.tokens - x.tokens).map(out);
  const sessionsTotal = root.tokens;
  // what the ledger booked for the sessions: the pre-conversion ones at Opus weights
  const booked = sessionsTotal - weightMismatch;
  const unattributed = Math.max(0, used - booked);
  const notFunded = Math.max(0, booked - used);
  const usdOf = (t: number) => cents(bankTokensUsd(t));
  if (unattributed) rows.push({ kind: "unattributed", id: null, name: UNATTRIBUTED, tokens: unattributed, share: share(unattributed), sessions: 0, usd: usdOf(unattributed) });
  if (weightMismatch) rows.push({ kind: "weight-mismatch", id: null, name: WEIGHT_MISMATCH, tokens: -weightMismatch, share: share(-weightMismatch), sessions: mismatched, usd: usdOf(-weightMismatch) });
  if (notFunded) rows.push({ kind: "not-funded", id: null, name: NOT_FUNDED, tokens: -notFunded, share: share(-notFunded), sessions: 0, usd: usdOf(-notFunded) });
  const diff = rows.reduce((s, r) => s + r.tokens, 0) - used;
  // the same formula as financeSummary's usd.used, so the two endpoints agree to the cent
  const usd = { used: cents(root.usd + bankTokensUsd(used - sessionsTotal)), sessionsTotal: cents(root.usd), unattributed: usdOf(unattributed), weightMismatch: usdOf(weightMismatch), notFunded: usdOf(notFunded) };
  const usdDiff = cents(rows.reduce((s, r) => s + r.usd, 0) - usd.used);
  const nf = notFundedUsage(inp);
  const splitSum = nf.split.reduce((t, g) => t + g.tokens, 0);
  const gs = spendGrants(rows, new Map(inp.grants.flatMap((g) => g.estimate ? [[g.id, g.estimate] as const] : [])));
  const grantsDiff = gs.grants.byOutcome.done.tokens + gs.grants.byOutcome.cut.tokens + gs.grants.byOutcome.open.tokens - gs.rowsSum;
  const ng = spendNoGrant(rows);
  const converted = inp.convertedAt ? inp.convertedAt.slice(0, 16).replace("T", " ") + "Z" : "never";
  return {
    used, sessionsTotal, unattributed, weightMismatch,
    weightMismatchNote: `Sessions that ended before the Bank switched to adjusted tokens (${converted}) are priced here at their own model's rate and in the Bank at one rate for every model. The difference is pricing, not spend: nothing went unpaid.`,
    convertedAt: inp.convertedAt, notFunded,
    notFundedSplit: nf.split, notFundedLastAt: nf.lastAt, notFundedAllocationPaid: nf.allocationPaid,
    notFundedSplitCheck: splitSum === notFunded ? { sum: splitSum, notFunded, ok: true } : { sum: splitSum, notFunded, ok: false, reason: NOT_FUNDED_SPLIT_REASON },
    rows,
    check: { ok: diff === 0, diff, identity: SPEND_IDENTITY },
    usd,
    usdSumCheck: { ok: Math.abs(usdDiff) < Math.max(0.01, 0.005 * rows.length + 1e-9), diff: usdDiff, identity: `${SPEND_IDENTITY}, in dollars at API list price` },
    grants: gs.grants,
    grantsCheck: { ok: grantsDiff === 0 && gs.grants.spent === gs.rowsSum, diff: grantsDiff, identity: GRANTS_IDENTITY },
    noGrant: ng.noGrant,
    noGrantCheck: { ok: ng.diff === 0, diff: ng.diff, identity: NO_GRANT_IDENTITY },
    at: now.toISOString(),
  };
}

export const NO_GRANT_IDENTITY = "Σ lane rows = Σ \"Not under a grant\" rows (every building)";

/** A no-grant session's lane row (NoGrantLane): its own lane, a non-work purpose = manager, no lane = before lanes. */
export function noGrantLane(s: Partial<Pick<Session, "purpose" | "lane">>): NoGrantLane {
  if (s.purpose && s.purpose !== "work") return "manager";
  if (s.lane === "directed" || s.lane === "exploration" || s.lane === "retainer") return s.lane;
  return s.lane === "grant" ? "manager" : "before";
}

/** A proposal's state on an exploration row: funded once funded (closed ones too), else withdrawn, rejected or open. */
export function proposalState(g: Partial<Pick<Grant, "status" | "fundedAt" | "history">>): SpendProposal["state"] {
  if (g.fundedAt || g.status === "funded" || g.status === "checkpoint" || g.status === "stopping") return "funded";
  if (g.history?.some((h) => h.action === "withdraw")) return "withdrawn";
  if (g.status === "rejected" || g.status === "closed") return "rejected";
  return "open";
}

const SOURCE_KIND = { mt: "meeting", dc: "doc", ms: "tell" } as const;
/** Slack after a session ends for a proposal it filed to still count as its own (the session row closes after the call). */
const PROPOSAL_SLACK_MS = 2 * 60_000;

/**
 * Directed and exploration assignment rows under the lane rows get their `source` / `proposal` (kr_v5419kedhk). The
 * exploration join: a grant of the assignment's building (a fork's `propose_grant` is booked as its manager's, so
 * `proposedBy` is the manager, not the fork) or proposed by one of its session agents, created inside one of the
 * assignment's sessions (+2 min); else a grant whose findings cite the assignment's report; the first by creation time.
 */
function annotateNoGrant(root: Acc, inp: SpendInputs, now: Date) {
  const assignments = new Map(inp.assignments.map((a) => [a.id, a]));
  const users = new Map((inp.users ?? []).map((u) => [u.id, u.name]));
  const windows = new Map<string, { agentId: string; from: number; to: number }[]>();
  for (const s of inp.sessions) {
    if (!s.assignmentId || !s.startedAt) continue;
    let w = windows.get(s.assignmentId);
    if (!w) windows.set(s.assignmentId, w = []);
    w.push({ agentId: s.agentId, from: Date.parse(s.startedAt), to: (s.endedAt ? Date.parse(s.endedAt) : now.getTime()) + PROPOSAL_SLACK_MS });
  }
  const byTime = inp.grants.filter((g) => g.createdAt).sort((x, y) => x.createdAt!.localeCompare(y.createdAt!));
  const proposalOf = (id: string): SpendProposal | null => {
    const a = assignments.get(id);
    const report = a?.reportId;
    let found: SpendInputs["grants"][number] | undefined;
    for (const w of windows.get(id) ?? []) {
      const g = byTime.find((x) => (x.buildingId === a?.buildingId || x.proposedBy === w.agentId) && Date.parse(x.createdAt!) >= w.from && Date.parse(x.createdAt!) <= w.to);
      if (g && (!found || g.createdAt! < found.createdAt!)) found = g;
    }
    if (!found && report) found = inp.grants.find((g) => g.findingsDocIds?.includes(report));
    return found ? { id: found.id, title: grantName({ title: found.title ?? "", objective: found.objective }), state: proposalState(found) } : null;
  };
  const sourceOf = (id: string): SpendSource => {
    const a = assignments.get(id);
    const sid = a?.sourceId ?? null;
    const asker = (sid ? inp.sourceAskers?.get(sid) : null) ?? a?.origin?.userId ?? (a?.createdByKind === "user" ? a.createdBy ?? null : null) ?? null;
    return { id: sid, kind: sid ? SOURCE_KIND[sid.slice(0, 2) as keyof typeof SOURCE_KIND] ?? null : null, askedById: asker, askedBy: asker ? users.get(asker) ?? null : null };
  };
  for (const b of root.kids.values()) {
    const ng = b.kids.get("no-grant");
    if (!ng) continue;
    for (const l of ng.kids.values()) {
      const lane = l.extra?.lane;
      if (lane !== "directed" && lane !== "exploration") continue;
      for (const r of l.kids.values()) {
        if (!r.id) continue;
        r.extra = lane === "directed" ? { source: sourceOf(r.id) } : { proposal: proposalOf(r.id) };
      }
    }
  }
}

/** FinanceSpend.noGrant from the finished rows, and Σ lane rows − Σ no-grant rows (0 when the lane rows close). */
export function spendNoGrant(rows: SpendNode[]): { noGrant: SpendNoGrant; diff: number } {
  const byLane = Object.fromEntries(NO_GRANT_LANES.map((l) => [l, { tokens: 0, sessions: 0, usd: 0, assignments: 0 }])) as SpendNoGrant["byLane"];
  const out: SpendNoGrant = { tokens: 0, sessions: 0, usd: 0, byLane, exploration: { assignments: 0, proposals: 0, funded: 0, rejected: 0, withdrawn: 0, open: 0 }, directed: { assignments: 0, withSource: 0, withAsker: 0 } };
  let laneSum = 0;
  for (const b of rows) {
    for (const ng of b.children ?? []) {
      if (ng.kind !== "no-grant") continue;
      out.tokens += ng.tokens; out.sessions += ng.sessions; out.usd += ng.usd;
      for (const l of ng.children ?? []) {
        if (l.kind !== "lane" || !l.lane) continue;
        laneSum += l.tokens;
        const t = byLane[l.lane];
        t.tokens += l.tokens; t.sessions += l.sessions; t.usd += l.usd; t.assignments += l.children?.length ?? 0;
        for (const r of l.children ?? []) {
          if (l.lane === "exploration") {
            out.exploration.assignments++;
            if (r.proposal) { out.exploration.proposals++; out.exploration[r.proposal.state]++; }
          } else if (l.lane === "directed") {
            out.directed.assignments++;
            if (r.source?.id) out.directed.withSource++;
            if (r.source?.askedById) out.directed.withAsker++;
          }
        }
      }
    }
  }
  out.usd = cents(out.usd);
  for (const l of NO_GRANT_LANES) byLane[l].usd = cents(byLane[l].usd);
  return { noGrant: out, diff: laneSum - out.tokens };
}

export const GRANTS_IDENTITY = "done + cut + still open = Σ grant rows' tokens (every building)";

/**
 * FinanceSpend.grants from the finished tree: per grant (by id, across buildings) its rows' tokens, then by outcome group.
 * `rowsSum` is Σ the same rows' tokens taken row by row, which `grantsCheck` holds the groups against.
 */
export function spendGrants(rows: SpendNode[], estimates: Map<string, GrantEstimate> = new Map()): { grants: SpendGrants; rowsSum: number } {
  const per = new Map<string, { tokens: number; node: SpendNode }>();
  let rowsSum = 0;
  const walk = (n: SpendNode) => {
    if (n.kind === "grant" && n.id && n.outcomeGroup) {
      rowsSum += n.tokens;
      const p = per.get(n.id);
      if (p) p.tokens += n.tokens; else per.set(n.id, { tokens: n.tokens, node: n });
    }
    for (const c of n.children ?? []) walk(c);
  };
  for (const r of rows) walk(r);
  const byOutcome: SpendGrants["byOutcome"] = { done: { count: 0, tokens: 0 }, cut: { count: 0, tokens: 0 }, open: { count: 0, tokens: 0 } };
  const overFunding = { count: 0, tokens: 0 };
  let funded = 0, spent = 0;
  for (const { tokens, node } of per.values()) {
    const o = byOutcome[node.outcomeGroup!];
    o.count++;
    o.tokens += tokens;
    spent += tokens;
    const f = node.grantTokens ?? 0;
    funded += f;
    if (node.grantTokens != null && tokens > f) { overFunding.count++; overFunding.tokens += tokens - f; }
  }
  const est: SpendGrants["estimates"] = { closed: 0, inside: 0, unit: "adjusted tokens", badRanges: [] };
  for (const [id, { tokens, node }] of per) {
    const e = node.status === "closed" ? estimates.get(id) : undefined;
    const r = estimateRangeOf(e);
    if (!e || !r) continue;
    est.closed++;
    if (tokens >= r.low && tokens <= r.high) est.inside++;
    if ((e.low !== null && e.high !== null && e.low > e.high) || (e.model && e.model.low > e.model.high)) est.badRanges.push(id);
  }
  return { grants: { count: per.size, funded, spent, byOutcome, overFunding, estimates: est }, rowsSum };
}

/** The `bank.converted` event's time (migration 037, once per database), or null when the Bank was born adjusted. */
export const bankConvertedAt = (events: EventLog): string | null => events.list({ types: ["bank.converted"], limit: 1 })[0]?.ts ?? null;

/** Each directed assignment's source → the human it traces to (origin.ts `sourceOrigin`), once per distinct source. */
function directedAskers(repos: Repos): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const a of repos.assignments.where("lane = 'directed' AND sourceId IS NOT NULL")) {
    if (a.sourceId && !out.has(a.sourceId)) out.set(a.sourceId, sourceOrigin(repos, a.sourceId)?.userId ?? null);
  }
  return out;
}

/** financeSpend over the world's ledgers (Bank.spend). */
export function townSpend(repos: Repos, events: EventLog, now = new Date()): FinanceSpend {
  return financeSpend({
    sessions: repos.sessions.all(),
    assignments: repos.assignments.all(),
    agents: repos.agents.all(),
    buildings: repos.buildings.all(),
    grants: repos.grants.all(),
    keyResults: repos.keyResults.all(),
    users: repos.users.all().map((u) => ({ id: u.id, name: u.name })),
    sourceAskers: directedAskers(repos),
    convertedAt: bankConvertedAt(events),
    usage: repos.usage.all(),
    debits: repos.bankDebits.all(),
    allocations: repos.allocations.all(),
  }, townFinance(repos, now).used, now);
}
