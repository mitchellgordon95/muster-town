import { AddBankInput, CreateBankPoolInput, DEFAULT_POOL_ID, UpdateBankPoolInput, ZERO_TOKENS, addTokens, countsOf, rawPerAdjusted, rawTokens, sliceTokens, splitRaw, subTokens, type TokenCounts, type BankCredit, type BankInput, type BankPool, type BankRecurrence, type Agent, type Building, type Session, type SessionView } from "@muster-town/schema";
import { CAP_THOUGHT, TYPICAL_SESSIONS, capReason, countDeaths, learnedCap, median, nearCap, type BankDeaths } from "./caps.ts";
import { driftRows, parseResetsAt, previousUtcDay, utcDay, type DriftRow } from "./drift.ts";
import { badRequest, forbidden } from "./errors.ts";
import type { EventLog } from "./events.ts";
import type { Holder, Permissions } from "./permissions.ts";
import type { Repos } from "./store.ts";
import { newId, nowIso } from "./util.ts";

const DAY_MS = 86_400_000;

/** The unit every Bank figure is entered, booked and compared in (`GET /api/health` `accounting`): adjusted output tokens since step 3. */
export const BANK_ACCOUNTING = "adjusted" as const;

/**
 * List prices in USD per million tokens, by model family (Bank grant step 2, gr_iq5m7dug56). The one table every
 * adjusted figure reads (and step 4's drift job). Source: https://platform.claude.com/docs/en/about-claude/pricing,
 * fetched 2026-10-26. First match wins, so a newer version is listed before the family it extends. Haiku 5.5's price
 * for prompts over 100k tokens is 5× every column, so its weights are the same; the ≤100k prices are listed.
 */
export const TOKEN_PRICES: readonly { family: string; match: RegExp; usdPerMTok: TokenCounts }[] = [
  { family: "fable-5.1", match: /(fable|mythos)-5-1/, usdPerMTok: { input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 } },
  { family: "fable-5", match: /(fable|mythos)-5/, usdPerMTok: { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 } },
  { family: "opus-5.5", match: /opus-5-5/, usdPerMTok: { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 } },
  { family: "opus-5", match: /opus-(5|4-[5-9])/, usdPerMTok: { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 } },
  { family: "opus-4", match: /opus-4/, usdPerMTok: { input: 15, output: 75, cacheRead: 1.5, cacheWrite5m: 18.75, cacheWrite1h: 30 } },
  { family: "sonnet-5.5", match: /sonnet-5-5/, usdPerMTok: { input: 2, output: 10, cacheRead: 0.1, cacheWrite5m: 2.5, cacheWrite1h: 4 } },
  { family: "sonnet-5", match: /sonnet-5/, usdPerMTok: { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 } },
  { family: "sonnet-4", match: /sonnet-4/, usdPerMTok: { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 } },
  { family: "haiku-5.5", match: /haiku-5-5/, usdPerMTok: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.2 } },
  { family: "haiku-4.5", match: /haiku-4-5/, usdPerMTok: { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 } },
  { family: "haiku-3.5", match: /haiku-3|3-5-haiku/, usdPerMTok: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite5m: 1, cacheWrite1h: 1.6 } },
  // a bare alias ("opus", "fable", …) means the family's latest
  { family: "fable-5.1", match: /fable|mythos/, usdPerMTok: { input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 } },
  { family: "opus-5.5", match: /opus/, usdPerMTok: { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 } },
  { family: "sonnet-5.5", match: /sonnet/, usdPerMTok: { input: 2, output: 10, cacheRead: 0.1, cacheWrite5m: 2.5, cacheWrite1h: 4 } },
  { family: "haiku-5.5", match: /haiku/, usdPerMTok: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.2 } },
];
/** What a model nobody recognizes is priced at: Opus 5.5 (and the caller should say so: see `isKnownModel`). */
const FALLBACK_PRICE = TOKEN_PRICES[2];

/** The list prices for a model id (USD / MTok); an unknown or missing model gets Opus 5.5's. */
export function tokenPrices(model: string | null | undefined): { family: string; known: boolean; usdPerMTok: TokenCounts } {
  const m = (model ?? "").toLowerCase();
  const hit = m ? TOKEN_PRICES.find((p) => p.match.test(m)) : undefined;
  return { ...(hit ?? FALLBACK_PRICE), known: !!hit };
}

export const isKnownModel = (model: string | null | undefined): boolean => tokenPrices(model).known;

/** Each counter's weight in output tokens: its list price over the model's output price (output itself is 1). */
export function tokenWeights(model: string | null | undefined): TokenCounts {
  const p = tokenPrices(model).usdPerMTok;
  return { input: p.input / p.output, output: 1, cacheRead: p.cacheRead / p.output, cacheWrite5m: p.cacheWrite5m / p.output, cacheWrite1h: p.cacheWrite1h / p.output };
}

/**
 * Adjusted output tokens (Bank step 2): what the counters cost, in the model's output tokens.
 * output + Σ weight(model, kind) × count, rounded. Derived wherever it's shown; never stored.
 */
export function adjustedOutputTokens(model: string | null | undefined, counts: Partial<TokenCounts>): number {
  const w = tokenWeights(model), c = countsOf(counts);
  return Math.round(c.output + w.input * c.input + w.cacheRead * c.cacheRead + w.cacheWrite5m * c.cacheWrite5m + w.cacheWrite1h * c.cacheWrite1h);
}

/** What the counters cost at list price, USD. */
export function listCostUsd(model: string | null | undefined, counts: Partial<TokenCounts>): number {
  const p = tokenPrices(model).usdPerMTok, c = countsOf(counts);
  return (c.input * p.input + c.output * p.output + c.cacheRead * p.cacheRead + c.cacheWrite5m * p.cacheWrite5m + c.cacheWrite1h * p.cacheWrite1h) / 1e6;
}

