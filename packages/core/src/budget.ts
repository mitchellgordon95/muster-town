import { DonateInput, type TokenCounts, type Agent, type Allocation, type AllocationAuth, type Assignment, type Building, type BuildingBudget, type ServerMessage } from "@muster-town/schema";
import { type Bank, type Booked, booked } from "./bank.ts";
import { badRequest } from "./errors.ts";
import type { EventLog } from "./events.ts";
import type { Repos } from "./store.ts";
import { type Emitter, newId, nowIso } from "./util.ts";

/** Manager forks: the family's daily cap, dailyTokensPerAgent × headcount, counted on the manager's row (`familySpentToday`). */
export const familyCap = (b: Building): number => b.dailyTokensPerAgent * b.headcount;

export interface ChargeResult {
  agent: Agent;
  allocation: Allocation | null;
  /** set when this charge exhausted something */
  exhausted: null | "agent-daily" | "building";
}
export interface BudgetSummary {
  buildings: { buildingId: string; name: string; allocatedTokens: number; spentTokens: number; spentUsd: number; remainingTokens: number }[];
  users: { userId: string; name: string; donatedTokens: number }[];
}

/** How a charge's counters are priced: the session's model, and its per-model breakdown when it has one (Bank step 3). */
export interface ChargePrice {
  model?: string | null; byModel?: Record<string, TokenCounts> | null;
  /** the session's grant: when it names its own Bank input (`fundedWith`, member funding), that input pays first */
  grantId?: string | null;
}

const SKIP_STATUSES = new Set(["stopped", "banned"]);

/** Draw order: the subscription first, then donors' own keys, then the town's API key; oldest first within each. */
const DRAW_ORDER = "ORDER BY CASE auth WHEN 'subscription' THEN 0 WHEN 'donor-key' THEN 1 ELSE 2 END, createdAt, rowid";
const LIVE = "buildingId = ? AND retired = 0";
/** Allocations a placeholder cleanup retires: labelled house/placeholder (the seed's house budget). */
export const PLACEHOLDER_LABEL = /\b(house|placeholder)\b/i;

/** ISO instant of the server's last local midnight: daily allowances reset then (runtime tick), so "today" starts there. */
export function startOfLocalDay(d: Date): string {
  const m = new Date(d);
  m.setHours(0, 0, 0, 0);
  return m.toISOString();
}

/** Donations, allocations, and charging. `world.budget`. */
export class Budget {
  /** goal-directed budgets: the lane gate (`laneHold`, set by World): why an assignment is held, or null */
  gate?: (assignment: Assignment) => string | null;
  /** hosted collectives: why nothing may start (no API key of its own yet), or null; set by World */
  keyHold?: () => string | null;
  /** goal-directed budgets: after every charge (World runs the grants' 100% checkpoints of the building) */
  afterCharge?: (buildingId: string) => void;

  constructor(private repos: Repos, private events: EventLog, private bank: Bank, private changes?: Emitter<ServerMessage>) {}

  /** The allocation to charge next: the building's first live allocation with tokens left, in draw order (subscription → donor-key → api-key), or null. */
  pickAllocation(buildingId: string, auths?: AllocationAuth[]): Allocation | null {
    const only = auths?.length ? ` AND auth IN (${auths.map(() => "?").join(", ")})` : "";
    return this.repos.allocations.first(`${LIVE} AND spentTokens < tokens${only}`, [buildingId, ...(auths ?? [])], DRAW_ORDER) ?? null;
  }

  /** What a session falls back to when the subscription hits its spend limit: the first donor-key or api-key allocation with tokens left. */
  fallbackAllocation(buildingId: string): Allocation | null {
    return this.pickAllocation(buildingId, ["donor-key", "api-key"]);
  }

  /** Secret: the donor's Anthropic API key for a donor-key allocation (null for subscription / town api-key allocations). */
  apiKeyFor(allocation: Allocation): string | null {
    return allocation.auth === "donor-key" ? this.repos.users.getApiKey(allocation.userId) : null;
  }

