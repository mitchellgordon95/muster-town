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

/** Raw tokens per adjusted output token at the step-1 calibration: 30 (Opus and any non-Fable model) / 24 (Fable). */
export const rawPerAdjusted = (model: string | null | undefined): number => BACKFILL[backfillFamily(model)].ratio;

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

/** The token fields of a Claude Agent SDK result message that `sdkTokenCounts` reads (a loose view). */
export interface SdkUsageFields {
  /** this query's main-loop usage (Anthropic API names); `cache_creation` splits cache writes by TTL */
  usage?: Record<string, unknown>;
  /** cumulative per model id over the whole query, subagents included; no 5m / 1h split */
  modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }>;
}

/** Usage by kind: the total and per model id. */
export interface TokenUsage { counts: TokenCounts; byModel: Record<string, TokenCounts> }

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * The five counters from an SDK result message. Per model from `modelUsage` (inputTokens, outputTokens,
 * cacheReadInputTokens, cacheCreationInputTokens); without it, from `usage` (input_tokens, output_tokens,
 * cache_read_input_tokens, cache_creation_input_tokens) under the model "unknown". `modelUsage` has no TTL split, so
 * cache writes are split 5m / 1h in the ratio of `usage.cache_creation` {ephemeral_5m_input_tokens,
 * ephemeral_1h_input_tokens}; when that is missing or zero, every cache write counts as 5m.
 */
export function sdkTokenCounts(m: SdkUsageFields): TokenUsage {
  const u = m.usage ?? {};
  const cc = (u.cache_creation ?? {}) as Record<string, unknown>;
  const w5 = num(cc.ephemeral_5m_input_tokens), w1 = num(cc.ephemeral_1h_input_tokens);
  const share1h = w5 + w1 > 0 ? w1 / (w5 + w1) : 0;
  const counted = (input: number, output: number, cacheRead: number, cacheWrite: number): TokenCounts => {
    const cacheWrite1h = Math.round(cacheWrite * share1h);
    return countsOf({ input, output, cacheRead, cacheWrite5m: cacheWrite - cacheWrite1h, cacheWrite1h });
  };
  const byModel: Record<string, TokenCounts> = {};
  if (m.modelUsage && Object.keys(m.modelUsage).length) {
    for (const [model, x] of Object.entries(m.modelUsage)) {
      byModel[model] = counted(num(x.inputTokens), num(x.outputTokens), num(x.cacheReadInputTokens), num(x.cacheCreationInputTokens));
    }
  } else if (m.usage) {
    const c = counted(num(u.input_tokens), num(u.output_tokens), num(u.cache_read_input_tokens), num(u.cache_creation_input_tokens));
    if (rawTokens(c) > 0) byModel.unknown = c;
  }
  return { counts: Object.values(byModel).reduce<TokenCounts>((s, c) => addTokens(s, c), { ...ZERO_TOKENS }), byModel };
}

/** Two usages added, model by model (a session that reran adds its attempts). */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const byModel: Record<string, TokenCounts> = { ...a.byModel };
  for (const [k, c] of Object.entries(b.byModel)) byModel[k] = addTokens(byModel[k] ?? ZERO_TOKENS, c);
  return { counts: addTokens(a.counts, b.counts), byModel };
}

/** Counter by counter, the larger of two. */
export function maxTokens(a: TokenCounts, b: TokenCounts): TokenCounts {
  const out = { ...ZERO_TOKENS };
  for (const k of TOKEN_KINDS) out[k] = Math.max(a[k], b[k]);
  return out;
}

/**
 * What a session has used, given what was already booked for it (`booked`, never taken back) and a newer reading
 * (`seen`): the reading whole, with its per-model split, when it covers every booked counter (the normal case: the
 * meter only grows, and a result message's cumulative `modelUsage` includes every call the meter saw); otherwise the
 * larger of the two counter by counter, priced at the session's model (byModel empty).
 */
export function mergeUsage(booked: TokenUsage, seen: TokenUsage): TokenUsage {
  if (TOKEN_KINDS.every((k) => seen.counts[k] >= booked.counts[k])) return { counts: countsOf(seen.counts), byModel: seen.byModel };
  if (TOKEN_KINDS.every((k) => booked.counts[k] >= seen.counts[k])) return { counts: countsOf(booked.counts), byModel: booked.byModel };
  return { counts: maxTokens(countsOf(booked.counts), countsOf(seen.counts)), byModel: {} };
}

/**
 * A session's usage while it runs (1:1 mt_x40qq8poc3 decision 2: debit as the session runs), from the SDK's assistant
 * messages: one API call per `message.id`, whose blocks repeat its usage, so each counter keeps its largest value per
 * call; subagents' calls count too. The result message's cumulative figure is the true one at the end (`mergeUsage`);
 * the meter is what a session that dies before its result still has.
 */
export class UsageMeter {
  private calls = new Map<string, { model: string; counts: TokenCounts }>();
  private anon = 0;

  /** Read one SDK message; true when the usage grew. */
  observe(m: { type?: string; message?: unknown }): boolean {
    if (m.type !== "assistant" || !m.message || typeof m.message !== "object") return false;
    const msg = m.message as { id?: unknown; model?: unknown; usage?: Record<string, unknown> };
    if (!msg.usage) return false;
    const c = sdkTokenCounts({ usage: msg.usage }).counts;
    if (!rawTokens(c)) return false;
    const id = typeof msg.id === "string" && msg.id ? msg.id : `#${this.anon++}`;
    const prev = this.calls.get(id);
    const counts = prev ? maxTokens(prev.counts, c) : c;
    if (prev && TOKEN_KINDS.every((k) => counts[k] === prev.counts[k])) return false;
    this.calls.set(id, { model: typeof msg.model === "string" && msg.model ? msg.model : "unknown", counts });
    return true;
  }

  usage(): TokenUsage {
    const byModel: Record<string, TokenCounts> = {};
    for (const { model, counts } of this.calls.values()) byModel[model] = addTokens(byModel[model] ?? ZERO_TOKENS, counts);
    return { counts: Object.values(byModel).reduce<TokenCounts>((s, c) => addTokens(s, c), { ...ZERO_TOKENS }), byModel };
  }
}

/** A row whose counters are exactly the back-fill split of its raw total (no real breakdown): the drift job leaves it out. */
export function isBackfilled(c: Partial<TokenCounts>, model?: string | null): boolean {
  const k = countsOf(c), raw = rawTokens(k);
  if (!raw || k.input || k.cacheWrite5m || k.cacheWrite1h) return false;
  return k.output === splitRaw(raw, model).output;
}

/** An SDK error that means the subscription is out of quota for now (the desk fails over once; the server logs `bank.cap`). */
export const SPEND_LIMIT = /spend limit|usage limit|rate.?limit|session limit resets|monthly spend/i;