/**
 * A session's (or any usage's) adjusted output tokens in `model`'s output tokens. With a per-model breakdown each model's
 * counters are priced at that model's list price (a Fable session's Haiku subagent is priced as Haiku), then converted
 * at `model`'s output price; without one, all counters are `model`'s.
 */
export function adjustedOfUsage(model: string | null | undefined, counts: Partial<TokenCounts>, byModel?: Record<string, TokenCounts> | null): number {
  const parts = byModel ? Object.entries(byModel) : [];
  if (!parts.length) return adjustedOutputTokens(model, counts);
  const out = tokenPrices(model).usdPerMTok.output;
  return Math.round(parts.reduce((s, [m, c]) => s + listCostUsd(m, c), 0) * 1e6 / out);
}

/** A session as the API serves it: `adjustedOutputTokens` next to the raw total and the five counters. */
export function sessionView(s: Session): SessionView {
  return { ...s, adjustedOutputTokens: adjustedOfUsage(s.model, s, s.byModel) };
}

/** The model ids in a usage that `TOKEN_PRICES` doesn't know (priced as Opus 5.5; worth a warning). */
export function unknownModels(model: string | null | undefined, byModel?: Record<string, TokenCounts> | null): string[] {
  const ids = byModel && Object.keys(byModel).length ? Object.keys(byModel) : [model ?? ""];
  return [...new Set(ids.filter((m) => m && !isKnownModel(m)))];
}
/**
 * What the Bank books (step 3): `tokens` in adjusted output tokens, with the five counters behind it kept alongside.
 * Every ledger row, allocation spend and agent counter is in `tokens`; the raw total is derived from `counts`.
 */
export interface Booked { tokens: number; counts: TokenCounts }

/**
 * A charge as the Bank books it. Counters are priced at `model`'s list price (per model with `byModel`); a bare number is
 * already adjusted output tokens, and its counters are the back-fill split of the raw tokens it stands for (docs/bank.md).
 */
export function booked(t: number | Partial<TokenCounts> | Booked, model?: string | null, byModel?: Record<string, TokenCounts> | null): Booked {
  if (typeof t === "number") {
    const tokens = Math.max(0, Math.round(t));
    return { tokens, counts: splitRaw(tokens * rawPerAdjusted(model), model) };
  }
  if ("counts" in t && typeof (t as Booked).tokens === "number") return { tokens: Math.max(0, Math.round((t as Booked).tokens)), counts: countsOf((t as Booked).counts) };
  const counts = countsOf(t as Partial<TokenCounts>);
  return { tokens: adjustedOfUsage(model, counts, byModel), counts };
}

/** `part` adjusted tokens out of a booking, with its counters sliced in the same proportion (sliceTokens). */
export function sliceBooked(from: Booked, part: number): Booked {
  const tokens = Math.max(0, Math.min(Math.round(part), from.tokens));
  const raw = rawTokens(from.counts);
  const counts = tokens === from.tokens ? { ...from.counts } : sliceTokens(from.counts, from.tokens > 0 ? Math.round(raw * tokens / from.tokens) : 0);
  return { tokens, counts };
}

const DAYS_PER: Record<Exclude<BankRecurrence, "once">, number> = { daily: 1, weekly: 7, monthly: 30 };

/** An accounting pool in the summary: its share of the Bank and what its buildings can still draw from it. */
export interface BankPoolSummary {
  id: string;
  name: string;
  /** effective % of the Bank */
  pct: number;
  /** false: no explicit share, so the pool splits what's left equally with the other pools */
  explicit: boolean;
  /** true for General, the default pool (can't be deleted) */
  isDefault: boolean;
  buildings: { buildingId: string; name: string }[];
  /** what the pool's buildings can still draw, shared first come first served: today's subscription share (spent first), then API-key */
  expiringTokens: number;
  durableTokens: number;
}

/** A building's view of the Bank, derived from its pool. */
export interface BankBuildingShare {
  buildingId: string;
  name: string;
  poolId: string;
  poolName: string;
  /** its pool's effective % of the Bank (0 for the Town Hall, which draws nothing from the Bank) */
  pct: number;
  /** its pool's share is explicit */
  explicit: boolean;
  /** what the building can still draw: what's left in its pool (0 for the Town Hall) */
  expiringTokens: number;
  durableTokens: number;
  /** unspent tokens donated straight to this building (not part of the Bank; only this building draws them) */
  heldTokens: number;
  /** heldTokens by how they're paid for (retired allocations left out) */
  heldByAuth: HeldByAuth;
}

/** Unspent allocation tokens by funding mode. */
export interface HeldByAuth { subscription: number; apiKey: number; donorKey: number }

/** Someone who has put tokens into the town: through Bank inputs, or donated straight to a building. */
export interface BankContributor {
  userId: string;
  name: string;
  /** bankTokens + donatedTokens */
  tokens: number;
  /** what their Bank inputs have credited so far */
  bankTokens: number;
  /** what they donated directly to buildings (retired allocations count only what they spent) */
  donatedTokens: number;
}