  /** The building's allocations, newest first (retired ones included, for their history). */
  allocationsOf(buildingId: string): Allocation[] {
    return this.repos.allocations.where("buildingId = ?", [buildingId], "ORDER BY createdAt DESC, rowid DESC");
  }

  remaining(buildingId: string): number {
    return this.of(buildingId).remainingTokens;
  }

  /** The building's allocated / spent / remaining tokens, summed over its live (unretired) allocations, plus what it can draw from the Bank. */
  of(buildingId: string): BuildingBudget {
    const allocs = this.repos.allocations.where(LIVE, [buildingId]);
    const bankTokens = this.bank.remaining(buildingId);
    return {
      allocatedTokens: allocs.reduce((s, a) => s + a.tokens, 0),
      spentTokens: allocs.reduce((s, a) => s + a.spentTokens, 0),
      remainingTokens: allocs.reduce((s, a) => s + Math.max(0, a.tokens - a.spentTokens), 0) + bankTokens,
      bankTokens,
      ...this.usage(buildingId),
    };
  }

  /** Adjusted output tokens the building's residents used today (since the server's local midnight) and all-time, from the usage ledger. */
  usage(buildingId: string, now = new Date()): { tokensToday: number; tokensAllTime: number } {
    return {
      tokensToday: this.repos.usage.sum("tokens", "buildingId = ? AND createdAt >= ?", [buildingId, startOfLocalDay(now)]),
      tokensAllTime: this.repos.usage.sum("tokens", "buildingId = ?", [buildingId]),
    };
  }

  /**
   * Record usage on the agent (daily + total counters) and in the usage ledger, without drawing from any budget, then
   * run `afterCharge` (grant checkpoints). `charge` does this too; call it alone when nothing funds the session (e.g. Town Hall's librarian).
   * Booked in adjusted output tokens (`booked`: counters priced at `price.model`, per model with `price.byModel`; a bare number is already adjusted).
   */
  recordUsage(agentId: string, tokens: number | TokenCounts | Booked, usd: number, price: ChargePrice = {}): Agent {
    if ((typeof tokens === "number" && tokens < 0) || usd < 0) throw badRequest("usage must be non-negative");
    const b = booked(tokens, price.model, price.byModel);
    const t = b.tokens;
    const agent = this.repos.agents.require(agentId, "agent");
    const bid = agent.homeBuildingId ?? agent.buildingId;
    this.repos.usage.upsert({ id: newId("us"), agentId, buildingId: bid, ...b.counts, tokens: t, usd, createdAt: nowIso() });
    const updated = this.repos.agents.upsert({
      ...agent,
      spentTokensToday: agent.spentTokensToday + t,
      spentTokensTotal: agent.spentTokensTotal + t,
      spentUsdTotal: agent.spentUsdTotal + usd,
      // manager forks: the family root (an agent that isn't a fork) counts its own spend and its forks' (below)
      ...(agent.forkOf ? {} : { familySpentToday: agent.familySpentToday + t }),
    });
    const root = agent.forkOf ? this.repos.agents.get(agent.forkOf) : undefined;
    if (root) this.repos.agents.upsert({ ...root, familySpentToday: root.familySpentToday + t });
    // grants' spend is derived from sessions, already ended with their tokens: see whether one reached 100%
    if (bid) this.afterCharge?.(bid);
    return updated;
  }

  /** Resend the building (with its budget) so the map's sign stays current. */
  private emitBuilding(buildingId: string): void {
    const b = this.repos.buildings.get(buildingId);
    if (b && this.changes) this.changes.emit({ type: "building", building: { ...b, budget: this.of(buildingId) } });
  }

  /**
   * Whether a resident may start a session now (daily allowance and building budget) and, with `assignment`, whether
   * the lane gate lets that assignment run (goal-directed buildings: grant funded, exploration allowance left). The one
   * check the scheduler and work sessions use. A held assignment stays pending; its `heldReason` says why.
   */
  canStart(agentId: string, assignment?: Assignment): boolean {
    const a = this.repos.agents.require(agentId, "agent");
    const bid = a.homeBuildingId ?? a.buildingId;
    if (!bid) return false;
    // a hosted collective with no API key of its own: everything waits (the held assignment says why)
    if (this.keyHold?.()) {
      if (assignment) this.holdReason(assignment);
      return false;
    }
    const b = this.repos.buildings.require(bid, "building");
    if (!(this.withinDaily(a, b) && this.remaining(bid) > 0)) return false;
    if (!assignment) return this.capHold(bid) === null;
    return this.holdReason(assignment) === null;
  }

