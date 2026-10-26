/**
 * Bank grant step 4 (gr_iq5m7dug56, plan dc_2uqmfdittg): calibration.
 * - Drift: once a day, per model and building, the day's sessions' adjusted output tokens × that model's output list
 *   price (TOKEN_PRICES) against the SDK's own costUsd. `bank.drift` events; GET /api/bank `drift`; the Bank page.
 * - Cap deaths: a session the desk classified as SPEND_LIMIT logs `bank.cap` with the day's adjusted spend, so step 5
 *   learns where the subscription cap actually hits.
 */
import { isBackfilled, type Session } from "@muster-town/schema";
import { adjustedOfUsage, tokenPrices } from "./bank.ts";

/** One drift row: a model in a building on a UTC day (`building` null = the model across every building). */
export interface DriftRow {
  day: string;
  /** null only on the marker row of a day with no sessions */
  model: string | null;
  building: string | null;
  /** sessions counted (back-filled ones left out) */
  sessions: number;
  /** sessions whose counters are the back-fill split of a raw total (no real breakdown): left out of the sums */
  backfilled: number;
  adjustedOutputTokens: number;
  /** adjustedOutputTokens × the model's output list price */
  adjustedUsd: number;
  /** what the SDK said those sessions cost */
  costUsd: number;
  /** adjustedUsd / costUsd: 1 = the Bank's unit prices sessions exactly; the grant's target is 0.9–1.1. null when costUsd is 0 */
  ratio: number | null;
}

export type DriftSession = Pick<Session, "model" | "input" | "output" | "cacheRead" | "cacheWrite5m" | "cacheWrite1h" | "byModel" | "costUsd"> & { buildingId: string | null };

const usd = (x: number) => Math.round(x * 1e4) / 1e4;

/** The UTC day (YYYY-MM-DD) of `d`, and the day before it. */
export const utcDay = (d: Date): string => d.toISOString().slice(0, 10);
export const previousUtcDay = (d: Date): string => utcDay(new Date(Date.parse(utcDay(d)) - 86_400_000));

/** Drift rows for `day` from its ended sessions: per (model, building), then per model over all buildings. */
export function driftRows(day: string, sessions: DriftSession[]): DriftRow[] {
  type Acc = Omit<DriftRow, "ratio">;
  const groups = new Map<string, Acc>();
  const add = (model: string, building: string | null, s: DriftSession | null, adjusted: number) => {
    const k = `${model}\u0000${building ?? ""}`;
    const g = groups.get(k) ?? { day, model, building, sessions: 0, backfilled: 0, adjustedOutputTokens: 0, adjustedUsd: 0, costUsd: 0 };
    if (!s) g.backfilled++;
    else {
      g.sessions++;
      g.adjustedOutputTokens += adjusted;
      g.adjustedUsd += (adjusted * tokenPrices(model).usdPerMTok.output) / 1e6;
      g.costUsd += s.costUsd;
    }
    groups.set(k, g);
  };
  for (const s of sessions) {
    if (!s.costUsd && !s.input && !s.output && !s.cacheRead && !s.cacheWrite5m && !s.cacheWrite1h) continue; // nothing ran
    const back = !s.byModel && isBackfilled(s, s.model);
    const adjusted = back ? 0 : adjustedOfUsage(s.model, s, s.byModel);
    for (const b of [s.buildingId, null]) add(s.model, b, back ? null : s, adjusted);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, adjustedUsd: usd(g.adjustedUsd), costUsd: usd(g.costUsd), ratio: g.costUsd > 0 ? Math.round((g.adjustedUsd / g.costUsd) * 1000) / 1000 : null }))
    .sort((a, b) => (a.model ?? "").localeCompare(b.model ?? "") || (a.building === null ? -1 : b.building === null ? 1 : a.building.localeCompare(b.building)));
}

/**
 * When the cap says it resets, as an ISO time: "… resets 11:10pm (UTC)" → the next 23:10 UTC after `at`.
 * Only a time of day in UTC is read; anything else (another zone, a date) gives null.
 */
export function parseResetsAt(message: string, at: Date): string | null {
  const m = /resets\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(?\s*(utc|gmt)\s*\)?/i.exec(message);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0), ampm = m[3]?.toLowerCase();
  if (ampm === "pm" && h < 12) h += 12;
  if (ampm === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  const t = new Date(at);
  t.setUTCHours(h, min, 0, 0);
  if (t.getTime() <= at.getTime()) t.setTime(t.getTime() + 86_400_000);
  return t.toISOString();
}
