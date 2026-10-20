import { DonateInput, type Agent, type Allocation, type BuildingBudget, type ServerMessage } from "@agent-town/schema";
import { badRequest } from "./errors.ts";
import type { EventLog } from "./events.ts";
import type { Repos } from "./store.ts";
import { type Emitter, newId, nowIso } from "./util.ts";

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

const SKIP_STATUSES = new Set(["stopped", "banned"]);

/** Donations, allocations, and charging. `world.budget`. */
export class Budget {
  constructor(private repos: Repos, private events: EventLog, private changes?: Emitter<ServerMessage>) {}

  /** Oldest allocation of the building with tokens left (the one to charge next), or null. */
  pickAllocation(buildingId: string): Allocation | null {
    return this.repos.allocations.first("buildingId = ? AND spentTokens < tokens", [buildingId], "ORDER BY createdAt, rowid") ?? null;
  }

  /** Secret: the donor's Anthropic API key for this allocation, if they stored one. */
  apiKeyFor(allocation: Allocation): string | null {
    return this.repos.users.getApiKey(allocation.userId);
  }

  remaining(buildingId: string): number {
    return this.of(buildingId).remainingTokens;
  }

  /** The building's allocated / spent / remaining tokens, summed over its allocations. */
  of(buildingId: string): BuildingBudget {
    const allocs = this.repos.allocations.where("buildingId = ?", [buildingId]);
    return {
      allocatedTokens: allocs.reduce((s, a) => s + a.tokens, 0),
      spentTokens: allocs.reduce((s, a) => s + a.spentTokens, 0),
      remainingTokens: allocs.reduce((s, a) => s + Math.max(0, a.tokens - a.spentTokens), 0),
    };
  }

  /** Resend the building (with its budget) so the map's sign stays current. */
  private emitBuilding(buildingId: string): void {
    const b = this.repos.buildings.get(buildingId);
    if (b && this.changes) this.changes.emit({ type: "building", building: { ...b, budget: this.of(buildingId) } });
  }

  /** Whether a resident may start a session now (daily allowance and building budget). */
  canStart(agentId: string): boolean {
    const a = this.repos.agents.require(agentId, "agent");
    const bid = a.homeBuildingId ?? a.buildingId;
    if (!bid) return false;
    const b = this.repos.buildings.require(bid, "building");
    return a.spentTokensToday < b.dailyTokensPerAgent && this.remaining(bid) > 0;
  }

  /**
   * Charge session usage to the agent and to an allocation of its home building
   * (the given one, else the oldest with tokens left). Emits `budget.exhausted`
   * and sets `out-of-budget` when the agent's daily allowance or the building budget runs out.
   */
  charge(agentId: string, tokens: number, usd: number, allocationId?: string): ChargeResult {
    if (tokens < 0 || usd < 0) throw badRequest("charge must be non-negative");
    const t = Math.round(tokens);
    let agent = this.repos.agents.require(agentId, "agent");
    agent = this.repos.agents.upsert({
      ...agent,
      spentTokensToday: agent.spentTokensToday + t,
      spentTokensTotal: agent.spentTokensTotal + t,
      spentUsdTotal: agent.spentUsdTotal + usd,
    });
    const bid = agent.homeBuildingId ?? agent.buildingId;
    let allocation: Allocation | null = null;
    if (bid) {
      allocation = allocationId ? this.repos.allocations.require(allocationId, "allocation") : this.pickAllocation(bid);
      if (allocation) {
        allocation = this.repos.allocations.upsert({ ...allocation, spentTokens: allocation.spentTokens + t, spentUsd: allocation.spentUsd + usd });
        this.emitBuilding(bid);
      }
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
      } else if (agent.kind === "resident" && agent.spentTokensToday >= b.dailyTokensPerAgent) {
        exhausted = "agent-daily";
        this.events.append({ type: "budget.exhausted", buildingId: bid, agentId: agent.id, text: `${agent.name} used today's ${b.dailyTokensPerAgent.toLocaleString("en-US")} tokens`, payload: { scope: "agent", spentTokensToday: agent.spentTokensToday } });
        if (!SKIP_STATUSES.has(agent.status)) agent = this.setStatus(agent, "out-of-budget");
      }
    }
    return { agent: this.repos.agents.require(agent.id), allocation, exhausted };
  }

  /** Midnight: zero everyone's daily spend; out-of-budget residents whose building has budget go idle. */
  resetDaily(): number {
    let n = 0;
    for (const a of this.repos.agents.all()) {
      const reset = { ...a, spentTokensToday: 0 };
      if (a.status === "out-of-budget") {
        const bid = a.homeBuildingId ?? a.buildingId;
        if (bid && this.remaining(bid) > 0) { reset.status = "idle"; n++; }
      }
      this.repos.agents.upsert(reset);
    }
    this.events.append({ type: "system", text: "Daily token allowances reset", payload: { resumed: n } });
    return n;
  }

  /** A user donates tokens to a building (optionally storing their API key). */
  donate(userId: string, input: { tokens: number; buildingId: string; apiKey?: string }): Allocation {
    const inp = DonateInput.parse(input);
    const user = this.repos.users.require(userId, "user");
    const b = this.repos.buildings.require(inp.buildingId, "building");
    if (inp.apiKey) this.repos.users.setApiKey(userId, inp.apiKey);
    const allocation = this.repos.allocations.upsert({ id: newId("al"), userId, buildingId: b.id, tokens: inp.tokens, spentTokens: 0, spentUsd: 0, createdAt: nowIso() });
    this.repos.users.upsert({ ...this.repos.users.require(userId), donatedTokens: user.donatedTokens + inp.tokens });
    this.emitBuilding(b.id);
    this.events.append({ type: "allocation.created", buildingId: b.id, text: `${user.name} donated ${inp.tokens.toLocaleString("en-US")} tokens to ${b.name}`, payload: { allocationId: allocation.id, userId, tokens: inp.tokens } });
    // resume residents that were blocked only by the building budget
    for (const r of this.repos.agents.where("homeBuildingId = ? AND status = 'out-of-budget'", [b.id])) {
      if (r.spentTokensToday < b.dailyTokensPerAgent) this.setStatus(r, "idle");
    }
    return allocation;
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
