import { AddBankInput, ZERO_TOKENS, addTokens, backfillFamily, oauthTokenProblem, countsOf, rawPerAdjusted, rawTokens, sliceTokens, splitRaw, subTokens, type TokenCounts, type BankCredit, type BankInput, type BankRecurrence, type FreeTokens, type Agent, type Session, type SessionView } from "@muster-town/schema";
import { CAP_THOUGHT, countDeaths, type BankDeaths } from "./caps.ts";
import { driftRows, parseResetsAt, previousUtcDay, utcDay, type DriftRow } from "./drift.ts";
import { AppError, badRequest, forbidden } from "./errors.ts";
import { dailyInflowOf, townFinance, type FinanceSummary } from "./finance.ts";
import { townSpend, type FinanceSpend } from "./finance-spend.ts";
import { townSources, type FinanceSources } from "./finance-sources.ts";
import { townFly, type FinanceFly, type FlyInputs } from "./finance-fly.ts";
import type { EventLog } from "./events.ts";
import type { Holder, Permissions } from "./permissions.ts";
import type { Repos } from "./store.ts";
import { newId, nowIso } from "./util.ts";

const DAY_MS = 86_400_000;

/** The unit every Bank figure is entered, booked and compared in (`GET /api/health` `accounting`): adjusted output tokens since step 3. */
export const BANK_ACCOUNTING = "adjusted" as const;

/**
 * The Bank's standard accounting model (1:1 mt_cyd2t5ioob decision 1, `GET /api/health` `accountingModel`): every charge
 * is booked in this model's output tokens. Each model's counters are priced at its own list price and converted at Opus
 * 5.5's output price ($20/MTok): a Fable 5.1 output token books as 2.5, a Haiku 5.5 one as 0.025, an Opus 5.5 one as 1.
 * Sessions from before migration 076 (`bankModel` NULL) stay booked in their own model's output tokens.
 */
export const BANK_MODEL = "claude-opus-5-5";

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