export interface BankSummary {
  /** tokens in the Bank: unexpired subscription credits plus API-key credits, minus what buildings drew */
  balanceTokens: number;
  /** of the balance, subscription tokens that expire at the next daily renewal (no rollover) */
  expiringTokens: number;
  durableTokens: number;
  /** unspent tokens donated straight to buildings: outside the Bank's balance, but still the town's */
  heldTokens: number;
  /** heldTokens split by funding mode: subscription vs the town's API key vs donors' own keys */
  heldByAuth: HeldByAuth;
  /** balanceTokens + heldTokens: everything the town can still spend */
  townTokens: number;
  /** what the inputs have credited, in adjusted output tokens (step 3: every Bank figure is) */
  creditedTokens: number;
  /** the raw total of the credits' counters */
  rawCreditedTokens: number;
  /** what the inputs have credited, as the five counters (sum over the credits) */
  creditedCounts: TokenCounts;
  /** the credits' counters priced at each input's model's list price (step 2's derivation; matches creditedTokens to rounding) */
  adjustedCreditedTokens: number;
  /** expected tokens per day from active recurring inputs (monthly counts as 30 days) */
  dailyInflowTokens: number;
  inputs: (BankInput & { userName: string; creditedCounts: TokenCounts; adjustedCreditedTokens: number })[];
  pools: BankPoolSummary[];
  buildings: BankBuildingShare[];
  /** top contributors by tokens given, most first (zero-token users left out) */
  contributors: BankContributor[];
  /** Bank step 4: the latest drift run (adjusted output tokens × output list price vs the SDK's costUsd); null before the first */
  drift: BankDrift | null;
  /** Bank step 5: unexpected out-of-tokens deaths over the last 7 days (docs/bank.md) */
  deaths: BankDeaths;
  /** Bank step 5: the subscription's learned daily cap and whether new subscription starts are held near it */
  cap: BankCapState;
}

/** The subscription cap as the Bank has learned it from `bank.cap` events (GET /api/bank `cap`). */
export interface BankCapState {
  /** the subscription input (null when there is none) */
  inputId: string | null;
  /** learned daily cap in adjusted output tokens; null = no cap seen yet (then nothing is held) */
  learnedCap: number | null;
  /** days with a cap event the learned cap is the median of */
  days: number;
  /** the subscription's adjusted spend since today's window opened (00:00 UTC, or a cap reset that already passed today) */
  spentToday: number;
  windowStart: string;
  /** median adjusted size of the last 50 ended sessions that used tokens (null with none) */
  typicalSession: number | null;
  /** new subscription-funded starts are held */
  held: boolean;
  reason: string | null;
  /** when the cap resets: the latest cap event's reset if still ahead, else the next 00:00 UTC */
  resetsAt: string;
}

/** The latest drift run: its UTC day, the per-model rows over all buildings, and the per-building rows. */
export interface BankDrift {
  day: string;
  ranAt: string;
  models: DriftRow[];
  buildings: DriftRow[];
}

/** Where a building's next draw comes from: today's subscription share (the server's own login), or an API key's input. */
export type BankFunding = { kind: "expiring" } | { kind: "durable"; inputId: string | null };

const round = (pct: number) => Math.round(pct * 100) / 100;

/** The next renewal after `from`: one period later (a month is a calendar month). */
function advance(from: Date, recurrence: Exclude<BankRecurrence, "once">): Date {
  const d = new Date(from);
  if (recurrence === "monthly") d.setUTCMonth(d.getUTCMonth() + 1);
  else d.setTime(d.getTime() + DAYS_PER[recurrence] * DAY_MS);
  return d;
}

/**
 * The town Bank: inputs (API keys, the owner's subscription) credit it; each accounting pool gets a % share, and
 * the buildings in a pool draw from it first come first served.
 * Subscription credits expire at the next daily renewal and are spent first; API-key credits are durable. `world.bank`.
 */
export class Bank {
  constructor(private repos: Repos, private events: EventLog, private permissions: Permissions) {}

  /**
   * Add an input. Anyone signed in may add an API key; only an admin (the town owner) may add a
   * subscription, since pooling other people's subscriptions isn't allowed. Credits right away if due.
   */
  addInput(userId: string, input: AddBankInput, now = new Date()): BankInput {
    const inp = AddBankInput.parse(input);
    const user = this.repos.users.require(userId, "user");
    if (inp.source === "subscription") {
      if (!this.permissions.isAdmin({ kind: "user", id: userId })) throw forbidden("town.allocate_budget", "Only the town owner can add a subscription.");
      if (inp.recurrence !== "daily") throw badRequest("A subscription credits daily.");
      if (!inp.weeklyCapTokens) throw badRequest("A subscription needs weeklyCapTokens.");
      if (inp.apiKey) throw badRequest("A subscription doesn't take an API key.");
    } else if (!inp.apiKey) throw badRequest("An api-key input needs apiKey.");
    const next = inp.recurrence === "once" ? now : inp.nextCreditAt ? new Date(inp.nextCreditAt) : now;
    let row = this.repos.bankInputs.upsert({
      id: newId("bi"), userId, label: inp.label, source: inp.source, model: inp.model, tokens: inp.tokens,
      recurrence: inp.recurrence, weeklyCapTokens: inp.weeklyCapTokens ?? null, nextCreditAt: next.toISOString(),
      creditedTokens: 0, hasApiKey: false, cancelledAt: null, createdAt: nowIso(),
    });
    if (inp.apiKey) row = this.repos.bankInputs.setApiKey(row.id, inp.apiKey);
    const what = inp.recurrence === "once" ? "once" : inp.recurrence;
    this.events.append({ type: "bank.input", text: `${user.name} added ${inp.label} to the Bank (${inp.tokens.toLocaleString("en-US")} adj. tokens, ${what})`, payload: { inputId: row.id, userId, source: inp.source, recurrence: inp.recurrence, tokens: inp.tokens, ...this.creditCounts(inp.tokens, inp.model), rawTokens: rawTokens(this.creditCounts(inp.tokens, inp.model)), adjustedOutputTokens: inp.tokens } });
    this.creditDue(now);
    return this.repos.bankInputs.require(row.id, "bank input");
  }

  /** The five counters behind a credit of `tokens` adjusted output tokens: the back-fill split of the raw tokens they stand for. */
  private creditCounts(tokens: number, model: string): TokenCounts {
    return splitRaw(tokens * rawPerAdjusted(model), model);
  }

