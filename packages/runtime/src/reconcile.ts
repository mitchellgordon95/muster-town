/**
 * The daily funding reconciliation's runtime half (post-mortem 2026-10-30; core `reconcile.ts` is the check): once per
 * UTC day, for the day before, read the Console's cost report with the org's Admin API key when the collective secret
 * `ANTHROPIC_ADMIN_KEY` holds one, and hand it to `reconcileFunding`, which logs the result and the alert.
 */
import { ADMIN_KEY_SECRET, previousUtcDay, reconciled, reconcileFunding, type ConsoleCost, type ReconcileResult } from "@muster-town/core";
import type { Ctx } from "./session.ts";

const DAY_MS = 86_400_000;
/** The Admin API's cost report (raw HTTP: it is not in the SDK); daily buckets, amounts as decimal strings in cents. */
export const COST_REPORT_URL = "https://api.anthropic.com/v1/organizations/cost_report";

interface CostPage { data?: { results?: { amount?: string | number; currency?: string }[] }[]; has_more?: boolean; next_page?: string | null }

/** The org's billed cost in USD for the UTC `day` (all workspaces, all cost types), summed over the report's pages. */
export async function fetchConsoleCost(adminKey: string, day: string, fetchFn: typeof fetch = fetch): Promise<number> {
  const from = `${day}T00:00:00Z`, to = `${new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10)}T00:00:00Z`;
  let cents = 0, page: string | null = null;
  for (let i = 0; i < 20; i++) {
    const q = new URLSearchParams({ starting_at: from, ending_at: to, bucket_width: "1d", ...(page ? { page } : {}) });
    const res = await fetchFn(`${COST_REPORT_URL}?${q}`, { headers: { "x-api-key": adminKey, "anthropic-version": "2023-06-01", "User-Agent": "MusterTown/1.0 (https://muster.town)" } });
    if (!res.ok) throw new Error(`cost report HTTP ${res.status}`);
    const body = (await res.json()) as CostPage;
    for (const bucket of body.data ?? []) for (const r of bucket.results ?? []) cents += Number(r.amount ?? 0) || 0;
    if (!body.has_more || !body.next_page) break;
    page = body.next_page;
  }
  return cents / 100;
}

const inFlight = new Set<string>();

/**
 * Run the day before's reconciliation once (the runtime calls this every tick). Nothing to do when it already ran, or
 * when that day had no sessions and the Bank has no Admin key (a fresh town stays quiet). The Console fetch failing
 * is recorded on the day's event, not thrown.
 */
export async function reconcileDue(ctx: Ctx, now: Date, fetchFn: typeof fetch = fetch): Promise<ReconcileResult | null> {
  const { world } = ctx;
  const day = previousUtcDay(now);
  if (inFlight.has(day) || reconciled(world, day)) return null;
  const key = world.secrets.value(ADMIN_KEY_SECRET);
  if (!key && !world.sessions.count("status != 'running' AND endedAt >= ? AND endedAt < ?", [`${day}T00:00:00.000Z`, `${now.toISOString().slice(0, 10)}T00:00:00.000Z`])) return null;
  inFlight.add(day);
  try {
    let console: ConsoleCost = null;
    if (key) {
      try { console = { usd: await fetchConsoleCost(key, day, fetchFn) }; }
      catch (e) { console = { error: e instanceof Error ? e.message : String(e) }; }
    }
    if (reconciled(world, day)) return null;
    return reconcileFunding(world, day, console);
  } finally {
    inFlight.delete(day);
  }
}
