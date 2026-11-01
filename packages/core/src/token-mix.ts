import { BACKFILL, TOKEN_KINDS, ZERO_TOKENS, addTokens, countsOf, isBackfilled, rawTokens, splitRaw, type TokenCountKind, type TokenCounts, type TokenMix } from "@muster-town/schema";

/** The mix covers the last 7 full UTC days of usage and is recomputed once per UTC day (1:1 mt_rbc3exb393). */
const MIX_WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;

const LABEL: Record<TokenCountKind, string> = { input: "input", output: "output", cacheRead: "cache read", cacheWrite5m: "cache write (5 min)", cacheWrite1h: "cache write (1 h)" };
const fmtWeight = (w: number) => String(Number(w.toPrecision(3)));

/** The conversion in words: adj. tokens = output + 0.2 × input + … (each weight = that kind's list price / the unit model's output price). */
export function mixFormula(weights: TokenCounts): string {
  return `adj. tokens = output + ${TOKEN_KINDS.filter((k) => k !== "output").map((k) => `${fmtWeight(weights[k])} × ${LABEL[k]}`).join(" + ")}`;
}

/** The window the mix for `now` covers: the 7 full UTC days before today. */
export function mixWindow(now: Date): { from: string; to: string } {
  const to = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return { from: new Date(to - MIX_WINDOW_DAYS * DAY_MS).toISOString(), to: new Date(to).toISOString() };
}

const weighted = (w: TokenCounts, c: TokenCounts): number => TOKEN_KINDS.reduce((s, k) => s + w[k] * c[k], 0);

/**
 * The adjusted-token mix from ended sessions' counters (pure). Back-filled sessions (counters that are only the step-1
 * split of a raw total) and empty ones are left out, so the mix never feeds on its own assumption. With nothing left,
 * the step-1 calibration: 30 raw tokens per adj. token, split into output + cache read.
 */
export function computeTokenMix(
  sessions: (Partial<TokenCounts> & { model: string | null })[],
  unitModel: string,
  weights: TokenCounts,
  now: Date,
): TokenMix {
  let counts: TokenCounts = { ...ZERO_TOKENS }, n = 0;
  for (const s of sessions) {
    const c = countsOf(s);
    if (!rawTokens(c) || isBackfilled(c, s.model)) continue;
    counts = addTokens(counts, c);
    n++;
  }
  const source: TokenMix["source"] = n ? "usage" : "calibration";
  if (!n) counts = splitRaw(BACKFILL.opus.ratio * 1_000_000, unitModel);
  const raw = rawTokens(counts), adjusted = weighted(weights, counts);
  const share = (f: (k: TokenCountKind) => number, total: number) =>
    Object.fromEntries(TOKEN_KINDS.map((k) => [k, total > 0 ? f(k) / total : 0])) as Record<TokenCountKind, number>;
  return {
    unitModel, weights: { ...weights }, formula: mixFormula(weights), windowDays: MIX_WINDOW_DAYS, ...mixWindow(now), computedAt: now.toISOString(), source,
    sessions: n, counts, rawTokens: raw, adjustedTokens: Math.round(adjusted),
    rawPerAdjusted: adjusted > 0 ? raw / adjusted : BACKFILL.opus.ratio,
    rawShare: share((k) => counts[k], raw),
    costShare: share((k) => weights[k] * counts[k], adjusted),
  };
}