  /** Stop an input's future credits and forget its key. Its owner or an admin. Past credits stay in the Bank. */
  cancelInput(userId: string, inputId: string): BankInput {
    const inp = this.repos.bankInputs.require(inputId, "bank input");
    if (inp.userId !== userId && !this.permissions.isAdmin({ kind: "user", id: userId })) throw forbidden("town.allocate_budget", "Only the input's owner or an admin can cancel it.");
    if (inp.cancelledAt) return inp;
    this.repos.bankInputs.setApiKey(inputId, null);
    const row = this.repos.bankInputs.upsert({ ...this.repos.bankInputs.require(inputId), nextCreditAt: null, cancelledAt: nowIso() });
    this.events.append({ type: "bank.input", text: `${inp.label} was cancelled`, payload: { inputId, cancelled: true } });
    return row;
  }

  /** Secret: the API key behind an input, if any. */
  apiKeyFor(inputId: string): string | null {
    return this.repos.bankInputs.getApiKey(inputId);
  }

  /** Tokens an input credited in the 7 days before `now`. */
  private creditedLastWeek(inputId: string, now: Date): number {
    const since = new Date(now.getTime() - 7 * DAY_MS).toISOString();
    return this.repos.bankCredits.where("inputId = ? AND createdAt > ?", [inputId, since]).reduce((s, c) => s + c.tokens, 0);
  }

  /**
   * Credit every input whose renewal is due (once per input per call; missed renewals while the
   * server was down are not paid twice). A subscription credits min(tokens, weekly cap left).
   * Returns the tokens credited.
   */
  creditDue(now = new Date()): number {
    let total = 0;
    for (const inp of this.repos.bankInputs.where("cancelledAt IS NULL AND nextCreditAt IS NOT NULL")) {
      const due = new Date(inp.nextCreditAt!);
      if (due.getTime() > now.getTime()) continue;
      const amount = inp.source === "subscription"
        ? Math.max(0, Math.min(inp.tokens, (inp.weeklyCapTokens ?? 0) - this.creditedLastWeek(inp.id, now)))
        : inp.tokens;
      let next: Date | null = null;
      if (inp.recurrence !== "once") {
        next = advance(due, inp.recurrence);
        while (next.getTime() <= now.getTime()) next = advance(next, inp.recurrence);
      }
      this.repos.bankInputs.upsert({ ...inp, nextCreditAt: next?.toISOString() ?? null, creditedTokens: inp.creditedTokens + amount });
      if (amount <= 0) continue;
      // a subscription's credit lasts until its next daily renewal: unused quota doesn't roll over
      const expiresAt = inp.source === "subscription" ? next?.toISOString() ?? null : null;
      // an input's size is adjusted output tokens (step 3); the counters behind it are the back-fill split (docs/bank.md)
      const counts = this.creditCounts(amount, inp.model);
      const credit = this.repos.bankCredits.upsert({ id: newId("bc"), inputId: inp.id, ...counts, tokens: amount, createdAt: now.toISOString(), expiresAt });
      total += amount;
      this.events.append({ type: "bank.credited", text: `${inp.label} credited ${amount.toLocaleString("en-US")} adj. tokens to the Bank`, payload: { inputId: inp.id, creditId: credit.id, tokens: credit.tokens, ...counts, rawTokens: credit.rawTokens, adjustedOutputTokens: credit.tokens } });
    }
    return total;
  }

  /** Tokens in the Bank now: unexpired subscription credits and durable credits, less what buildings drew from them. */
  balance(now = new Date()): number {
    const { expiring, durable } = this.totals(now);
    return expiring + durable;
  }

  private live(now: Date): BankCredit[] {
    const iso = now.toISOString();
    return this.repos.bankCredits.where("expiresAt IS NULL OR expiresAt > ?", [iso], "ORDER BY expiresAt, createdAt, rowid");
  }

  private debited(where: string, params: unknown[]): number {
    return this.repos.bankDebits.where(where, params).reduce((s, d) => s + d.tokens, 0);
  }

  /** Expiring (unexpired subscription credits) and durable tokens left in the Bank. Durable can't go below 0 here. */
  private totals(now: Date): { expiring: number; durable: number } {
    let expiring = 0, durableIn = 0;
    for (const c of this.live(now)) {
      if (c.expiresAt) expiring += Math.max(0, c.tokens - this.debited("creditId = ?", [c.id]));
      else durableIn += c.tokens;
    }
    return { expiring, durable: Math.max(0, durableIn - this.debited("creditId IS NULL", [])) };
  }

  /** Every pool, General first, then by creation. */
  listPools(): BankPool[] {
    return this.repos.bankPools.all("ORDER BY (id = 'general') DESC, createdAt, rowid");
  }

  /** The pool a building draws from (General when it has none, or its pool is gone). */
  poolOf(buildingId: string): BankPool {
    const b = this.repos.buildings.get(buildingId);
    return (b?.poolId && this.repos.bankPools.get(b.poolId)) || this.repos.bankPools.require(DEFAULT_POOL_ID, "pool");
  }

  /** Buildings in a pool (those with no pool count as General). */
  buildingsIn(poolId: string): Building[] {
    return this.repos.buildings.all().filter((b) => this.poolOf(b.id).id === poolId);
  }

  /**
   * Effective % of the Bank per pool. Explicit shares (admin-set) come first; pools without one split what's
   * left equally. A pool without an explicit share and with no building that can draw (empty, or only the
   * Town Hall) gets nothing, so no share sits unused.
   */
  shares(): Map<string, { pct: number; explicit: boolean }> {
    const out = new Map<string, { pct: number; explicit: boolean }>();
    let used = 0;
    const rest: string[] = [];
    for (const p of this.listPools()) {
      if (p.pct !== null) { out.set(p.id, { pct: p.pct, explicit: true }); used += p.pct; }
      else if (this.buildingsIn(p.id).some((b) => b.kind !== "town-hall")) rest.push(p.id);
      else out.set(p.id, { pct: 0, explicit: false });
    }
    const each = rest.length ? Math.max(0, 100 - used) / rest.length : 0;
    for (const id of rest) out.set(id, { pct: each, explicit: false });
    return out;
  }