  /**
   * The daily cap. A fork is checked against its family (the manager's `familySpentToday`, its own sessions plus today's
   * forks', under dailyTokensPerAgent × headcount) instead of its own row, which starts at 0; any other agent against
   * its own dailyTokensPerAgent, and a manager of a building with forks on against its family too.
   */
  private withinDaily(a: Agent, b: Building): boolean {
    const root = a.forkOf ? this.repos.agents.get(a.forkOf) : a;
    const familyOk = !root || root.familySpentToday < familyCap(b);
    if (a.forkOf) return familyOk;
    return a.spentTokensToday < b.dailyTokensPerAgent && (!b.forks || b.managerAgentId !== a.id || familyOk);
  }

  /**
   * Bank step 5: why new starts in the building are held near the subscription cap, or null. Only when its next session
   * would run on the subscription and nothing can take the failover (no donor-key / api-key allocation, no API-key input):
   * with a fallback the session fails over as before. No cap seen yet = no hold.
   */
  capHold(buildingId: string, now = new Date()): string | null {
    const f = this.bank.fundingFor(buildingId, now);
    const onSubscription = f ? f.kind === "expiring" : this.pickAllocation(buildingId)?.auth === "subscription";
    if (!onSubscription || this.fallbackAllocation(buildingId) || this.bank.fallbackInput(buildingId, now)) return null;
    return this.bank.capState(now).reason;
  }

  /** Why `assignment` is held (null = may run): the no-key hold (hosted), the cap hold, else the lane gate; kept on the pending assignment as `heldReason`. */
  holdReason(assignment: Assignment): string | null {
    const reason = this.keyHold?.() ?? this.capHold(assignment.buildingId) ?? this.gate?.(assignment) ?? null;
    const cur = this.repos.assignments.get(assignment.id);
    if (cur && cur.status === "pending" && (cur.heldReason ?? null) !== reason) this.repos.assignments.upsert({ ...cur, heldReason: reason });
    return reason;
  }