const isKnownModel = (model: string | null | undefined): boolean => tokenPrices(model).known;

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
 * A usage's adjusted output tokens in `unit`'s output tokens (default: `model`'s own). With a per-model breakdown each
 * model's counters are priced at that model's list price (a Fable session's Haiku subagent is priced as Haiku); without
 * one, all counters are `model`'s. The total is then converted at `unit`'s output price.
 */
export function adjustedOfUsage(model: string | null | undefined, counts: Partial<TokenCounts>, byModel?: Record<string, TokenCounts> | null, unit: string | null | undefined = model): number {
  const parts = byModel ? Object.entries(byModel) : [];
  if (!parts.length && tokenPrices(unit).family === tokenPrices(model).family) return adjustedOutputTokens(model, counts);
  const usd = parts.length ? parts.reduce((s, [m, c]) => s + listCostUsd(m, c), 0) : listCostUsd(model, counts);
  return Math.round(usd * 1e6 / tokenPrices(unit).usdPerMTok.output);
}

/** The model whose output tokens a session is booked in: `BANK_MODEL` since migration 076, its own model before. */
export const bankModelOf = (s: Pick<Session, "model" | "bankModel">): string => s.bankModel ?? s.model;

/**
 * What the Bank booked for a session, in adjusted output tokens: the one figure grant spend, goal spend, finance spend,
 * funders and caps sum. A session's ledger debits add up to it (runtime settleUsage).
 */
export function sessionTokens(s: Pick<Session, "model" | "bankModel" | "byModel"> & Partial<TokenCounts>): number {
  return adjustedOfUsage(s.model, s, s.byModel, bankModelOf(s));
}

/** A session as the API serves it: `adjustedOutputTokens` (what the Bank booked, in `bankModel`'s output tokens) next to the raw total and the five counters. */
export function sessionView(s: Session): SessionView {
  return { ...s, bankModel: bankModelOf(s), adjustedOutputTokens: sessionTokens(s) };
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
 * A charge as the Bank books it, in `BANK_MODEL`'s output tokens. Counters are priced at `model`'s list price (per model
 * with `byModel`) and converted at Opus 5.5's output price. A bare number is already Bank tokens; its counters are the
 * back-fill split (docs/bank.md) of the raw tokens of `model` that cost the same: raw = n × rawPerAdjusted(model) ×
 * Opus output price / the split family's output price (a Fable split of 1 Bank token is 24 / 2.5 = 9.6 raw).
 */
export function booked(t: number | Partial<TokenCounts> | Booked, model?: string | null, byModel?: Record<string, TokenCounts> | null): Booked {
  if (typeof t === "number") {
    const tokens = Math.max(0, Math.round(t));
    const splitModel = backfillFamily(model) === "fable" ? model : BANK_MODEL;
    const perBank = tokenPrices(BANK_MODEL).usdPerMTok.output / tokenPrices(splitModel).usdPerMTok.output;
    return { tokens, counts: splitRaw(tokens * rawPerAdjusted(model) * perBank, model) };
  }
  if ("counts" in t && typeof (t as Booked).tokens === "number") return { tokens: Math.max(0, Math.round((t as Booked).tokens)), counts: countsOf((t as Booked).counts) };
  const counts = countsOf(t as Partial<TokenCounts>);
  return { tokens: adjustedOfUsage(model, counts, byModel, BANK_MODEL), counts };
}

/** `part` adjusted tokens out of a booking, with its counters sliced in the same proportion (sliceTokens). */
export function sliceBooked(from: Booked, part: number): Booked {
  const tokens = Math.max(0, Math.min(Math.round(part), from.tokens));
  const raw = rawTokens(from.counts);
  const counts = tokens === from.tokens ? { ...from.counts } : sliceTokens(from.counts, from.tokens > 0 ? Math.round(raw * tokens / from.tokens) : 0);
  return { tokens, counts };
}

const DAYS_PER: Record<Exclude<BankRecurrence, "once">, number> = { daily: 1, weekly: 7, monthly: 30 };

/** A building's view of the Bank. */
interface BankBuildingShare {
  buildingId: string;
  name: string;
  /** what the building can still draw: the general balance (one balance, no pools) */
  expiringTokens: number;
  durableTokens: number;
  /** unspent tokens donated straight to this building (not part of the Bank; only this building draws them) */
  heldTokens: number;
  /** heldTokens by how they're paid for (retired allocations left out) */
  heldByAuth: HeldByAuth;
}

/** Unspent allocation tokens by funding mode. */
interface HeldByAuth { subscription: number; apiKey: number; donorKey: number }

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
  /** per input, also: `debitedTokens`, what grants it pays for drew from it by name; `balanceTokens`, inputBalance (member funding) */
  inputs: (BankInput & { userName: string; creditedCounts: TokenCounts; adjustedCreditedTokens: number; debitedTokens: number; balanceTokens: number })[];
  buildings: BankBuildingShare[];
  /** free tokens town-wide (the root's: docs/how-work-gets-done.md §7); null when the Bank runs without a world (tests) */
  free: FreeTokens | null;
  /** the town's operating reserve (free.reserveTokens; 0 without a world) and the town-wide free tokens (free.freeTokens) */
  reserveTokens: number;
  freeTokens: number;
  /** top contributors by tokens given, most first (zero-token users left out) */
  contributors: BankContributor[];
  /** Bank step 4: the latest drift run (adjusted output tokens × output list price vs the SDK's costUsd); null before the first */
  drift: BankDrift | null;
  /** Bank step 5: unexpected out-of-tokens deaths over the last 7 days (docs/bank.md) */
  deaths: BankDeaths;
  /** the subscription's observed cap: today's spend and whether a cap event's reset is still ahead (no learned cap, no hold) */
  cap: BankCapState;
}

/**
 * The subscription cap as observed from `bank.cap` events (GET /api/bank `cap`). Observed only: the Bank no longer learns
 * a daily cap from where sessions died or holds starts near one (removed 2026-11-01: one Fable-only limit froze the town).
 */
interface BankCapState {
  /** the subscription input (null when there is none) */
  inputId: string | null;
  /** the subscription's adjusted spend since today's window opened (00:00 UTC, or a cap reset that already passed today) */
  spentToday: number;
  windowStart: string;
  /** when the cap resets: the latest cap event's reset if still ahead, else the next 00:00 UTC */
  resetsAt: string;
  /**
   * The subscription is capped right now: the latest `bank.cap` whose reset is still ahead (or, with no reset in its
   * message, one in the current window), else null. While set, `Budget.fundingFor` hands subscription-funded sessions
   * the failover credential instead (one credential per session; the failover is the next session's pick).
   */
  cappedAt: string | null;
}

/** The latest drift run: its UTC day, the per-model rows over all buildings, and the per-building rows. */
interface BankDrift {
  day: string;
  ranAt: string;
  models: DriftRow[];
  buildings: DriftRow[];
}

/** Where a building's next draw comes from: today's subscription share (the server's own login), or an API key's input. */
type BankFunding = { kind: "expiring" } | { kind: "durable"; inputId: string | null };


/** The next renewal after `from`: one period later (a month is a calendar month). */
function advance(from: Date, recurrence: Exclude<BankRecurrence, "once">): Date {
  const d = new Date(from);
  if (recurrence === "monthly") d.setUTCMonth(d.getUTCMonth() + 1);
  else d.setTime(d.getTime() + DAYS_PER[recurrence] * DAY_MS);
  return d;
}

/**
 * The town Bank: inputs (API keys, the owner's subscription) credit one general balance, and every building draws from
 * it first come first served (pools were deleted: docs/how-work-gets-done.md §7). Earmarks are credits scoped to a goal.
 * Subscription credits expire at the next daily renewal and are spent first; API-key credits are durable. `world.bank`.
 */
/** A debit that names a durable (API-key) credit: a grant's own input paid it. It counts against durable like a general draw. */
const DURABLE_CREDIT = "creditId IN (SELECT id FROM bank_credits WHERE expiresAt IS NULL AND inputId NOT IN (SELECT id FROM bank_inputs WHERE goalId IS NOT NULL))";
/** Goal tree step 7: a credit of an earmarked input (`goalId`): only its own subtree's sessions draw on it, never the general balance. */
const EARMARKED = "inputId IN (SELECT id FROM bank_inputs WHERE goalId IS NOT NULL)";

/**
 * What a session runs on. The Bank is the only place a model credential lives (post-mortem 2026-10-30: a key in the host
 * env was billed for eight days while the town recorded the subscription): a subscription input's OAuth token, an api-key
 * input's key, or a donor's key on their allocation. Every SDK call takes exactly one; none is `NoCredential`.
 */
export interface Credential {
  kind: "subscription" | "api-key";
  /** the secret: never logged, never returned by the API */
  secret: string;
  /** the Bank input it came from; null for a donor's key (`users.apiKey`) */
  inputId: string | null;
}
/** Held: nothing in the Bank can run this session (the reason is the assignment's `heldReason`, the chat's reply). */
export class NoCredential extends AppError {
  constructor(message = NO_KEY_HOLD) { super("conflict", message); this.name = "NoCredential"; }
}
/** Why work is held when the Bank holds no credential at all (a hosted collective before its owner adds a key, a fresh town). */
export const NO_KEY_HOLD = "No credential in the Bank yet: add your Claude subscription token or an Anthropic API key at the Bank";
/**
 * Why a hosted collective's work is held when its Bank has no API key: a hosted collective (served by the hub at
 * `/<slug>/`) runs on Anthropic API keys only, never on a Claude subscription, because Anthropic's subscription terms
 * don't cover running other people's collectives on one (Mitchell, 1:1 mt_p3ge56kg03). Only the Workshop and
 * self-hosted towns may run on a subscription.
 */
export const HOSTED_KEY_ONLY_HOLD = "A hosted collective runs on an Anthropic API key only; add one at the Bank";
/** Why work is held when the subscription would pay but its input has no token. */
export const NO_TOKEN_HOLD = "The subscription input has no token: cancel it and add one with the token from `claude setup-token` at the Bank";
/** A live input holding its credential (`hasApiKey`: an api-key input's key, a subscription input's token), oldest first. */
const LIVE_KEYED = "source = ? AND hasApiKey = 1 AND cancelledAt IS NULL AND goalId IS NULL";
/** A finished work session's p90 is the expected session cost a key stream must cover (docs/goals.md "Sessions and keys"). */
export const EXPECTED_SESSION_DEFAULT = 120_000;
/** Fewer finished work sessions than this in the window: the default instead of their p90. */
const EXPECTED_SESSION_MIN_SAMPLE = 5;
/** An earmark with no draw for this many days tells its donor (in town only; 1:1 mt_kh0zaqui0w). */
export const STREAM_IDLE_DAYS = 7;

/** The p-th percentile (0..1) of `xs`, nearest rank; 0 for none. */
export function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

export class Bank {
  constructor(private repos: Repos, private events: EventLog, private permissions: Permissions) {}
  /** A hosted collective (served by the hub at `/<slug>/`): API keys only, never a subscription (`HOSTED_KEY_ONLY_HOLD`). */
  hosted(): boolean { return this.permissions.isHosted(); }
  /** the town-wide free tokens (set by the World: they need grants and the goal tree; core free-tokens.ts) */
  freeTokens?: () => FreeTokens;

  /**
   * Add an input. Anyone signed in may add an API key; only an admin (the town owner) may add a
   * subscription, since pooling other people's subscriptions isn't allowed. Credits right away if due.
   */
  addInput(userId: string, input: AddBankInput, now = new Date()): BankInput {
    const inp = AddBankInput.parse(input);
    const user = this.repos.users.require(userId, "user");
    if (inp.source === "subscription") {
      if (this.permissions.isHosted()) throw badRequest(HOSTED_KEY_ONLY_HOLD);
      if (!this.permissions.isAdmin({ kind: "user", id: userId })) throw forbidden("town.allocate_budget", "Only the town owner can add a subscription.");
      if (inp.recurrence !== "daily") throw badRequest("A subscription credits daily.");
      if (!inp.weeklyCapTokens) throw badRequest("A subscription needs weeklyCapTokens.");
      if (inp.apiKey) throw badRequest("A subscription doesn't take an API key.");
      if (!inp.token) throw badRequest("A subscription input needs its token (from `claude setup-token`): the Bank is the only place a credential lives.");
      const why = oauthTokenProblem(inp.token);
      if (why) throw badRequest(why);
    } else {
      if (!inp.apiKey) throw badRequest("An api-key input needs apiKey.");
      if (inp.token) throw badRequest("An api-key input doesn't take a subscription token.");
      if (inp.times != null && inp.recurrence === "once") throw badRequest("A one-time input credits once: `times` is for a recurring input.");
      if (inp.apiKey.trim().startsWith("sk-ant-oat")) throw badRequest("That is a Claude subscription token: add it as a subscription input instead (the API checks a key's shape: `apiKeyProblem`).");
    }
    const goalId = inp.goalId ?? null;
    if (goalId) {
      // an earmark is a donor's key scoped to a goal node; the owner's subscription stays the general balance
      if (inp.source !== "api-key") throw badRequest("Only an API-key input can be earmarked for a goal.");
      const g = this.repos.goals.get(goalId);
      if (!g || g.status !== "active") throw badRequest(`No active goal ${goalId} to earmark for.`);
    }
    const secret = inp.apiKey ?? inp.token ?? null;
    if (inp.source === "subscription" && inp.times != null) throw badRequest("A subscription credits until cancelled: `times` is for an api-key input.");
    const next = inp.recurrence === "once" ? now : inp.nextCreditAt ? new Date(inp.nextCreditAt) : now;
    const times = inp.times ?? null;
    let row = this.repos.bankInputs.upsert({
      id: newId("bi"), userId, label: inp.label, source: inp.source, model: inp.model, tokens: inp.tokens,
      recurrence: inp.recurrence, weeklyCapTokens: inp.weeklyCapTokens ?? null, nextCreditAt: next.toISOString(),
      creditedTokens: 0, hasApiKey: false, cancelledAt: null, createdAt: nowIso(), goalId, idleNotifiedAt: null,
      creditsTotal: times, creditsLeft: times,
    });
    if (secret) row = this.repos.bankInputs.setApiKey(row.id, secret);
    const what = inp.recurrence === "once" ? "once" : times ? `${inp.recurrence}, ${times} time${times === 1 ? "" : "s"}` : inp.recurrence;
    const earmark = goalId ? `, earmarked for "${this.repos.goals.get(goalId)?.text.slice(0, 60) ?? goalId}"` : "";
    this.events.append({ type: "bank.input", text: `${user.name} added ${inp.label} to the Bank (${inp.tokens.toLocaleString("en-US")} adj. tokens, ${what}${earmark})`, payload: { inputId: row.id, userId, source: inp.source, recurrence: inp.recurrence, tokens: inp.tokens, times, goalId, ...this.creditCounts(inp.tokens, inp.model), rawTokens: rawTokens(this.creditCounts(inp.tokens, inp.model)), adjustedOutputTokens: inp.tokens } });
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

  input(inputId: string): BankInput | undefined {
    return this.repos.bankInputs.get(inputId);
  }

  /** The funder filter (goal tree step 8, read-only): every input a user added, live or not, oldest first. */
  inputsOf(userId: string): BankInput[] {
    return this.repos.bankInputs.where("userId = ?", [userId], "ORDER BY createdAt, rowid");
  }

  /** Every input of one source, live or not (the funder filter's pro rata share counts subscription credits). */
  inputsOfSource(source: BankInput["source"]): BankInput[] {
    return this.repos.bankInputs.where("source = ?", [source], "ORDER BY createdAt, rowid");
  }

  /** The ids of every api-key input, live or not: a session whose credential is one ran on a donated key (step 8). */
  apiKeyInputIds(): Set<string> {
    return new Set(this.inputsOfSource("api-key").map((i) => i.id));
  }

  /** Credits made after `since` (ISO), oldest first: the funder filter's pro rata share (read-only). */
  creditsSince(since: string): BankCredit[] {
    return this.repos.bankCredits.where("createdAt > ?", [since], "ORDER BY createdAt, rowid");
  }

  /** Secret: the credential behind an input, if any (an api-key input's key, a subscription input's token). */
  apiKeyFor(inputId: string): string | null {
    return this.repos.bankInputs.getApiKey(inputId);
  }

  /** The oldest live subscription input holding its token, or null. */
  subscriptionInput(): BankInput | null {
    return this.repos.bankInputs.first(LIVE_KEYED, ["subscription"], "ORDER BY createdAt, rowid") ?? null;
  }

  /** The subscription's credential (its input's OAuth token), or null when no live subscription input holds one. */
  subscriptionCredential(): Credential | null {
    if (this.permissions.isHosted()) return null; // a hosted collective never runs on a subscription, even a stray input's
    const inp = this.subscriptionInput();
    const secret = inp ? this.apiKeyFor(inp.id) : null;
    return inp && secret ? { kind: "subscription", secret, inputId: inp.id } : null;
  }

  /** An api-key input's credential: `inputId`'s when it is live and holds its key, else the oldest live keyed api-key input's; null when none. */
  apiKeyCredential(inputId?: string | null): Credential | null {
    const inp = inputId ? this.repos.bankInputs.get(inputId) : this.liveApiKeyInput();
    if (!inp || inp.source !== "api-key" || !inp.hasApiKey || inp.cancelledAt) return null;
    const secret = this.apiKeyFor(inp.id);
    return secret ? { kind: "api-key", secret, inputId: inp.id } : null;
  }

  /** The town's one credential for a session no building funds (summaries): the subscription's, else an API key's (a hosted collective: an API key's only). Throws `NoCredential`. */
  townCredential(): Credential {
    const c = this.subscriptionCredential() ?? this.apiKeyCredential();
    if (!c) throw new NoCredential(this.permissions.isHosted() ? HOSTED_KEY_ONLY_HOLD : undefined);
    return c;
  }

  /** Tokens an input credited in the 7 days before `now`. */
  private creditedLastWeek(inputId: string, now: Date): number {
    const since = new Date(now.getTime() - 7 * DAY_MS).toISOString();
    return this.repos.bankCredits.sum("tokens", "inputId = ? AND createdAt > ?", [inputId, since]);
  }

  /**
   * Credit every input whose renewal is due (once per input per call; missed renewals while the
   * server was down are not paid twice). A subscription credits min(tokens, weekly cap left). An input limited to N
   * credits (`creditsLeft`) counts each one down and stops renewing after the last (listed, not cancelled).
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
      const creditsLeft = inp.creditsLeft == null ? null : Math.max(0, inp.creditsLeft - 1);
      let next: Date | null = null;
      if (inp.recurrence !== "once" && creditsLeft !== 0) {
        next = advance(due, inp.recurrence);
        while (next.getTime() <= now.getTime()) next = advance(next, inp.recurrence);
      }
      this.repos.bankInputs.upsert({ ...inp, nextCreditAt: next?.toISOString() ?? null, creditedTokens: inp.creditedTokens + amount, creditsLeft });
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

  /**
   * Member funding: what one input can still pay for a grant, in adjusted output tokens. Its live credits less the
   * debits that name them, plus its next credit while it hasn't credited yet (an active one-time input). The general
   * balance's anonymous durable draws are not attributed to any input, so they don't lower this.
   */
  inputBalance(inputId: string, now = new Date()): number {
    const inp = this.repos.bankInputs.require(inputId, "bank input");
    if (inp.cancelledAt) return 0;
    const left = this.inputCredits(inputId, now).reduce((s, c) => s + Math.max(0, c.tokens - this.debited("creditId = ?", [c.id])), 0);
    const pending = inp.recurrence === "once" && inp.nextCreditAt ? inp.tokens : 0;
    return left + pending;
  }

  /**
   * Member funding: the API-key input a grant's sessions run on, when the grant names its own input (`fundedWith`) and
   * that input is a live api-key input with its key and a balance left. Null otherwise (keep the general balance's choice).
   */
  grantKeyInput(grant: { fundedWith: string | null } | null | undefined, now = new Date()): BankInput | null {
    const inp = grant?.fundedWith ? this.repos.bankInputs.get(grant.fundedWith) : undefined;
    if (!inp || inp.source !== "api-key" || !inp.hasApiKey || inp.cancelledAt) return null;
    return this.inputBalance(inp.id, now) > 0 ? inp : null;
  }

  /** When a debit last named this input (its own draws: a grant's input or an earmark; general draws are anonymous), or null. */
  lastDrawAt(inputId: string): string | null {
    return this.repos.bankDebits.first("inputId = ?", [inputId], "ORDER BY createdAt DESC, rowid DESC")?.createdAt ?? null;
  }

  /**
   * Goal tree step 7: the expected cost of one session, in adjusted output tokens: the p90 of the work sessions that
   * ended in the last 7 days (the building's when given and it has enough, else the town's; a default under 5).
   */
  expectedSession(buildingId?: string | null, now = new Date()): { tokens: number; sample: number } {
    const since = new Date(now.getTime() - 7 * DAY_MS).toISOString();
    const ended = this.repos.sessions.where("purpose = 'work' AND endedAt IS NOT NULL AND endedAt > ?", [since]);
    const sizes = (rows: Session[]) => rows.map((s) => sessionTokens(s)).filter((t) => t > 0);
    if (buildingId) {
      const homes = new Set(this.repos.agents.where("homeBuildingId = ? OR buildingId = ?", [buildingId, buildingId]).map((a) => a.id));
      const own = sizes(ended.filter((s) => homes.has(s.agentId)));
      if (own.length >= EXPECTED_SESSION_MIN_SAMPLE) return { tokens: percentile(own, 0.9), sample: own.length };
    }
    const all = sizes(ended);
    return all.length >= EXPECTED_SESSION_MIN_SAMPLE ? { tokens: percentile(all, 0.9), sample: all.length } : { tokens: EXPECTED_SESSION_DEFAULT, sample: 0 };
  }

  /** Live keyed earmarks scoped to `goalId`, oldest first. */
  earmarksFor(goalId: string): BankInput[] {
    return this.repos.bankInputs.where("goalId = ? AND source = 'api-key' AND hasApiKey = 1 AND cancelledAt IS NULL", [goalId], "ORDER BY createdAt, rowid");
  }

  /** Every input with a goal scope, live or not (the streams list and the idle tick). */
  earmarks(): BankInput[] {
    return this.repos.bankInputs.where("goalId IS NOT NULL", [], "ORDER BY createdAt, rowid");
  }

  /** The streams list's rows: every live input and every earmark (a cancelled one keeps its unspent balance on show), newest first. */
  streamInputs(): BankInput[] {
    return this.repos.bankInputs.where("cancelledAt IS NULL OR goalId IS NOT NULL", [], "ORDER BY createdAt DESC, rowid DESC");
  }

  setIdleNotified(inputId: string, at: string): void {
    this.repos.bankInputs.upsert({ ...this.repos.bankInputs.require(inputId, "bank input"), idleNotifiedAt: at });
  }

  /** An input's live credits, soonest to expire first, then the durable ones oldest first. */
  private inputCredits(inputId: string, now: Date): BankCredit[] {
    return this.repos.bankCredits.where("inputId = ? AND (expiresAt IS NULL OR expiresAt > ?)", [inputId, now.toISOString()], "ORDER BY expiresAt IS NULL, expiresAt, createdAt, rowid");
  }

  /** Tokens in the Bank now: unexpired subscription credits and durable credits, less what buildings drew from them. */
  balance(now = new Date()): number {
    const { expiring, durable } = this.totals(now);
    return expiring + durable;
  }

  private live(now: Date): BankCredit[] {
    const iso = now.toISOString();
    return this.repos.bankCredits.where(`(expiresAt IS NULL OR expiresAt > ?) AND NOT ${EARMARKED}`, [iso], "ORDER BY expiresAt, createdAt, rowid");
  }

  /** Tokens debited by the rows `where` matches: one SQL SUM. (Loading the rows through the zod-parsing Table.where was ~half of
   *  the server CPU on 2026-10-31: this runs per live credit, per building, grant and lane on every runtime tick and Bank request.) */
  private debited(where: string, params: unknown[]): number {
    return this.repos.bankDebits.sum("tokens", where, params);
  }

  /** Expiring (unexpired subscription credits) and durable tokens left in the Bank. Durable can't go below 0 here. */
  private totals(now: Date): { expiring: number; durable: number } {
    let expiring = 0, durableIn = 0;
    for (const c of this.live(now)) {
      if (c.expiresAt) expiring += Math.max(0, c.tokens - this.debited("creditId = ?", [c.id]));
      else durableIn += c.tokens;
    }
    return { expiring, durable: Math.max(0, durableIn - this.debited(`creditId IS NULL OR ${DURABLE_CREDIT}`, [])) };
  }

  /**
   * What a building can still draw: the general balance. Expiring: each unexpired subscription credit less what was drawn
   * from it. Durable: all API-key credits less what was drawn from them (may be negative after an overshoot; it's paid
   * back from future credits). Zero for an unknown building.
   */
  available(buildingId: string, now = new Date()): { expiring: number; durable: number } {
    if (!this.repos.buildings.get(buildingId)) return { expiring: 0, durable: 0 };
    let expiring = 0, durableIn = 0;
    for (const c of this.live(now)) {
      if (c.expiresAt) expiring += Math.max(0, c.tokens - this.debited("creditId = ?", [c.id]));
      else durableIn += c.tokens;
    }
    return { expiring, durable: durableIn - this.debited(`creditId IS NULL OR ${DURABLE_CREDIT}`, []) };
  }

  private requireAdmin(userId: string, what: string): void {
    if (!this.permissions.isAdmin({ kind: "user", id: userId })) throw forbidden("town.allocate_budget", `Only an admin can ${what}.`);
  }

  /** Tokens the building can still draw from the Bank (never negative). */
  remaining(buildingId: string, now = new Date()): number {
    const a = this.available(buildingId, now);
    return a.expiring + Math.max(0, a.durable);
  }

  /**
   * The API-key input a subscription-funded session can fail over to when the plan hits its spend limit:
   * the oldest live api-key input with a key, if the Bank still has durable tokens (else null).
   */
  fallbackInput(buildingId: string, now = new Date()): BankInput | null {
    if (this.available(buildingId, now).durable <= 0) return null;
    return this.repos.bankInputs.first(LIVE_KEYED, ["api-key"], "ORDER BY createdAt, rowid") ?? null;
  }

  /** The oldest live api-key input that still has its key (a hosted collective without one is held: `NO_KEY_HOLD`). */
  liveApiKeyInput(): BankInput | null {
    return this.repos.bankInputs.first(LIVE_KEYED, ["api-key"], "ORDER BY createdAt, rowid") ?? null;
  }

  /** Where the building's next session should be funded from, or null when the general balance is used up. */
  fundingFor(buildingId: string, now = new Date()): BankFunding | null {
    const a = this.available(buildingId, now);
    if (a.expiring > 0) return { kind: "expiring" };
    if (a.durable <= 0) return null;
    // the oldest live api-key input that still has its key
    const input = this.liveApiKeyInput();
    return { kind: "durable", inputId: input?.id ?? null };
  }

  /**
   * Draw up to `tokens` adjusted output tokens for a building's session from the general balance: expiring credits
   * first (soonest to expire first), then durable. Returns the adjusted tokens left undrawn. With
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
    if (left.tokens <= 0 || !this.repos.buildings.get(buildingId)) return left;
    const debit = (creditId: string | null, t: number) => {
      const part = sliceBooked(left, t);
      this.repos.bankDebits.upsert({ id: newId("bd"), buildingId, agentId, creditId, inputId: null, grantId: null, ...part.counts, tokens: part.tokens, createdAt: now.toISOString() });
      left = { tokens: left.tokens - part.tokens, counts: subTokens(left.counts, part.counts) };
    };
    for (const c of this.live(now)) {
      if (!c.expiresAt || left.tokens <= 0) continue;
      const room = c.tokens - this.debited("creditId = ?", [c.id]);
      if (room > 0) debit(c.id, Math.min(room, left.tokens));
    }
    const durable = this.available(buildingId, now).durable;
    const rest = left.tokens;
    if (rest > 0 && (durable > 0 || opts.overshoot)) debit(null, opts.overshoot ? rest : Math.min(durable, rest));
    return left;
  }

  /**
   * Member funding: a session on a grant that names its own input (`fundedWith`) is paid from that input's live credits
   * first, whole credits, soonest to expire first. Each debit names the input and the grant,
   * and one `bank.debited` event says what the input paid. Returns what is left for the general balance (or an allocation) to pay.
   * Nothing is reserved: an input that runs dry just leaves the rest to the general balance.
   */
  drawFromInput(buildingId: string, agentId: string, tokens: Booked, grant: { id: string; fundedWith: string | null }, now = new Date()): Booked {
    return this.drawFromStream(buildingId, agentId, tokens, grant.fundedWith, grant.id, now);
  }

  /**
   * Draw a session's tokens from one stream's own live credits first (a grant's `fundedWith`, or the earmark the session
   * ran on: goal tree step 7's draw order), whole credits, soonest to expire first. Each debit names the input (and the
   * grant, when there is one). Returns what is left for the general balance; an earmark that runs dry just leaves the
   * rest to it (nothing is held).
   */
  drawFromStream(buildingId: string, agentId: string, tokens: Booked, inputId: string | null, grantId: string | null, now = new Date()): Booked {
    let left: Booked = { tokens: tokens.tokens, counts: countsOf(tokens.counts) };
    const inp = inputId ? this.repos.bankInputs.get(inputId) : undefined;
    const grant = { id: grantId };
    if (left.tokens <= 0 || !inp || inp.cancelledAt || !this.repos.buildings.get(buildingId)) return left;
    let paid = 0;
    for (const c of this.inputCredits(inp.id, now)) {
      if (left.tokens <= 0) break;
      const room = c.tokens - this.debited("creditId = ?", [c.id]);
      if (room <= 0) continue;
      const part = sliceBooked(left, Math.min(room, left.tokens));
      this.repos.bankDebits.upsert({ id: newId("bd"), buildingId, agentId, creditId: c.id, inputId: inp.id, grantId, ...part.counts, tokens: part.tokens, createdAt: now.toISOString() });
      left = { tokens: left.tokens - part.tokens, counts: subTokens(left.counts, part.counts) };
      paid += part.tokens;
    }
    if (paid > 0) {
      const b = this.repos.buildings.get(buildingId);
      this.events.append({
        type: "bank.debited", buildingId, agentId, text: `${inp.label} paid ${paid.toLocaleString("en-US")} adj. tokens of ${b?.name ?? buildingId}'s session ${grant.id ? `on grant ${grant.id}` : "(earmark)"}`,
        payload: { inputId: inp.id, userId: inp.userId, grantId: grant.id, goalId: inp.goalId ?? null, tokens: paid, adjustedOutputTokens: paid, leftForPool: left.tokens },
      });
    }
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
    return dailyInflowOf(this.repos.bankInputs.all());
  }

  /** GET /api/finance: received, used, expired, left, overdrawn and a 30-day projection (finance.ts). */
  finance(now = new Date()): FinanceSummary {
    return townFinance(this.repos, now);
  }

  /** GET /api/finance/spend: `used` by building → grant → assignment, from the sessions table (finance-spend.ts). */
  spend(now = new Date()): FinanceSpend {
    return townSpend(this.repos, this.events, now);
  }

  /** GET /api/finance/sources: what was received, per Bank input (with its dated credits) and per direct donation (finance-sources.ts). */
  sources(now = new Date()): FinanceSources {
    return townSources(this.repos, now);
  }

  /** GET /api/finance/fly: the Fly.io hosting estimate per day (desk sessions' wall time at the desk size's list price + the town Machine) and per building (finance-fly.ts). */
  fly(desks: FlyInputs["desks"], townOnFly: boolean, o: { capUsdPerDay?: number | null; windowDays?: number } = {}, now = new Date()): FinanceFly {
    return townFly(this.repos, desks, townOnFly, o, now);
  }

  summary(): BankSummary {
    const inputs = this.repos.bankInputs.all("ORDER BY createdAt, rowid");
    const dailyInflowTokens = this.dailyInflow();
    const creditedTokens = inputs.reduce((s, i) => s + i.creditedTokens, 0);
    const byInput = new Map<string, TokenCounts>();
    for (const c of this.repos.bankCredits.all()) byInput.set(c.inputId, addTokens(byInput.get(c.inputId) ?? ZERO_TOKENS, c));
    const now = new Date();
    const inputViews = inputs.map((i) => {
      const counts = countsOf(byInput.get(i.id) ?? ZERO_TOKENS);
      const debitedTokens = this.debited("inputId = ?", [i.id]);
      return { ...i, userName: this.repos.users.get(i.userId)?.name ?? i.userId, creditedCounts: counts, adjustedCreditedTokens: adjustedOutputTokens(i.model, counts), debitedTokens, balanceTokens: this.inputBalance(i.id, now) };
    });
    const totals = this.totals(now);
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
    const free = this.freeTokens?.() ?? null;
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
      buildings: this.repos.buildings.all().map((b) => {
        const a = this.available(b.id, now);
        return {
          buildingId: b.id, name: b.name,
          expiringTokens: a.expiring, durableTokens: a.durable, heldTokens: sum(held.get(b.id)), heldByAuth: held.get(b.id) ?? { subscription: 0, apiKey: 0, donorKey: 0 },
        };
      }),
      free,
      reserveTokens: free?.reserveTokens ?? 0,
      freeTokens: free?.freeTokens ?? 0,
      contributors: this.contributors(),
      drift: this.latestDrift(),
      deaths: this.deaths(now),
      cap: this.capState(now),
    };
  }

  // ---- Bank step 5: deaths and the observed cap (caps.ts) ----
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

  /** The observed subscription cap: today's subscription spend and whether a cap is in force; cached 30 s (recordCap clears it). */
  capState(now = new Date()): BankCapState {
    if (this.capCache && now.getTime() - this.capCache.at >= 0 && now.getTime() - this.capCache.at < 30_000) return this.capCache.state;
    const today = utcDay(now);
    const caps = this.events.list({ types: ["bank.cap"], from: new Date(now.getTime() - 15 * DAY_MS).toISOString(), desc: true, limit: 5000 });
    const midnight = `${today}T00:00:00.000Z`, nowIso = now.toISOString();
    const resets = caps.map((e) => e.payload.resetsAt).filter((r): r is string => typeof r === "string");
    // a cap that reset earlier today reopens the window; the next reset is the latest one still ahead, else next midnight
    const passed = resets.filter((r) => r > midnight && r <= nowIso).sort().pop();
    const windowStart = passed ?? midnight;
    const ahead = resets.filter((r) => r > nowIso).sort().pop();
    const resetsAt = ahead ?? new Date(Date.parse(midnight) + DAY_MS).toISOString();
    const cappedAt = caps.find((e) => (typeof e.payload.resetsAt === "string" ? e.payload.resetsAt > nowIso : e.ts >= windowStart))?.ts ?? null;
    let spentToday = 0;
    for (const s of this.repos.sessions.where("status != 'running' AND endedAt >= ?", [windowStart])) {
      if (!s.funding || s.funding === "subscription") spentToday += sessionTokens(s);
    }
    const inputId = this.repos.bankInputs.first("source = 'subscription' AND cancelledAt IS NULL", [], "ORDER BY createdAt, rowid")?.id ?? null;
    const state: BankCapState = { inputId, spentToday, windowStart, resetsAt, cappedAt };
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
   * session's booked tokens (`sessionTokens`: Opus 5.5 output tokens since migration 076); `listUsdToday` is the same at list price.
   */
  recordCap(session: Session, buildingId: string | null, message: string, at = new Date()): void {
    const day = utcDay(at);
    const today = this.repos.sessions.where("status != 'running' AND endedAt >= ?", [`${day}T00:00:00.000Z`]);
    let adjustedSpendToday = 0, subscriptionAdjustedToday = 0, listUsdToday = 0;
    for (const s of today) {
      const adj = sessionTokens(s);
      adjustedSpendToday += adj;
      if (!s.funding || s.funding === "subscription" || s.id === session.id) subscriptionAdjustedToday += adj;
      listUsdToday += (adj * tokenPrices(bankModelOf(s)).usdPerMTok.output) / 1e6;
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
