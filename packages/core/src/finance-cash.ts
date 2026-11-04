import type { BankFee, BankInput, Session } from "@muster-town/schema";
import { cents, sessionListUsd, type FinanceSession } from "./finance.ts";
import type { FinanceFly } from "./finance-fly.ts";

/**
 * GET /api/finance `cash` (gr_qggxximtru step 2, kr_ruh7apqptm): what running the collective cost in cash over the last
 * 30 days, next to what the same work is worth at API list price. Read-only over the ledgers: nothing here charges.
 *
 * The window is the 30 × 24 h ending now. Three parts, in US dollars:
 * - plans: each plan fee (bank_fees, "Plans paid for" on Inputs) × the share of a 30-day month it was active inside the
 *   window: usdPerMonth × activeMs / 30 days. A fee is active from its first day 00:00 UTC to the end of its last day
 *   (none: still active).
 * - apiKeys: the sessions started in the window that ran on an API-key credential (`credentialInputId` names an input
 *   whose source is api-key), each at API list price (`sessionListUsd`, the price GET /api/finance `usd.used` uses):
 *   Anthropic bills an API key per token at that price.
 * - hosting: the Fly.io estimate of GET /api/finance/fly (finance-fly.ts) over the same window; the day the window starts
 *   in counts by the share of it inside the window. A hosted collective counts its desks only (financeFly's townPaidBy).
 *
 * listUsd is the list-price value of all sessions started in the window; perDollar = listUsd / total (null when total is 0).
 */
export interface FinanceCash {
  windowDays: number;
  from: string;
  to: string;
  plans: number;
  apiKeys: number;
  hosting: number;
  /** plans + apiKeys + hosting, from the rounded parts */
  total: number;
  /** list-price value of the work used in the window (sessions started in it) */
  listUsd: number;
  /** listUsd / total, 2 decimals; null when nothing was paid */
  perDollar: number | null;
  /** each plan fee active in the window and its prorated dollars */
  planRows: { id: string; label: string; usdPerMonth: number; activeDays: number; usd: number }[];
  /** sessions started in the window on an API-key credential */
  apiKeySessions: number;
  pricedAt: "cash";
}

export interface CashCheck { ok: boolean; diff: number; text: string }

export interface CashInputs {
  fees: Pick<BankFee, "id" | "label" | "usdPerMonth" | "fromDate" | "toDate">[];
  sessions: (FinanceSession & Pick<Session, "startedAt"> & { credentialInputId?: string | null })[];
  inputs: Pick<BankInput, "id" | "source">[];
  /** GET /api/finance/fly's days (at least 31 back, so the window's first day is covered) */
  fly: Pick<FinanceFly, "days">;
}

export const CASH_WINDOW_DAYS = 30;
/** How many Fly days the cash window needs: 30 × 24 h ending now touches 31 UTC days. */
export const CASH_FLY_DAYS = CASH_WINDOW_DAYS + 1;
export const CASH_IDENTITY = "plans + API keys + hosting = total";
const DAY_MS = 86_400_000;
const MONTH_MS = CASH_WINDOW_DAYS * DAY_MS;
const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/** The pure aggregation behind GET /api/finance `cash`. */
export function financeCash(inp: CashInputs, now = new Date()): FinanceCash {
  const to = now.getTime();
  const from = to - CASH_WINDOW_DAYS * DAY_MS;

  let plans = 0;
  const planRows: FinanceCash["planRows"] = [];
  for (const f of inp.fees) {
    const start = Date.parse(`${f.fromDate}T00:00:00.000Z`);
    const end = f.toDate ? Date.parse(`${f.toDate}T00:00:00.000Z`) + DAY_MS : Infinity;
    const ms = overlap(start, end, from, to);
    if (ms <= 0) continue;
    const usd = (f.usdPerMonth * ms) / MONTH_MS;
    plans += usd;
    planRows.push({ id: f.id, label: f.label, usdPerMonth: f.usdPerMonth, activeDays: Math.round((ms / DAY_MS) * 100) / 100, usd: cents(usd) });
  }

  const apiKeyInputs = new Set(inp.inputs.filter((i) => i.source === "api-key").map((i) => i.id));
  let apiKeys = 0, listUsd = 0, apiKeySessions = 0;
  for (const s of inp.sessions) {
    const t = Date.parse(s.startedAt);
    if (!(t >= from && t <= to)) continue;
    const usd = sessionListUsd(s);
    listUsd += usd;
    if (s.credentialInputId && apiKeyInputs.has(s.credentialInputId)) { apiKeys += usd; apiKeySessions++; }
  }

  let hosting = 0;
  for (const d of inp.fly.days) {
    const d0 = Date.parse(`${d.day}T00:00:00.000Z`);
    const d1 = Math.min(d0 + DAY_MS, to);
    if (d1 <= d0) continue;
    hosting += (d.totalUsd * overlap(d0, d1, from, to)) / (d1 - d0);
  }

  const p = cents(plans), a = cents(apiKeys), h = cents(hosting);
  const total = cents(p + a + h);
  const list = cents(listUsd);
  return {
    windowDays: CASH_WINDOW_DAYS, from: new Date(from).toISOString(), to: now.toISOString(),
    plans: p, apiKeys: a, hosting: h, total, listUsd: list,
    perDollar: total > 0 ? Math.round((list / total) * 100) / 100 : null,
    planRows, apiKeySessions, pricedAt: "cash",
  };
}

/** The cash sum check: plans + apiKeys + hosting = total within $0.01. */
export function cashCheck(c: Pick<FinanceCash, "plans" | "apiKeys" | "hosting" | "total">): CashCheck {
  const diff = cents(c.plans + c.apiKeys + c.hosting - c.total);
  const ok = Math.abs(diff) <= 0.01;
  return { ok, diff, text: ok ? `${CASH_IDENTITY}: $${c.total.toFixed(2)}` : `${CASH_IDENTITY} is off by $${diff.toFixed(2)}` };
}