  /**
   * Charge session usage to the agent and to its home building. A member-funded grant's own input (`price.grantId`,
   * its `fundedWith`) pays first. With an `allocationId` (the session ran on that allocation) the rest goes there.
   * Otherwise the building's Bank share pays the rest first (expiring, then durable), then the oldest allocation with tokens left; whatever is still left overshoots the last source (no hard stop).
   * Emits `budget.exhausted`
   * and sets `out-of-budget` when the agent's daily allowance or the building budget runs out.
   */
  charge(agentId: string, tokens: number | TokenCounts | Booked, usd: number, allocationId?: string, price: ChargePrice = {}): ChargeResult {
    if ((typeof tokens === "number" && tokens < 0) || usd < 0) throw badRequest("charge must be non-negative");
    const booking = booked(tokens, price.model, price.byModel);
    const t = booking.tokens;
    let agent = this.recordUsage(agentId, booking, usd);
    const bid = agent.homeBuildingId ?? agent.buildingId;
    let allocation: Allocation | null = null;
    if (bid) {
      const grant = price.grantId ? this.repos.grants.get(price.grantId) : undefined;
      const own = grant?.fundedWith ? this.bank.drawFromInput(bid, agent.id, booking, grant) : booking;
      const rest = allocationId ? own : this.bank.drawTokens(bid, agent.id, own);
      const left = rest.tokens, c = rest.counts;
      allocation = allocationId ? this.repos.allocations.require(allocationId, "allocation") : left > 0 ? this.pickAllocation(bid) : null;
      if (allocation) {
        allocation = this.repos.allocations.upsert({
          ...allocation, spentTokens: allocation.spentTokens + left,
          spentInput: allocation.spentInput + c.input, spentOutput: allocation.spentOutput + c.output, spentCacheRead: allocation.spentCacheRead + c.cacheRead,
          spentCacheWrite5m: allocation.spentCacheWrite5m + c.cacheWrite5m, spentCacheWrite1h: allocation.spentCacheWrite1h + c.cacheWrite1h,
          spentUsd: allocation.spentUsd + usd * (left / Math.max(1, t)),
        });
      } else if (left > 0) {
        this.bank.drawTokens(bid, agent.id, rest, { overshoot: true });
      }
      this.emitBuilding(bid);
    }
    let exhausted: ChargeResult["exhausted"] = null;
    if (bid) {
      const b = this.repos.buildings.require(bid, "building");
      if (this.remaining(bid) <= 0) {
        exhausted = "building";
        this.events.append({ type: "budget.exhausted", buildingId: bid, agentId: agent.id, text: `${b.name} has run out of budget`, payload: { scope: "building" } });
        for (const r of this.repos.agents.where("homeBuildingId = ? AND kind = 'resident'", [bid])) {
          if (!SKIP_STATUSES.has(r.status) && r.status !== "out-of-budget") this.setStatus(r, "out-of-budget");
        }
      } else if (agent.kind === "resident" && agent.forkOf && !this.withinDaily(agent, b)) {
        const root = this.repos.agents.require(agent.forkOf, "agent");
        exhausted = "agent-daily";
        this.events.append({ type: "budget.exhausted", buildingId: bid, agentId: agent.id, text: `${root.name} and forks used today's ${familyCap(b).toLocaleString("en-US")} adj. tokens`, payload: { scope: "family", forkOf: root.id, familySpentToday: root.familySpentToday } });
        if (!SKIP_STATUSES.has(agent.status)) agent = this.setStatus(agent, "out-of-budget");
      } else if (agent.kind === "resident" && !agent.forkOf && agent.spentTokensToday >= b.dailyTokensPerAgent) {
        exhausted = "agent-daily";
        this.events.append({ type: "budget.exhausted", buildingId: bid, agentId: agent.id, text: `${agent.name} used today's ${b.dailyTokensPerAgent.toLocaleString("en-US")} adj. tokens`, payload: { scope: "agent", spentTokensToday: agent.spentTokensToday } });
        if (!SKIP_STATUSES.has(agent.status)) agent = this.setStatus(agent, "out-of-budget");
      }
    }
    return { agent: this.repos.agents.require(agent.id), allocation, exhausted };
  }

  /** Midnight: zero everyone's daily spend; out-of-budget residents whose building has budget go idle. */
  resetDaily(): number {
    let n = 0;
    for (const a of this.repos.agents.all()) {
      const reset = { ...a, spentTokensToday: 0, familySpentToday: 0 };
      if (a.status === "out-of-budget") {
        const bid = a.homeBuildingId ?? a.buildingId;
        if (bid && this.remaining(bid) > 0) { reset.status = "idle"; n++; }
      }
      this.repos.agents.upsert(reset);
    }
    this.events.append({ type: "system", text: "Daily token allowances reset", payload: { resumed: n } });
    return n;
  }

  /** Out-of-budget residents that can start again (the daily cap or the building's budget was raised) go idle. Returns how many. */
  resumeEligible(buildingId?: string): number {
    let n = 0;
    for (const r of this.repos.agents.where("kind = 'resident' AND status = 'out-of-budget'", [])) {
      if ((buildingId && (r.homeBuildingId ?? r.buildingId) !== buildingId) || !this.canStart(r.id)) continue;
      this.setStatus(r, "idle");
      n++;
    }
    return n;
  }