  private requireAdmin(userId: string, what: string): void {
    if (!this.permissions.isAdmin({ kind: "user", id: userId })) throw forbidden("town.allocate_budget", `Only an admin can ${what}.`);
  }

  /** Explicit shares may not add up to more than 100. */
  private checkPct(poolId: string | null, pct: number | null): void {
    if (pct === null) return;
    const others = this.listPools().filter((p) => p.id !== poolId).reduce((s, p) => s + (p.pct ?? 0), 0);
    if (others + pct > 100) throw badRequest(`Shares would add up to ${others + pct}%; the most this pool can have is ${100 - others}%.`);
  }

  /** New pool. Admin only. */
  createPool(userId: string, input: CreateBankPoolInput): BankPool {
    this.requireAdmin(userId, "create a pool");
    const { name, pct } = CreateBankPoolInput.parse(input);
    this.checkPct(null, pct);
    const pool = this.repos.bankPools.upsert({ id: newId("pl"), name, pct, createdAt: nowIso() });
    this.events.append({ type: "bank.pool", text: `New Bank pool ${name}${pct === null ? "" : ` (${pct}%)`}`, payload: { poolId: pool.id, pct } });
    return pool;
  }

  /** Rename a pool or set (null: clear) its % of the Bank. Admin only. */
  updatePool(userId: string, poolId: string, input: UpdateBankPoolInput): BankPool {
    this.requireAdmin(userId, "change a pool");
    const cur = this.repos.bankPools.require(poolId, "pool");
    const p = UpdateBankPoolInput.parse(input);
    if (p.pct !== undefined) this.checkPct(poolId, p.pct);
    const pool = this.repos.bankPools.upsert({ ...cur, name: p.name ?? cur.name, pct: p.pct === undefined ? cur.pct : p.pct });
    const text = pool.pct === null ? `${pool.name} splits the Bank's unassigned share` : `${pool.name} gets ${pool.pct}% of the Bank`;
    this.events.append({ type: "bank.pool", text, payload: { poolId, pct: pool.pct, name: pool.name } });
    return pool;
  }

  /** Delete an empty pool. Admin only; General can't be deleted. */
  deletePool(userId: string, poolId: string): void {
    this.requireAdmin(userId, "delete a pool");
    const pool = this.repos.bankPools.require(poolId, "pool");
    if (poolId === DEFAULT_POOL_ID) throw badRequest("General is the default pool; it can't be deleted.");
    const n = this.buildingsIn(poolId).length;
    if (n) throw badRequest(`${pool.name} still has ${n} building${n === 1 ? "" : "s"}; move them out first.`);
    this.repos.bankPools.delete(poolId);
    this.events.append({ type: "bank.pool", text: `Bank pool ${pool.name} was deleted`, payload: { poolId, deleted: true } });
  }

  /** Move a building to a pool (null: General), effective at once. Admin only (`by` null: the system). */
  setBuildingPool(by: Holder | Agent | string | null, buildingId: string, poolId: string | null): Building {
    if (by !== null) {
      const holder = typeof by === "string" ? { kind: "user" as const, id: by } : by;
      if (!this.permissions.isAdmin(holder)) throw forbidden("town.allocate_budget", "Only an admin can move a building between pools.");
    }
    const b = this.repos.buildings.require(buildingId, "building");
    const pool = this.repos.bankPools.require(poolId ?? DEFAULT_POOL_ID, "pool");
    const updated = this.repos.buildings.upsert({ ...b, poolId: pool.id });
    this.events.append({ type: "bank.pool", buildingId, text: `${b.name} now draws from the ${pool.name} pool`, payload: { buildingId, poolId: pool.id } });
    return updated;
  }

  /** The pool a building may draw from, or null: the Town Hall draws nothing from the Bank (only its own allocations). */
  private drawPool(buildingId: string): BankPool | null {
    const b = this.repos.buildings.get(buildingId);
    if (!b || b.kind === "town-hall") return null;
    return this.poolOf(buildingId);
  }

  /**
   * What a pool can still draw. Expiring: its % of each unexpired subscription credit, less what its buildings
   * drew from that credit. Durable: its % of all API-key credits, less what they drew from them (may be negative
   * after an overshoot; it's paid back from future credits).
   */
  poolAvailable(poolId: string, now = new Date()): { expiring: number; durable: number } {
    const frac = (this.shares().get(poolId)?.pct ?? 0) / 100;
    let expiring = 0, durableIn = 0;
    for (const c of this.live(now)) {
      if (c.expiresAt) expiring += Math.max(0, Math.floor(c.tokens * frac) - this.debited("poolId = ? AND creditId = ?", [poolId, c.id]));
      else durableIn += c.tokens;
    }
    return { expiring, durable: Math.floor(durableIn * frac) - this.debited("poolId = ? AND creditId IS NULL", [poolId]) };
  }

  /** What a building can still draw: what's left in its pool (first come first served among the pool's buildings). */
  available(buildingId: string, now = new Date()): { expiring: number; durable: number } {
    const pool = this.drawPool(buildingId);
    return pool ? this.poolAvailable(pool.id, now) : { expiring: 0, durable: 0 };
  }

  /** Tokens the building can still draw from the Bank (never negative). */
  remaining(buildingId: string, now = new Date()): number {
    const a = this.available(buildingId, now);
    return a.expiring + Math.max(0, a.durable);
  }

  /**
   * The API-key input a subscription-funded session can fail over to when the plan hits its spend limit:
   * the oldest live api-key input with a key, if the building's pool still has durable tokens (else null).
   */
  fallbackInput(buildingId: string, now = new Date()): BankInput | null {
    if (this.available(buildingId, now).durable <= 0) return null;
    return this.repos.bankInputs.first("source = 'api-key' AND hasApiKey = 1 AND cancelledAt IS NULL", [], "ORDER BY createdAt, rowid") ?? null;
  }

