import type { BankCredit, BankDebit, UsageEntry } from "@muster-town/schema";

const DAY_MS = 86_400_000;
/** How many UTC days the Balance tab's "Day by day" chart covers (today included). */
export const FINANCE_DAILY_DAYS = 30;

/** One UTC day of the Bank (gr_epbcgb0hvs, kr_l0zj80iz8z). */
export interface FinanceDailyRow {
  /** the UTC day, YYYY-MM-DD */
  day: string;
  /** adj. tokens the Bank's debits drew that day (overshoot included) */
  used: number;
  /** adj. tokens the Bank's inputs credited that day (subscription and durable credits) */
  credited: number;
  /** `used` by the debit's building id; the values sum to `used` */
  byBuilding: Record<string, number>;
}

/**
 * GET /api/finance `daily`: the last `days` UTC days, oldest first, one row per day (days with nothing are rows of 0),
 * at most back to the ledger's first record (the 2026-10-27 cutoff on the live town). Built from the Bank's debits and
 * credits, which carry a date and (debits) a building: so the rows add up to the Bank's `usedBank` exactly. Spend from
 * direct donations (`usedDonations`) carries no date and is not in the rows (`undatedUsed`).
 */
export interface FinanceDaily {
  days: number;
  /** the first and last day of the window, YYYY-MM-DD */
  from: string;
  to: string;
  rows: FinanceDailyRow[];
  /** every building with use in the window, by its window total, largest first */
  buildings: { id: string; name: string; tokens: number }[];
  /** Bank debits dated before `from` (outside the window) */
  usedBefore: number;
  /** donation spend: in `used`, but dated nowhere, so in no row */
  undatedUsed: number;
  /** the usage ledger over the same window, for comparison (it can exceed the rows by usage nothing funds) */
  usageLedgerInWindow: number;
}

/** `dailyCheck`: Σ rows' used = usedBank − usedBefore (the Bank's used since the window start), and each row's buildings sum to its used. */
export interface FinanceDailyCheck { ok: boolean; diff: number; rowsUsed: number; usedSinceStart: number; buildingDiff: number; identity: string }

export interface FinanceDailyInputs {
  debits: Pick<BankDebit, "buildingId" | "tokens" | "createdAt">[];
  credits: Pick<BankCredit, "tokens" | "createdAt">[];
  usage?: Pick<UsageEntry, "tokens" | "createdAt">[];
  /** building names by id (unknown ids show as the id) */
  buildingNames?: Map<string, string>;
  /** FinanceSummary.usedBank and usedDonations: the totals the rows are checked against */
  usedBank: number;
  usedDonations: number;
}

const dayOf = (iso: string): string => iso.slice(0, 10);

/** The pure aggregation behind GET /api/finance `daily` and `dailyCheck` (Bank Transparency grant gr_epbcgb0hvs). */
export function financeDaily(inp: FinanceDailyInputs, now = new Date(), days = FINANCE_DAILY_DAYS): { daily: FinanceDaily; dailyCheck: FinanceDailyCheck } {
  const today = Date.parse(`${dayOf(now.toISOString())}T00:00:00.000Z`);
  let first = Infinity;
  for (const r of [...inp.debits, ...inp.credits]) { const t = Date.parse(r.createdAt); if (t < first) first = t; }
  const firstDay = Number.isFinite(first) ? Date.parse(`${dayOf(new Date(first).toISOString())}T00:00:00.000Z`) : today;
  const start = Math.min(today, Math.max(today - (days - 1) * DAY_MS, firstDay));
  const rows: FinanceDailyRow[] = [];
  const index = new Map<string, FinanceDailyRow>();
  for (let t = start; t <= today; t += DAY_MS) {
    const row: FinanceDailyRow = { day: dayOf(new Date(t).toISOString()), used: 0, credited: 0, byBuilding: {} };
    rows.push(row);
    index.set(row.day, row);
  }
  const from = rows[0]!.day, to = rows[rows.length - 1]!.day;

  let usedBefore = 0;
  const totals = new Map<string, number>();
  for (const d of inp.debits) {
    const day = dayOf(d.createdAt);
    if (day < from) { usedBefore += d.tokens; continue; }
    const row = index.get(day);
    if (!row) continue; // dated after today: in usedBank, in no row, so the check shows it
    row.used += d.tokens;
    row.byBuilding[d.buildingId] = (row.byBuilding[d.buildingId] ?? 0) + d.tokens;
    totals.set(d.buildingId, (totals.get(d.buildingId) ?? 0) + d.tokens);
  }
  for (const c of inp.credits) {
    const row = index.get(dayOf(c.createdAt));
    if (row) row.credited += c.tokens;
  }
  let usageLedgerInWindow = 0;
  for (const u of inp.usage ?? []) { const day = dayOf(u.createdAt); if (day >= from && day <= to) usageLedgerInWindow += u.tokens; }

  const buildings = [...totals].map(([id, tokens]) => ({ id, name: inp.buildingNames?.get(id) ?? id, tokens }))
    .sort((a, b) => b.tokens - a.tokens || a.id.localeCompare(b.id));
  const rowsUsed = rows.reduce((s, r) => s + r.used, 0);
  const buildingDiff = rows.reduce((s, r) => s + Object.values(r.byBuilding).reduce((a, b) => a + b, 0) - r.used, 0);
  const usedSinceStart = inp.usedBank - usedBefore;
  const diff = rowsUsed - usedSinceStart;
  return {
    daily: { days: rows.length, from, to, rows, buildings, usedBefore, undatedUsed: inp.usedDonations, usageLedgerInWindow },
    dailyCheck: { ok: diff === 0 && buildingDiff === 0, diff, rowsUsed, usedSinceStart, buildingDiff, identity: "Σ daily used = Bank used since the window start; each day's buildings sum to its used" },
  };
}
