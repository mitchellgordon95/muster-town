import { AddBankInput, SetBankShareInput, type BankCredit, type BankInput, type BankRecurrence } from "@muster-town/schema";
import { badRequest, forbidden } from "./errors.ts";
import type { EventLog } from "./events.ts";
import type { Permissions } from "./permissions.ts";
import type { Repos } from "./store.ts";
import { newId, nowIso } from "./util.ts";

const DAY_MS = 86_400_000;
const DAYS_PER: Record<Exclude<BankRecurrence, "once">, number> = { daily: 1, weekly: 7, monthly: 30 };

export interface BankBuildingShare {
  buildingId: string;
  name: string;
  /** effective % of the Bank */
  pct: number;
  /** false: no explicit share, so the building splits what's left equally with the other labs */
  explicit: boolean;
  /** what the building can still draw: today's subscription share (spent first), then its API-key share */
  expiringTokens: number;
  durableTokens: number;
  /** unspent tokens donated straight to this building (not part of the Bank; only this building draws them) */
  heldTokens: number;
}

/** Someone who has put tokens into the town: through Bank inputs, or donated straight to a building. */
export interface BankContributor {
  userId: string;
  name: string;
  /** bankTokens + donatedTokens */
  tokens: number;
  /** what their Bank inputs have credited so far */
  bankTokens: number;
  /** what they donated directly to buildings */
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
  /** balanceTokens + heldTokens: everything the town can still spend */
  townTokens: number;
  creditedTokens: number;
  /** expected tokens per day from active recurring inputs (monthly counts as 30 days) */
  dailyInflowTokens: number;
  inputs: (BankInput & { userName: string })[];
  buildings: BankBuildingShare[];
  /** top contributors by tokens given, most first (zero-token users left out) */
  contributors: BankContributor[];
}

/** Where a building's next draw comes from: today's subscription share (the server's own login), or an API key's input. */
export type BankFunding = { kind: "expiring" } | { kind: "durable"; inputId: string | null };

/** The next renewal after `from`: one period later (a month is a calendar month). */
function advance(from: Date, recurrence: Exclude<BankRecurrence, "once">): Date {
  const d = new Date(from);
  if (recurrence === "monthly") d.setUTCMonth(d.getUTCMonth() + 1);
  else d.setTime(d.getTime() + DAYS_PER[recurrence] * DAY_MS);
  return d;
}

