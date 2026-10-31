import type { Allocation, BankCredit, BankDebit, BankInput, UsageEntry } from "@muster-town/schema";
import type { Repos } from "./store.ts";

const DAY_MS = 86_400_000;
/** The trailing window the daily burn is averaged over, and how far the projection looks ahead. */
export const FINANCE_BURN_DAYS = 7;
export const FINANCE_PROJECTION_DAYS = 30;
const DAYS_PER = { daily: 1, weekly: 7, monthly: 30 } as const;

/**
 * Expected adjusted tokens per day from the active recurring Bank inputs (monthly counts as 30 days; a subscription at
 * most its weekly cap / 7), rounded. Cancelled and once-only inputs count 0. An input limited to N credits counts only
 * the credits still due inside the 30-day projection: min(creditsLeft, 30 / period) × tokens / 30 (a daily key with 2
 * credits left adds 2 × tokens to the next 30 days). Bank.dailyInflow and the finance projection both use this, so
 * GET /api/bank `dailyInflowTokens` and GET /api/finance `projection.dailyInflow` match.
 */
export function dailyInflowOf(inputs: (Pick<BankInput, "tokens" | "recurrence" | "weeklyCapTokens" | "cancelledAt"> & { creditsLeft?: number | null })[]): number {
  return Math.round(inputs.reduce((s, i) => {
    if (i.cancelledAt || i.recurrence === "once") return s;
    const periods = FINANCE_PROJECTION_DAYS / DAYS_PER[i.recurrence];
    if (i.creditsLeft != null) return s + Math.min(i.creditsLeft, periods) * i.tokens / FINANCE_PROJECTION_DAYS;
    const perDay = i.tokens / DAYS_PER[i.recurrence];
    return s + (i.weeklyCapTokens ? Math.min(perDay, i.weeklyCapTokens / 7) : perDay);
  }, 0));
}

/**
 * GET /api/finance: a collective's tokens at a glance (Bank Transparency grant gr_gi5jbgzv4k, step 1). Every figure is
 * adjusted output tokens, like the Bank. The identity is `used + expired + left = total + overdrawn`: `overdrawn` is
 * usage no credit or donation has paid for yet (the pools' overshoot debt), so it is in `used` but not in `total`,
 * and `left` never goes below 0.
 */
export interface FinanceSummary {
  /** credited + donated: everything the collective has received */
  total: number;
  /** what the Bank's inputs credited (sum of the credits) */
  credited: number;
  /** what was donated straight to buildings (a retired allocation counts only what it spent, as in contributors) */
  donated: number;
  /** drawn from the Bank (its debits, overshoot included) plus spent from direct donations */
  used: number;
  usedBank: number;
  usedDonations: number;
  /** subscription credits that expired before anyone drew them (they don't roll over) */
  expired: number;
  /** what can still be spent: the Bank's balance plus unspent live donations (never negative) */
  left: number;
  leftBank: number;
  leftDonations: number;
  /** usage beyond what was received: durable debits past the durable credits, subscription credits drawn past their size, debits on deleted credits, and allocations spent past their size */
  overdrawn: number;
  /** `overdrawn` by where it sits; the four parts always sum to `overdrawn` (dc_4exx02zf9g) */
  overdrawnBreakdown: OverdrawnBreakdown;
  /** the usage ledger's all-time total; it can exceed `used` by usage nothing funds (e.g. the Town Hall's librarian) */
  usageLedger: number;
  projection: {
    days: number;
    /** average adjusted tokens used per day over the last `burnDays` days of the usage ledger */
    trailingDailyBurn: number;
    /** days the burn is averaged over: 7, or fewer (whole days, at least 1) when the ledger is younger than that */
    burnDays: number;
    projectedUse30d: number;
    /** expected adjusted tokens credited per day by active recurring inputs (dailyInflowOf; equals GET /api/bank dailyInflowTokens); one-off donations are not counted */
    dailyInflow: number;
    /** trailingDailyBurn − dailyInflow: what `left` loses per day; negative when the inflow covers the burn */
    netDailyBurn: number;
    /** dailyInflow × days */
    projectedInflow30d: number;
    /** whole days `left` lasts at netDailyBurn (floor(left / netDailyBurn)); null when the runway is "covered" or "no-usage" */
    runwayDays: number | null;
    /** why runwayDays is what it is: "covered" (inflow ≥ burn), "no-usage" (no usage in the burn window), else "days" */
    runway: "covered" | "days" | "no-usage";
  };
  /** used + expired + left − overdrawn vs total; ok when they match exactly */
  sumCheck: { ok: boolean; diff: number; identity: string };
  at: string;
}

/** The parts of `overdrawn`, each ≥ 0, summing to it exactly. */
export interface OverdrawnBreakdown {
  /** durable (permanent) debits past the durable credits: the pools' overshoot debt (dc_myhlhsevgz) */
  durableOvershoot: number;
  /** each subscription credit's debits past that credit's size (on the live town: the pre-conversion Fable draw, raw-capped credits converted by migration 037) */
  subscriptionOverdrawn: number;
  /** debits naming a credit that no longer exists */
  deletedCreditDebits: number;
  /** allocation (direct donation) spend past the allocation's size */
  allocationOverspent: number;
}