  /** Where the building's next session should be funded from, or null when its pool's share is used up. */
  fundingFor(buildingId: string, now = new Date()): BankFunding | null {
    const a = this.available(buildingId, now);
    if (a.expiring > 0) return { kind: "expiring" };
    if (a.durable <= 0) return null;
    // the oldest live api-key input that still has its key
    const input = this.repos.bankInputs.first("source = 'api-key' AND hasApiKey = 1 AND cancelledAt IS NULL", [], "ORDER BY createdAt, rowid");
    return { kind: "durable", inputId: input?.id ?? null };
  }

  /**
   * Draw up to `tokens` adjusted output tokens for a building's session from its pool: the pool's share of expiring
   * credits first (soonest to expire first), then its durable share. Returns the adjusted tokens left undrawn. With
   * `overshoot`, the rest is drawn from the durable share anyway (sessions may run past what's left; there is no hard
   * stop). A bare number is adjusted output tokens; see `drawTokens` for the counters.
   */
  draw(buildingId: string, agentId: string, tokens: number | TokenCounts | Booked, opts: { overshoot?: boolean; now?: Date } = {}): number {
    return this.drawTokens(buildingId, agentId, booked(tokens), opts).tokens;
  }

  /**
   * `draw` with the counters: each debit books its adjusted size and takes the same share of every counter
   * (sliceBooked), so the debits' counters add up to what was drawn, kind by kind. Returns what is left undrawn.
   */
  drawTokens(buildingId: string, agentId: string, tokens: Booked, opts: { overshoot?: boolean; now?: Date } = {}): Booked {
    const now = opts.now ?? new Date();
    let left: Booked = { tokens: tokens.tokens, counts: countsOf(tokens.counts) };
    const pool = this.drawPool(buildingId);
    const frac = pool ? (this.shares().get(pool.id)?.pct ?? 0) / 100 : 0;
    if (left.tokens <= 0 || !pool || frac <= 0) return left;
    const debit = (creditId: string | null, t: number) => {
      const part = sliceBooked(left, t);
      this.repos.bankDebits.upsert({ id: newId("bd"), buildingId, poolId: pool.id, agentId, creditId, ...part.counts, tokens: part.tokens, createdAt: now.toISOString() });
      left = { tokens: left.tokens - part.tokens, counts: subTokens(left.counts, part.counts) };
    };
    for (const c of this.live(now)) {
      if (!c.expiresAt || left.tokens <= 0) continue;
      const room = Math.floor(c.tokens * frac) - this.debited("poolId = ? AND creditId = ?", [pool.id, c.id]);
      if (room > 0) debit(c.id, Math.min(room, left.tokens));
    }
    const durable = this.poolAvailable(pool.id, now).durable;
    const rest = left.tokens;
    if (rest > 0 && (durable > 0 || opts.overshoot)) debit(null, opts.overshoot ? rest : Math.min(durable, rest));
    return left;
  }