/**
 * The town Bank: inputs (API keys, the owner's subscription) credit it; each building draws its % share.
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
    const { expiring, durable } = this.pools(now);
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
  private pools(now: Date): { expiring: number; durable: number } {
    let expiring = 0, durableIn = 0;
    for (const c of this.live(now)) {
      if (c.expiresAt) expiring += Math.max(0, c.tokens - this.debited("creditId = ?", [c.id]));
      else durableIn += c.tokens;
    }
    return { expiring, durable: Math.max(0, durableIn - this.debited("creditId IS NULL", [])) };
  }

  /**
   * Effective % per building. Explicit shares (admin-set) come first; labs without one split what's
   * left equally. The Town Hall gets nothing unless it is given a share.
   */
  shares(): Map<string, { pct: number; explicit: boolean }> {
    const explicit = new Map(this.repos.bankShares.all().map((r) => [r.buildingId, r.pct]));
    const out = new Map<string, { pct: number; explicit: boolean }>();
    let used = 0;
    const rest: string[] = [];
    for (const b of this.repos.buildings.all()) {
      const pct = explicit.get(b.id);
      if (pct !== undefined) { out.set(b.id, { pct, explicit: true }); used += pct; }
      else if (b.kind === "lab") rest.push(b.id);
      else out.set(b.id, { pct: 0, explicit: false });
    }
    const each = rest.length ? Math.max(0, 100 - used) / rest.length : 0;
    for (const id of rest) out.set(id, { pct: each, explicit: false });
    return out;
  }

  /** Set (or with null, clear) a building's % of the Bank. Admin only; explicit shares may not add up to more than 100. */
  setShare(userId: string, buildingId: string, input: { pct: number | null }): void {
    const { pct } = SetBankShareInput.parse(input);
    if (!this.permissions.isAdmin({ kind: "user", id: userId })) throw forbidden("town.allocate_budget", "Only an admin can set a building's share of the Bank.");
    const b = this.repos.buildings.require(buildingId, "building");
    if (pct === null) { this.repos.bankShares.delete(buildingId); }
    else {
      const others = this.repos.bankShares.all().filter((r) => r.buildingId !== buildingId).reduce((s, r) => s + r.pct, 0);
      if (others + pct > 100) throw badRequest(`Shares would add up to ${others + pct}%; the most this building can have is ${100 - others}%.`);
      this.repos.bankShares.upsert({ buildingId, pct });
    }
    this.events.append({ type: "bank.share", buildingId, text: pct === null ? `${b.name} now splits the Bank's unassigned share` : `${b.name} gets ${pct}% of the Bank`, payload: { buildingId, pct } });
  }

  /**
   * What a building can still draw. Expiring: its % of each unexpired subscription credit, less what it drew
   * from that credit. Durable: its % of all API-key credits, less what it drew from them (may be negative after
   * an overshoot; it's paid back from future credits).
   */
  available(buildingId: string, now = new Date()): { expiring: number; durable: number } {
    const frac = (this.shares().get(buildingId)?.pct ?? 0) / 100;
    if (frac <= 0) return { expiring: 0, durable: 0 };
    let expiring = 0, durableIn = 0;
    for (const c of this.live(now)) {
      if (c.expiresAt) expiring += Math.max(0, Math.floor(c.tokens * frac) - this.debited("buildingId = ? AND creditId = ?", [buildingId, c.id]));
      else durableIn += c.tokens;
    }
    return { expiring, durable: Math.floor(durableIn * frac) - this.debited("buildingId = ? AND creditId IS NULL", [buildingId]) };
  }

  /** Tokens the building can still draw from the Bank (never negative). */
  remaining(buildingId: string, now = new Date()): number {
    const a = this.available(buildingId, now);
    return a.expiring + Math.max(0, a.durable);
  }

  /** Where the building's next session should be funded from, or null when its Bank share is used up. */
  fundingFor(buildingId: string, now = new Date()): BankFunding | null {
    const a = this.available(buildingId, now);
    if (a.expiring > 0) return { kind: "expiring" };
    if (a.durable <= 0) return null;
    // the oldest live api-key input that still has its key
    const input = this.repos.bankInputs.first("source = 'api-key' AND hasApiKey = 1 AND cancelledAt IS NULL", [], "ORDER BY createdAt, rowid");
    return { kind: "durable", inputId: input?.id ?? null };
  }

  /**
   * Draw up to `tokens` for a building's session: its share of expiring credits first (soonest to expire first),
   * then its durable share. Returns what's left undrawn. With `overshoot`, the rest is drawn from the durable
   * share anyway (sessions may run past what's left; there is no hard stop).
   */
  draw(buildingId: string, agentId: string, tokens: number, opts: { overshoot?: boolean; now?: Date } = {}): number {
    const now = opts.now ?? new Date();
    let left = Math.round(tokens);
    const frac = (this.shares().get(buildingId)?.pct ?? 0) / 100;
    if (left <= 0 || frac <= 0) return Math.max(0, left);
    const debit = (creditId: string | null, t: number) => {
      this.repos.bankDebits.upsert({ id: newId("bd"), buildingId, agentId, creditId, tokens: t, createdAt: now.toISOString() });
      left -= t;
    };
    for (const c of this.live(now)) {
      if (!c.expiresAt || left <= 0) continue;
      const room = Math.floor(c.tokens * frac) - this.debited("buildingId = ? AND creditId = ?", [buildingId, c.id]);
      if (room > 0) debit(c.id, Math.min(room, left));
    }
    const durable = this.available(buildingId, now).durable;
    if (left > 0 && (durable > 0 || opts.overshoot)) debit(null, opts.overshoot ? left : Math.min(durable, left));
    return left;
  }

  /** Users ranked by tokens they've put in (Bank credits plus direct donations), most first. Ties go by name. */
  contributors(limit = 10): BankContributor[] {
    const credited = new Map<string, number>();
    for (const i of this.repos.bankInputs.all()) credited.set(i.userId, (credited.get(i.userId) ?? 0) + i.creditedTokens);
    return this.repos.users.all()
      .map((u) => {
        const bankTokens = credited.get(u.id) ?? 0;
        return { userId: u.id, name: u.name, tokens: bankTokens + u.donatedTokens, bankTokens, donatedTokens: u.donatedTokens };
      })
      .filter((c) => c.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name))
      .slice(0, limit);
  }

  summary(): BankSummary {
    const inputs = this.repos.bankInputs.all("ORDER BY createdAt, rowid");
    const dailyInflowTokens = Math.round(inputs.reduce((s, i) => {
      if (i.cancelledAt || i.recurrence === "once") return s;
      const perDay = i.tokens / DAYS_PER[i.recurrence];
      return s + (i.weeklyCapTokens ? Math.min(perDay, i.weeklyCapTokens / 7) : perDay);
    }, 0));
    const creditedTokens = inputs.reduce((s, i) => s + i.creditedTokens, 0);
    const now = new Date();
    const pools = this.pools(now);
    const shares = this.shares();
    const held = new Map<string, number>();
    for (const a of this.repos.allocations.all()) held.set(a.buildingId, (held.get(a.buildingId) ?? 0) + Math.max(0, a.tokens - a.spentTokens));
    const heldTokens = [...held.values()].reduce((s, t) => s + t, 0);
    return {
      balanceTokens: pools.expiring + pools.durable,
      heldTokens,
      townTokens: pools.expiring + pools.durable + heldTokens,
      expiringTokens: pools.expiring,
      durableTokens: pools.durable,
      creditedTokens,
      dailyInflowTokens,
      inputs: inputs.map((i) => ({ ...i, userName: this.repos.users.get(i.userId)?.name ?? i.userId })),
      buildings: this.repos.buildings.all().map((b) => {
        const s = shares.get(b.id) ?? { pct: 0, explicit: false };
        const a = this.available(b.id, now);
        return { buildingId: b.id, name: b.name, pct: Math.round(s.pct * 100) / 100, explicit: s.explicit, expiringTokens: a.expiring, durableTokens: a.durable, heldTokens: held.get(b.id) ?? 0 };
      }),
      contributors: this.contributors(),
    };
  }
}