  /**
   * A user donates tokens to a building (optionally storing their API key). `auth` defaults to donor-key when
   * the donor has a key, else api-key. Permission to fund with the town's own credentials is checked by the caller.
   */
  donate(userId: string, input: { tokens: number; buildingId: string; apiKey?: string; auth?: AllocationAuth; label?: string }): Allocation {
    const inp = DonateInput.parse(input);
    const user = this.repos.users.require(userId, "user");
    const b = this.repos.buildings.require(inp.buildingId, "building");
    if (inp.apiKey) this.repos.users.setApiKey(userId, inp.apiKey);
    const auth: AllocationAuth = inp.auth ?? (inp.apiKey || this.repos.users.getApiKey(userId) ? "donor-key" : "api-key");
    if (auth === "donor-key" && !this.repos.users.getApiKey(userId)) throw badRequest("A donor-key allocation needs your Anthropic API key.");
    const label = inp.label?.trim() ?? "";
    const allocation = this.repos.allocations.upsert({ id: newId("al"), userId, buildingId: b.id, tokens: inp.tokens, spentTokens: 0, spentUsd: 0, createdAt: nowIso(), auth, label, retired: false });
    this.repos.users.upsert({ ...this.repos.users.require(userId), donatedTokens: user.donatedTokens + inp.tokens });
    this.emitBuilding(b.id);
    const what = label ? ` (${label})` : "";
    this.events.append({ type: "allocation.created", buildingId: b.id, text: `${user.name} donated ${inp.tokens.toLocaleString("en-US")} adj. tokens to ${b.name}${what}`, payload: { allocationId: allocation.id, userId, tokens: inp.tokens, auth, label } });
    // resume residents that were blocked only by the building budget
    for (const r of this.repos.agents.where("homeBuildingId = ? AND status = 'out-of-budget'", [b.id])) {
      if (r.spentTokensToday < b.dailyTokensPerAgent) this.setStatus(r, "idle");
    }
    return allocation;
  }

  /** Retire an allocation: it keeps its spend history but is never drawn from and leaves the building's budget. Idempotent. */
  retire(allocationId: string, byName = "An admin"): Allocation {
    const a = this.repos.allocations.require(allocationId, "allocation");
    if (a.retired) return a;
    const row = this.repos.allocations.upsert({ ...a, retired: true });
    const b = this.repos.buildings.get(a.buildingId);
    const left = Math.max(0, a.tokens - a.spentTokens);
    this.events.append({ type: "system", buildingId: a.buildingId, text: `${byName} retired ${a.label || `allocation ${a.id}`}${b ? ` at ${b.name}` : ""} (${left.toLocaleString("en-US")} adj. tokens unspent)`, payload: { allocationId: a.id, retired: true, auth: a.auth } });
    this.emitBuilding(a.buildingId);
    return row;
  }

  /**
   * Retire the placeholder allocations: those labelled house/placeholder, the given ids, and (with `unlabelled`)
   * every unlabelled non-donor allocation from before labels existed. Spend history stays. Returns what it retired.
   */
  retirePlaceholders(opts: { ids?: string[]; unlabelled?: boolean; dryRun?: boolean; byName?: string } = {}): Allocation[] {
    const ids = new Set(opts.ids ?? []);
    const hits = this.repos.allocations.where("retired = 0", [], "ORDER BY createdAt, rowid")
      .filter((a) => ids.has(a.id) || PLACEHOLDER_LABEL.test(a.label) || (!!opts.unlabelled && !a.label.trim() && a.auth !== "donor-key"));
    return opts.dryRun ? hits : hits.map((a) => this.retire(a.id, opts.byName ?? "Placeholder cleanup"));
  }

  summary(): BudgetSummary {
    return {
      buildings: this.repos.buildings.all().map((b) => {
        const spentUsd = this.repos.allocations.where("buildingId = ?", [b.id]).reduce((s, a) => s + a.spentUsd, 0);
        return { buildingId: b.id, name: b.name, ...this.of(b.id), spentUsd };
      }),
      users: this.repos.users.all().map((u) => ({ userId: u.id, name: u.name, donatedTokens: u.donatedTokens })),
    };
  }

  private setStatus(a: Agent, status: Agent["status"]): Agent {
    const updated = this.repos.agents.upsert({ ...a, status });
    this.events.append({ type: "agent.status", agentId: a.id, buildingId: a.homeBuildingId, text: `${a.name} is ${status}`, payload: { status, from: a.status } });
    return updated;
  }
}
