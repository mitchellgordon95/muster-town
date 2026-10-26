import { z } from "zod";

/**
 * The five token counters the Bank books (Bank grant step 1, gr_iq5m7dug56): what the SDK reports per session,
 * kept apart because each kind costs differently. A raw total ("tokens") is always derived: their sum.
 */
export const TOKEN_KINDS = ["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"] as const;
export type TokenCountKind = (typeof TOKEN_KINDS)[number];

const count = z.number().int().nonnegative().default(0);
/** The five counters as a Zod shape, to spread into a row schema. */
export const TOKEN_COUNTS_SHAPE = { input: count, output: count, cacheRead: count, cacheWrite5m: count, cacheWrite1h: count };
export const TokenCounts = z.object(TOKEN_COUNTS_SHAPE);
export type TokenCounts = z.infer<typeof TokenCounts>;

export const ZERO_TOKENS: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };

/** The raw total: the sum of the five counters (what the Bank has always counted). */
export function rawTokens(c: Partial<TokenCounts>): number {
  return TOKEN_KINDS.reduce((s, k) => s + (c[k] ?? 0), 0);
}

/** Just the five counters of a row (rounded, never negative). */
export function countsOf(c: Partial<TokenCounts>): TokenCounts {
  const out = { ...ZERO_TOKENS };
  for (const k of TOKEN_KINDS) out[k] = Math.max(0, Math.round(c[k] ?? 0));
  return out;
}

export function addTokens(a: Partial<TokenCounts>, b: Partial<TokenCounts>): TokenCounts {
  const out = { ...ZERO_TOKENS };
  for (const k of TOKEN_KINDS) out[k] = (a[k] ?? 0) + (b[k] ?? 0);
  return out;
}

/**
 * Back-fill rule for a raw total with no breakdown (history before step 1, or a caller that only knows a total).
 * Calibration from dc_2uqmfdittg: 1 adjusted output token = 30 raw (Opus) / 24 raw (Fable); any other model counts as Opus.
 * The split is output + cache read (cache reads are most of a session's raw tokens), chosen so that step 2's adjusted
 * value (output + cacheRead × cache-read price / output price: Opus $0.20/$20 = 0.01, Fable $0.25/$50 = 0.005)
 * is exactly raw / ratio:  output = raw × (1/ratio − w) / (1 − w), cacheRead = raw − output; input and cache writes 0.
 * Opus: output = 2.357% of raw. Fable: 3.706%. The same rule is in migration 034's SQL back-fill.
 */
export const BACKFILL = {
  opus: { ratio: 30, cacheReadWeight: 0.01 },
  fable: { ratio: 24, cacheReadWeight: 0.005 },
} as const;

export function backfillFamily(model: string | null | undefined): keyof typeof BACKFILL {
  return model && /fable/i.test(model) ? "fable" : "opus";
}

export function splitRaw(raw: number, model?: string | null): TokenCounts {
  const t = Math.max(0, Math.round(raw));
  const { ratio, cacheReadWeight: w } = BACKFILL[backfillFamily(model)];
  const output = Math.round((t * (1 / ratio - w)) / (1 - w));
  return { ...ZERO_TOKENS, output, cacheRead: t - output };
}

/** Counters from either a breakdown or a bare raw total (split by `splitRaw`). */
export function toCounts(t: number | Partial<TokenCounts>, model?: string | null): TokenCounts {
  return typeof t === "number" ? splitRaw(t, model) : countsOf(t);
}

/**
 * Take `n` raw tokens out of `from`, proportionally per kind (largest remainder, so the parts sum to exactly n).
 * Splitting a breakdown across several debits this way keeps every kind's total equal to the whole's.
 */
export function sliceTokens(from: TokenCounts, n: number): TokenCounts {
  const total = rawTokens(from);
  const want = Math.max(0, Math.min(Math.round(n), total));
  if (want === total) return { ...from };
  if (want === 0 || total === 0) return { ...ZERO_TOKENS };
  const out = { ...ZERO_TOKENS };
  const rems: { k: TokenCountKind; r: number }[] = [];
  let given = 0;
  for (const k of TOKEN_KINDS) {
    const exact = (from[k] * want) / total;
    out[k] = Math.floor(exact);
    given += out[k];
    rems.push({ k, r: exact - out[k] });
  }
  rems.sort((a, b) => b.r - a.r);
  for (let i = 0; given < want; i++) {
    const { k } = rems[i % rems.length];
    if (out[k] < from[k]) { out[k]++; given++; }
  }
  return out;
}

export function subTokens(a: TokenCounts, b: TokenCounts): TokenCounts {
  const out = { ...ZERO_TOKENS };
  for (const k of TOKEN_KINDS) out[k] = a[k] - b[k];
  return out;
}