  /**
   * Users ranked by tokens they've put in (Bank credits plus direct donations), most first. Ties go by name.
   * A retired allocation counts only what was actually spent from it: its unspent rest never reached the town.
   */
  contributors(limit = 10): BankContributor[] {
    const credited = new Map<string, number>(), donated = new Map<string, number>();
    for (const i of this.repos.bankInputs.all()) credited.set(i.userId, (credited.get(i.userId) ?? 0) + i.creditedTokens);
    for (const a of this.repos.allocations.all()) {
      donated.set(a.userId, (donated.get(a.userId) ?? 0) + (a.retired ? Math.min(a.tokens, a.spentTokens) : a.tokens));
    }
    return this.repos.users.all()
      .map((u) => {
        const bankTokens = credited.get(u.id) ?? 0, donatedTokens = donated.get(u.id) ?? 0;
        return { userId: u.id, name: u.name, tokens: bankTokens + donatedTokens, bankTokens, donatedTokens };
      })
      .filter((c) => c.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name))
      .slice(0, limit);
  }

  /** Expected tokens per day from active recurring inputs (monthly counts as 30 days; a subscription at most its weekly cap / 7). */
  dailyInflow(): number {
    return Math.round(this.repos.bankInputs.all().reduce((s, i) => {
      if (i.cancelledAt || i.recurrence === "once") return s;
      const perDay = i.tokens / DAYS_PER[i.recurrence];
      return s + (i.weeklyCapTokens ? Math.min(perDay, i.weeklyCapTokens / 7) : perDay);
    }, 0));
  }

  /** A pool's share of the daily inflow (0 for a pool with no share). */
  poolDailyInflow(poolId: string): number {
    return Math.floor(this.dailyInflow() * (this.shares().get(poolId)?.pct ?? 0) / 100);
  }

  summary(): BankSummary {
    const inputs = this.repos.bankInputs.all("ORDER BY createdAt, rowid");
    const dailyInflowTokens = this.dailyInflow();
    const creditedTokens = inputs.reduce((s, i) => s + i.creditedTokens, 0);
    const byInput = new Map<string, TokenCounts>();
    for (const c of this.repos.bankCredits.all()) byInput.set(c.inputId, addTokens(byInput.get(c.inputId) ?? ZERO_TOKENS, c));
    const inputViews = inputs.map((i) => {
      const counts = countsOf(byInput.get(i.id) ?? ZERO_TOKENS);
      return { ...i, userName: this.repos.users.get(i.userId)?.name ?? i.userId, creditedCounts: counts, adjustedCreditedTokens: adjustedOutputTokens(i.model, counts) };
    });
    const now = new Date();
    const totals = this.totals(now);
    const shares = this.shares();
    const held = new Map<string, HeldByAuth>();
    const total: HeldByAuth = { subscription: 0, apiKey: 0, donorKey: 0 };
    const key = { subscription: "subscription", "api-key": "apiKey", "donor-key": "donorKey" } as const;
    for (const a of this.repos.allocations.where("retired = 0")) {
      const h = held.get(a.buildingId) ?? { subscription: 0, apiKey: 0, donorKey: 0 };
      const left = Math.max(0, a.tokens - a.spentTokens);
      h[key[a.auth]] += left;
      total[key[a.auth]] += left;
      held.set(a.buildingId, h);
    }
    const sum = (h?: HeldByAuth) => (h ? h.subscription + h.apiKey + h.donorKey : 0);
    const heldTokens = sum(total);
    return {
      balanceTokens: totals.expiring + totals.durable,
      heldTokens,
      heldByAuth: total,
      townTokens: totals.expiring + totals.durable + heldTokens,
      expiringTokens: totals.expiring,
      durableTokens: totals.durable,
      creditedTokens,
      creditedCounts: inputViews.reduce<TokenCounts>((s, i) => addTokens(s, i.creditedCounts), { ...ZERO_TOKENS }),
      adjustedCreditedTokens: inputViews.reduce((s, i) => s + i.adjustedCreditedTokens, 0),
      rawCreditedTokens: inputViews.reduce((s, i) => s + rawTokens(i.creditedCounts), 0),
      dailyInflowTokens,
      inputs: inputViews,
      pools: this.listPools().map((p) => {
        const s = shares.get(p.id) ?? { pct: 0, explicit: false };
        const a = this.poolAvailable(p.id, now);
        const buildings = this.buildingsIn(p.id).map((b) => ({ buildingId: b.id, name: b.name }));
        return { id: p.id, name: p.name, pct: round(s.pct), explicit: s.explicit, isDefault: p.id === DEFAULT_POOL_ID, buildings, expiringTokens: a.expiring, durableTokens: a.durable };
      }),
      buildings: this.repos.buildings.all().map((b) => {
        const pool = this.poolOf(b.id);
        const draws = !!this.drawPool(b.id);
        const s = shares.get(pool.id) ?? { pct: 0, explicit: false };
        const a = this.available(b.id, now);
        return {
          buildingId: b.id, name: b.name, poolId: pool.id, poolName: pool.name, pct: draws ? round(s.pct) : 0, explicit: s.explicit,
          expiringTokens: a.expiring, durableTokens: a.durable, heldTokens: sum(held.get(b.id)), heldByAuth: held.get(b.id) ?? { subscription: 0, apiKey: 0, donorKey: 0 },
        };
      }),
      contributors: this.contributors(),
      drift: this.latestDrift(),
      deaths: this.deaths(now),
      cap: this.capState(now),
    };
  }

  // ---- Bank step 5: deaths and the cap hold (caps.ts) ----
  /** Unexpected out-of-tokens deaths over the 7 days before `now` (definition in caps.ts and docs/bank.md). */
  deaths(now = new Date()): BankDeaths {
    const from = new Date(now.getTime() - 7 * DAY_MS).toISOString();
    const evs = [
      ...this.events.list({ types: ["bank.cap", "budget.exhausted"], from, limit: 5000 }),
      ...this.events.list({ types: ["session.ended"], from, payloadKey: "error", limit: 5000 }),
      ...this.events.list({ types: ["agent.thought"], from, textLike: "You've hit your%", limit: 5000 }).filter((e) => CAP_THOUGHT.test(e.text)),
    ];
    return countDeaths(evs, now);
  }

  private capCache: { at: number; state: BankCapState } | null = null;
  /** the day the `bank.hold` event was last logged (once per day) */
  private holdDay: string | null = null;

  /** The learned subscription cap and whether starts are held near it; cached 30 s (recordCap clears it). */
  capState(now = new Date()): BankCapState {
    if (this.capCache && now.getTime() - this.capCache.at >= 0 && now.getTime() - this.capCache.at < 30_000) return this.capCache.state;
    const today = utcDay(now);
    const caps = this.events.list({ types: ["bank.cap"], from: new Date(now.getTime() - 15 * DAY_MS).toISOString(), desc: true, limit: 5000 });
    const learned = learnedCap(caps.map((e) => ({ day: String(e.payload.day ?? e.ts.slice(0, 10)), subscriptionAdjustedToday: Number(e.payload.subscriptionAdjustedToday ?? e.payload.adjustedSpendToday ?? 0) })), today);
    const midnight = `${today}T00:00:00.000Z`, nowIso = now.toISOString();
    const resets = caps.map((e) => e.payload.resetsAt).filter((r): r is string => typeof r === "string");
    // a cap that reset earlier today reopens the window; the next reset is the latest one still ahead, else next midnight
    const passed = resets.filter((r) => r > midnight && r <= nowIso).sort().pop();
    const windowStart = passed ?? midnight;
    const ahead = resets.filter((r) => r > nowIso).sort().pop();
    const resetsAt = ahead ?? new Date(Date.parse(midnight) + DAY_MS).toISOString();
    let spentToday = 0;
    for (const s of this.repos.sessions.where("status != 'running' AND endedAt >= ?", [windowStart])) {
      if (!s.funding || s.funding === "subscription") spentToday += adjustedOfUsage(s.model, s, s.byModel);
    }
    const recent = this.repos.sessions.where("status != 'running' AND tokens > 0", [], `ORDER BY endedAt DESC LIMIT ${TYPICAL_SESSIONS}`);
    const typicalSession = median(recent.map((s) => adjustedOfUsage(s.model, s, s.byModel)));
    const held = nearCap(spentToday, learned?.cap ?? null, typicalSession);
    const reason = held && learned ? capReason(spentToday, learned.cap, resetsAt) : null;
    const inputId = this.repos.bankInputs.first("source = 'subscription' AND cancelledAt IS NULL", [], "ORDER BY createdAt, rowid")?.id ?? null;
    const state: BankCapState = { inputId, learnedCap: learned?.cap ?? null, days: learned?.days ?? 0, spentToday, windowStart, typicalSession, held, reason, resetsAt };
    if (held && this.holdDay !== today && !this.events.list({ types: ["bank.hold"], from: midnight, limit: 1 }).length) {
      this.holdDay = today;
      this.events.append({ type: "bank.hold", text: `Bank: new subscription starts held, ${reason}`, payload: { ...state } });
    }
    this.capCache = { at: now.getTime(), state };
    return state;
  }

  // ---- Bank step 4: calibration ----
  /** the last day driftDue checked (it runs every tick; the event log is read once per day) */
  private driftDay: string | null = null;

  /** Run the drift job for the UTC day before `now` unless it already ran for it (the runtime calls this every tick). */
  driftDue(now = new Date()): DriftRow[] | null {
    const day = previousUtcDay(now);
    if (this.driftDay === day) return null;
    this.driftDay = day;
    if (this.events.list({ types: ["bank.drift"], desc: true, limit: 500 }).some((e) => e.payload.day === day && !e.payload.manual)) return null;
    return this.runDrift(day);
  }

  /** An admin runs the drift job by hand (POST /api/bank/drift): any day, today's so far included; marked `manual`, so the nightly run still happens. */
  runDriftByHand(userId: string, day: string): DriftRow[] {
    this.requireAdmin(userId, "run the drift job");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day))) throw badRequest("day must be YYYY-MM-DD");
    return this.runDrift(day, true);
  }

  /**
   * The drift job for one UTC day: per model and building, the day's ended sessions' adjusted output tokens × the model's
   * output list price against the SDK's costUsd. One `bank.drift` event per row; a day with no sessions writes one marker
   * row (model null) so the day counts as done. Back-filled sessions are counted apart and left out of the sums.
   */
  runDrift(day: string, manual = false): DriftRow[] {
    const from = `${day}T00:00:00.000Z`, to = new Date(Date.parse(from) + DAY_MS).toISOString();
    const sessions = this.repos.sessions.where("status != 'running' AND endedAt >= ? AND endedAt < ?", [from, to]).map((s) => {
      const a = this.repos.agents.get(s.agentId);
      return { ...s, buildingId: a ? a.homeBuildingId ?? a.buildingId ?? null : null };
    });
    let rows = driftRows(day, sessions);
    if (!rows.length) rows = [{ day, model: null, building: null, sessions: 0, backfilled: 0, adjustedOutputTokens: 0, adjustedUsd: 0, costUsd: 0, ratio: null }];
    for (const r of rows) {
      const what = r.model === null ? "no sessions" : `${r.model}${r.building ? ` in ${this.repos.buildings.get(r.building)?.name ?? r.building}` : " (all buildings)"}: ${r.ratio === null ? "no SDK cost" : `ratio ${r.ratio.toFixed(3)}`} ($${r.adjustedUsd.toFixed(2)} adjusted vs $${r.costUsd.toFixed(2)} SDK, ${r.sessions} session${r.sessions === 1 ? "" : "s"}${r.backfilled ? `, ${r.backfilled} back-filled left out` : ""})`;
      this.events.append({ type: "bank.drift", buildingId: r.building, text: `Bank drift ${day}${manual ? " (by hand)" : ""}, ${what}`, payload: { ...r, ...(manual ? { manual: true } : {}) } });
    }
    return rows;
  }

  /** The newest drift run's rows (GET /api/bank `drift`). */
  latestDrift(): BankDrift | null {
    const last = this.events.list({ types: ["bank.drift"], desc: true, limit: 1 })[0];
    if (!last) return null;
    const day = String(last.payload.day);
    const evs = this.events.list({ types: ["bank.drift"], desc: true, limit: 500 }).filter((e) => e.payload.day === day);
    const rows = evs.map((e) => e.payload as unknown as DriftRow).filter((r) => r.model !== null).reverse();
    return { day, ranAt: evs[evs.length - 1]?.ts ?? last.ts, models: rows.filter((r) => r.building === null), buildings: rows.filter((r) => r.building !== null) };
  }

  /**
   * A session died on the subscription cap (the desk read the SDK's result as SPEND_LIMIT): log `bank.cap` with the UTC
   * day's spend so far, so the cap's real daily size is learned from where it hits. `adjustedSpendToday` sums each ended
   * session's adjusted output tokens (in its own model's output tokens); `listUsdToday` is the same at list price.
   */
  recordCap(session: Session, buildingId: string | null, message: string, at = new Date()): void {
    const day = utcDay(at);
    const today = this.repos.sessions.where("status != 'running' AND endedAt >= ?", [`${day}T00:00:00.000Z`]);
    let adjustedSpendToday = 0, subscriptionAdjustedToday = 0, listUsdToday = 0;
    for (const s of today) {
      const adj = adjustedOfUsage(s.model, s, s.byModel);
      adjustedSpendToday += adj;
      if (!s.funding || s.funding === "subscription" || s.id === session.id) subscriptionAdjustedToday += adj;
      listUsdToday += (adj * tokenPrices(s.model).usdPerMTok.output) / 1e6;
    }
    const input = this.repos.bankInputs.first("source = 'subscription' AND cancelledAt IS NULL", [], "ORDER BY createdAt, rowid")?.id ?? null;
    const resetsAt = parseResetsAt(message, at);
    this.capCache = null;
    const agent = this.repos.agents.get(session.agentId);
    this.events.append({
      type: "bank.cap", agentId: session.agentId, buildingId,
      text: `${agent?.name ?? session.agentId} hit the subscription cap at ${adjustedSpendToday.toLocaleString("en-US")} adjusted output tokens today ($${listUsdToday.toFixed(2)} at list price)${resetsAt ? `; resets ${resetsAt}` : ""}`,
      payload: { sessionId: session.id, building: buildingId, input, day, adjustedSpendToday, subscriptionAdjustedToday, listUsdToday: Math.round(listUsdToday * 100) / 100, sessionsToday: today.length, funding: session.funding ?? null, message: message.slice(0, 2000), resetsAt },
    });
  }
}
