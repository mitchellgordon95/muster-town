import { AddBankInput, CreateBankPoolInput, DEFAULT_POOL_ID, UpdateBankPoolInput, type BankCredit, type BankInput, type BankPool, type BankRecurrence, type Agent, type Building } from "@muster-town/schema";
import { badRequest, forbidden } from "./errors.ts";
import type { EventLog } from "./events.ts";
import type { Holder, Permissions } from "./permissions.ts";
import type { Repos } from "./store.ts";
import { newId, nowIso } from "./util.ts";

const DAY_MS = 86_400_000;
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
  creditedTokens: number;
  /** expected tokens per day from active recurring inputs (monthly counts as 30 days) */
  dailyInflowTokens: number;
  inputs: (BankInput & { userName: string })[];
  pools: BankPoolSummary[];
  buildings: BankBuildingShare[];
  /** top contributors by tokens given, most first (zero-token users left out) */
  contributors: BankContributor[];
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
    this.events.append({ type: "bank.input", text: `${user.name} added ${inp.label} to the Bank (${inp.tokens.toLocaleString("en-US")} tokens, ${what})`, payload: { inputId: row.id, userId, source: inp.source, recurrence: inp.recurrence, tokens: inp.tokens } });
    this.creditDue(now);
    return this.repos.bankInputs.require(row.id, "bank input");
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
      this.repos.bankCredits.upsert({ id: newId("bc"), inputId: inp.id, tokens: amount, createdAt: now.toISOString(), expiresAt });
      total += amount;
      this.events.append({ type: "bank.credited", text: `${inp.label} credited ${amount.toLocaleString("en-US")} tokens to the Bank`, payload: { inputId: inp.id, tokens: amount } });
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
   * Draw up to `tokens` for a building's session from its pool: the pool's share of expiring credits first (soonest
   * to expire first), then its durable share. Returns what's left undrawn. With `overshoot`, the rest is drawn from
   * the durable share anyway (sessions may run past what's left; there is no hard stop).
   */
  draw(buildingId: string, agentId: string, tokens: number, opts: { overshoot?: boolean; now?: Date } = {}): number {
    const now = opts.now ?? new Date();
    let left = Math.round(tokens);
    const pool = this.drawPool(buildingId);
    const frac = pool ? (this.shares().get(pool.id)?.pct ?? 0) / 100 : 0;
    if (left <= 0 || !pool || frac <= 0) return Math.max(0, left);
    const debit = (creditId: string | null, t: number) => {
      this.repos.bankDebits.upsert({ id: newId("bd"), buildingId, poolId: pool.id, agentId, creditId, tokens: t, createdAt: now.toISOString() });
      left -= t;
    };
    for (const c of this.live(now)) {
      if (!c.expiresAt || left <= 0) continue;
      const room = Math.floor(c.tokens * frac) - this.debited("poolId = ? AND creditId = ?", [pool.id, c.id]);
      if (room > 0) debit(c.id, Math.min(room, left));
    }
    const durable = this.poolAvailable(pool.id, now).durable;
    if (left > 0 && (durable > 0 || opts.overshoot)) debit(null, opts.overshoot ? left : Math.min(durable, left));
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
      dailyInflowTokens,
      inputs: inputs.map((i) => ({ ...i, userName: this.repos.users.get(i.userId)?.name ?? i.userId })),
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
    };
  }
}
