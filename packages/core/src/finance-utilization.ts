import type { BankCredit, BankDebit } from "@muster-town/schema";

const DAY_MS = 86_400_000;
const dayOf = (t: number): string => new Date(t).toISOString().slice(0, 10);

/**
 * One window of GET /api/finance `utilization` (Bank Transparency grant gr_z13gmx54su, kr_c0g8tvidke): the subscription
 * credits the Bank's inputs credited in the window (by the credit's createdAt day), and what became of each one. Per
 * credit, with drawn = Σ the debits naming it: used = min(drawn, tokens); the rest is `expired` when the credit is past
 * expiresAt, else `left` (it can still be drawn until it renews). So used + expired + left = credited exactly. Draws
 * past a credit's size are not in `used` (they are /api/finance overdrawn) but are shown as `drawnPastSize`.
 * Durable (API key) credits never expire and their debits name no credit, so they are counted apart (`durable`).
 */
export interface UtilizationWindow {
  days: number;
  /** the first and last UTC day, YYYY-MM-DD: today and the days − 1 full days before it (the split's and the chart's windows) */
  from: string;
  to: string;
  /** subscription credits created in the window */
  credits: number;
  credited: number;
  used: number;
  expired: number;
  left: number;
  /** used / credited, 0..1 (4 decimals); 0 when nothing was credited */
  usedShare: number;
  expiredShare: number;
  /** debits on these credits past each credit's size (in /api/finance overdrawn, not in used) */
  drawnPastSize: number;
  /** durable (API key) credits created in the window: no expiry, outside the identity */
  durable: number;
}

export interface FinanceUtilization {
  d7: UtilizationWindow;
  d30: UtilizationWindow;
  /**
   * Per window: used + expired + left = credited (re-added from each credit), and credited + durable = Σ the daily rows'
   * credited over the same days (`dailyDiff`, filled by Bank.finance; 0 when not compared).
   */
  check: { ok: boolean; diff: number; dailyDiff: number; identity: string };
}

interface UtilizationInputs {
  credits: Pick<BankCredit, "id" | "tokens" | "createdAt" | "expiresAt">[];
  debits: Pick<BankDebit, "creditId" | "tokens">[];
}

export const UTILIZATION_IDENTITY = "used + expired + left = subscription tokens credited in the window, per credit";

const share = (part: number, whole: number): number => (whole > 0 ? Math.round((part / whole) * 10_000) / 10_000 : 0);

/** The pure aggregation behind GET /api/finance `utilization`. */
export function financeUtilization(inp: UtilizationInputs, now = new Date()): FinanceUtilization {
  const iso = now.toISOString();
  const midnight = Date.parse(`${iso.slice(0, 10)}T00:00:00.000Z`);
  const drawn = new Map<string, number>();
  for (const d of inp.debits) if (d.creditId) drawn.set(d.creditId, (drawn.get(d.creditId) ?? 0) + d.tokens);

  let diff = 0;
  const window = (n: number): UtilizationWindow => {
    const from = dayOf(midnight - (n - 1) * DAY_MS);
    const w: UtilizationWindow = { days: n, from, to: dayOf(midnight), credits: 0, credited: 0, used: 0, expired: 0, left: 0, usedShare: 0, expiredShare: 0, drawnPastSize: 0, durable: 0 };
    let leaves = 0;
    for (const c of inp.credits) {
      const day = c.createdAt.slice(0, 10);
      if (day < from || day > w.to) continue;
      if (!c.expiresAt) { w.durable += c.tokens; continue; }
      const got = drawn.get(c.id) ?? 0;
      const used = Math.min(got, c.tokens), rest = c.tokens - used;
      w.credits++;
      w.credited += c.tokens;
      w.used += used;
      w.drawnPastSize += got - used;
      if (c.expiresAt <= iso) w.expired += rest; else w.left += rest;
      leaves += used + rest;
    }
    diff += Math.abs(w.used + w.expired + w.left - w.credited) + Math.abs(leaves - w.credited);
    w.usedShare = share(w.used, w.credited);
    w.expiredShare = share(w.expired, w.credited);
    return w;
  };
  const d7 = window(7), d30 = window(30);
  return { d7, d30, check: { ok: diff === 0, diff, dailyDiff: 0, identity: UTILIZATION_IDENTITY } };
}

/** Compare each window's credited + durable with the daily rows' credited over the same days (Bank.finance). */
export function utilizationAgainstDaily(u: FinanceUtilization, rows: { day: string; credited: number }[]): FinanceUtilization {
  let dailyDiff = 0;
  for (const w of [u.d7, u.d30]) {
    const sum = rows.filter((r) => r.day >= w.from && r.day <= w.to).reduce((s, r) => s + r.credited, 0);
    dailyDiff += Math.abs(sum - (w.credited + w.durable));
  }
  return { ...u, check: { ...u.check, dailyDiff, ok: u.check.diff === 0 && dailyDiff === 0 } };
}