export interface FinanceInputs {
  credits: Pick<BankCredit, "id" | "tokens" | "expiresAt">[];
  debits: Pick<BankDebit, "creditId" | "tokens">[];
  allocations: Pick<Allocation, "tokens" | "spentTokens" | "retired">[];
  usage: Pick<UsageEntry, "tokens" | "createdAt">[];
  /** the Bank's inputs, for the projection's daily inflow (none: inflow 0) */
  bankInputs?: Parameters<typeof dailyInflowOf>[0];
}

/**
 * The pure aggregation behind GET /api/finance. A subscription credit (expiresAt set) is drawn from by debits naming
 * it; once expired, what wasn't drawn is `expired`, and until then it is left. Durable credits (expiresAt null) are
 * drawn by debits with creditId null; debits past them are `overdrawn` (overshoot debt), so durable left is ≥ 0.
 */
export function financeSummary(inp: FinanceInputs, now = new Date()): FinanceSummary {
  const iso = now.toISOString();
  const byCredit = new Map<string, number>();
  let durableDebits = 0, usedBank = 0;
  for (const d of inp.debits) {
    usedBank += d.tokens;
    if (d.creditId) byCredit.set(d.creditId, (byCredit.get(d.creditId) ?? 0) + d.tokens);
    else durableDebits += d.tokens;
  }
  let credited = 0, durableIn = 0, expired = 0, leftExpiring = 0;
  const ob: OverdrawnBreakdown = { durableOvershoot: 0, subscriptionOverdrawn: 0, deletedCreditDebits: 0, allocationOverspent: 0 };
  const known = new Set<string>();
  for (const c of inp.credits) {
    credited += c.tokens;
    known.add(c.id);
    if (!c.expiresAt) { durableIn += c.tokens; continue; }
    const drawn = byCredit.get(c.id) ?? 0;
    const rest = c.tokens - drawn;
    if (rest < 0) ob.subscriptionOverdrawn -= rest;
    else if (c.expiresAt > iso) leftExpiring += rest;
    else expired += rest;
  }
  // a debit naming a credit that no longer exists has nothing paying for it
  for (const [id, t] of byCredit) if (!known.has(id)) ob.deletedCreditDebits += t;
  const leftDurable = Math.max(0, durableIn - durableDebits);
  ob.durableOvershoot = Math.max(0, durableDebits - durableIn);

  let donated = 0, usedDonations = 0, leftDonations = 0;
  for (const a of inp.allocations) {
    donated += a.retired ? Math.min(a.tokens, a.spentTokens) : a.tokens;
    usedDonations += a.spentTokens;
    if (!a.retired) leftDonations += Math.max(0, a.tokens - a.spentTokens);
    ob.allocationOverspent += Math.max(0, a.spentTokens - a.tokens);
  }

  const overdrawn = ob.durableOvershoot + ob.subscriptionOverdrawn + ob.deletedCreditDebits + ob.allocationOverspent;
  const total = credited + donated;
  const used = usedBank + usedDonations;
  const leftBank = leftExpiring + leftDurable;
  const left = leftBank + leftDonations;

  let usageLedger = 0, first = Infinity, recent = 0;
  const since = now.getTime() - FINANCE_BURN_DAYS * DAY_MS;
  for (const u of inp.usage) {
    usageLedger += u.tokens;
    const t = new Date(u.createdAt).getTime();
    if (t < first) first = t;
    if (t > since && t <= now.getTime()) recent += u.tokens;
  }
  const age = Number.isFinite(first) ? Math.ceil((now.getTime() - first) / DAY_MS) : 0;
  const burnDays = Math.min(FINANCE_BURN_DAYS, Math.max(1, age));
  const trailingDailyBurn = Math.round(recent / burnDays);
  const dailyInflow = dailyInflowOf(inp.bankInputs ?? []);
  const netDailyBurn = trailingDailyBurn - dailyInflow;
  const runway = trailingDailyBurn === 0 ? "no-usage" : netDailyBurn <= 0 ? "covered" : "days";
  const runwayDays = runway === "days" ? Math.floor(left / netDailyBurn) : null;

  const diff = used + expired + left - overdrawn - total;
  return {
    total, credited, donated, used, usedBank, usedDonations, expired, left, leftBank, leftDonations, overdrawn, overdrawnBreakdown: ob, usageLedger,
    projection: { days: FINANCE_PROJECTION_DAYS, trailingDailyBurn, burnDays, projectedUse30d: trailingDailyBurn * FINANCE_PROJECTION_DAYS,
      dailyInflow, netDailyBurn, projectedInflow30d: dailyInflow * FINANCE_PROJECTION_DAYS, runwayDays, runway },
    sumCheck: { ok: diff === 0, diff, identity: "used + expired + left = total + overdrawn" },
    at: iso,
  };
}

/** financeSummary over the world's ledgers (World.finance). */
export function townFinance(repos: Repos, now = new Date()): FinanceSummary {
  return financeSummary({
    credits: repos.bankCredits.all(),
    debits: repos.bankDebits.all(),
    allocations: repos.allocations.all(),
    usage: repos.usage.all(),
    bankInputs: repos.bankInputs.all(),
  }, now);
}
