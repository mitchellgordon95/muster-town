import { AddBankInput, type BankInput, type BankRecurrence } from "@agent-town/schema";
import { badRequest, forbidden } from "./errors.ts";
import type { EventLog } from "./events.ts";
import type { Permissions } from "./permissions.ts";
import type { Repos } from "./store.ts";
import { newId, nowIso } from "./util.ts";

const DAY_MS = 86_400_000;
const DAYS_PER: Record<Exclude<BankRecurrence, "once">, number> = { daily: 1, weekly: 7, monthly: 30 };

export interface BankSummary {
  /** tokens credited by inputs and not yet given out */
  balanceTokens: number;
  creditedTokens: number;
  /** expected tokens per day from active recurring inputs (monthly counts as 30 days) */
  dailyInflowTokens: number;
  inputs: (BankInput & { userName: string })[];
}

/** The next renewal after `from`: one period later (a month is a calendar month). */
function advance(from: Date, recurrence: Exclude<BankRecurrence, "once">): Date {
  const d = new Date(from);
  if (recurrence === "monthly") d.setUTCMonth(d.getUTCMonth() + 1);
  else d.setTime(d.getTime() + DAYS_PER[recurrence] * DAY_MS);
  return d;
}

/** The town Bank: inputs (API keys, the owner's subscription) credit it; buildings will draw from it. `world.bank`. */
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
      this.repos.bankCredits.upsert({ id: newId("bc"), inputId: inp.id, tokens: amount, createdAt: now.toISOString() });
      total += amount;
      this.events.append({ type: "bank.credited", text: `${inp.label} credited ${amount.toLocaleString("en-US")} tokens to the Bank`, payload: { inputId: inp.id, tokens: amount } });
    }
    return total;
  }

  balance(): number {
    // nothing is given out yet; building shares (step 2) will subtract here
    return this.repos.bankCredits.all().reduce((s, c) => s + c.tokens, 0);
  }

  summary(): BankSummary {
    const inputs = this.repos.bankInputs.all("ORDER BY createdAt, rowid");
    const dailyInflowTokens = Math.round(inputs.reduce((s, i) => {
      if (i.cancelledAt || i.recurrence === "once") return s;
      const perDay = i.tokens / DAYS_PER[i.recurrence];
      return s + (i.weeklyCapTokens ? Math.min(perDay, i.weeklyCapTokens / 7) : perDay);
    }, 0));
    const creditedTokens = inputs.reduce((s, i) => s + i.creditedTokens, 0);
    return {
      balanceTokens: this.balance(),
      creditedTokens,
      dailyInflowTokens,
      inputs: inputs.map((i) => ({ ...i, userName: this.repos.users.get(i.userId)?.name ?? i.userId })),
    };
  }
}
