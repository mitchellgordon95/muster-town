import { DEFAULT_POOL_ID, type Allocation, type BankCredit, type BankDebit, type BankPool, type Building } from "@muster-town/schema";
import type { Repos } from "./store.ts";

/**
 * GET /api/finance/pools: how the Bank's tokens are divided into pools and what each building took (Bank Transparency
 * grant gr_mijwhoiy2f, step 1). Adjusted output tokens throughout, read-only. A pool owns its % of every credit
 * (Bank.shares / poolAvailable); inside a pool buildings draw first come, first served, so a building has no planned
 * allocation of its own: per building we show what it drew (its Bank debits), what was donated straight to it
 * (allocations) and what of that is still held, plus its exploration allowance today.
 *
 * Two identities, each re-added from independent rows:
 * - draws: Σ buildings.drawn = Σ pools.drawn = every Bank debit (/api/finance `usedBank`);
 * - balance: Σ pools.left − Σ pools.overdrawn + unshared = Bank balance − Bank overshoot. A pool's durable left can go
 *   below 0 after an overshoot (its `overdrawn`, debt paid back from later API-key credits), while the Bank's balance
 *   clamps durable at 0 and carries the same debt as /api/finance `overdrawnBreakdown.durableOvershoot`. `unshared` is
 *   the part of the credits no pool owns (shares under 100%, and the pools' floor() rounding).
 */
export interface PoolRow {
  /** null for the row holding debits whose pool no longer exists */
  id: string | null;
  name: string;
  /** effective % of the Bank (Bank.shares) */
  pct: number;
  explicit: boolean;
  isDefault: boolean;
  buildings: { id: string; name: string }[];
  /** its share of the unexpired subscription credits, less its debits on them (floor 0 per credit) */
  expiringLeft: number;
  /** its share of the durable (API-key) credits, less its durable debits, clamped at 0 */
  durableLeft: number;
  /** expiringLeft + durableLeft */
  left: number;
  /** durable debits past its durable share (overshoot debt; 0 when none) */
  overdrawn: number;
  /** Σ its Bank debits, all time */
  drawn: number;
  /** its share of the expected daily inflow (Bank.poolDailyInflow) */
  dailyInflowTokens: number;
}

export interface PoolBuildingRow {
  /** null for the row holding debits whose building no longer exists */
  id: string | null;
  name: string;
  poolId: string | null;
  poolName: string;
  /** false for the Town Hall (and the deleted-building row): it draws nothing from the Bank */
  drawsFromBank: boolean;
  /** Σ its Bank debits */
  drawn: number;
  /** of drawn: from subscription credits, and from durable credits (API key, overshoot included) */
  drawnSubscription: number;
  drawnDurable: number;
  /** of drawn: paid by a member-funded grant's own input (debits with a grantId) */
  drawnMemberFunded: number;
  /** direct donations received (a retired allocation counts only what it spent, as /api/finance `donated`) */
  donated: number;
  /** spent from those donations */
  donationsSpent: number;
  /** unspent tokens of its live donations: the same figure as /api/bank buildings[].heldTokens */
  held: number;
  /** its exploration allowance today (Grants.exploration; 0 for the Town Hall) */
  explorationTokensPerDay: number;
}

export interface FinancePools {
  pools: PoolRow[];
  buildings: PoolBuildingRow[];
  /** Σ pools.pct */
  sharedPct: number;
  /** the Bank's balance (= /api/bank balanceTokens) and its durable overshoot (= /api/finance overdrawnBreakdown.durableOvershoot) */
  balanceTokens: number;
  overshootTokens: number;
  /** Σ pools.left, Σ pools.overdrawn */
  poolsLeftTokens: number;
  poolsOverdrawnTokens: number;
  /** credit tokens no pool owns: (100 − sharedPct)% of each unexpired subscription credit and of the durable ones, plus rounding, less what deleted pools drew from them */
  unsharedTokens: number;
  /** every Bank debit (= /api/finance usedBank) */
  usedBank: number;
  /** Σ buildings.donated, Σ buildings.held */
  donatedTokens: number;
  heldTokens: number;
  sumCheck: {
    drawsOk: boolean; drawsDiff: number;
    balanceOk: boolean; balanceDiff: number;
    ok: boolean;
    identities: { draws: string; balance: string };
  };
  at: string;
}

export interface PoolsInputs {
  pools: Pick<BankPool, "id" | "name" | "createdAt">[];
  buildings: Pick<Building, "id" | "name" | "kind" | "poolId">[];
  /** Bank.shares(): effective % per pool */
  shares: Map<string, { pct: number; explicit: boolean }>;
  credits: Pick<BankCredit, "id" | "tokens" | "expiresAt">[];
  debits: Pick<BankDebit, "buildingId" | "poolId" | "creditId" | "grantId" | "tokens">[];
  allocations: Pick<Allocation, "buildingId" | "tokens" | "spentTokens" | "retired">[];
  /** Bank.dailyInflow() */
  dailyInflowTokens: number;
  /** today's exploration allowance per building id */
  allowance: (buildingId: string) => number;
}

export const DELETED_POOL = "Deleted pool (debits whose pool no longer exists)";
export const DELETED_BUILDING = "Deleted building (debits whose building no longer exists)";
export const POOLS_DRAWS_IDENTITY = "Σ building draws = Σ pool draws = Bank debits";
export const POOLS_BALANCE_IDENTITY = "Σ pools left − Σ pools overdrawn + unshared = Bank balance − overshoot";

/** The pure aggregation behind GET /api/finance/pools (same rules as Bank.poolAvailable and Bank.summary). */
export function financePools(inp: PoolsInputs, now = new Date()): FinancePools {
  const iso = now.toISOString();
  const poolIds = new Set(inp.pools.map((p) => p.id));
  const poolName = new Map(inp.pools.map((p) => [p.id, p.name]));
  // Bank.poolOf: a building with no pool, or a pool that's gone, is in General
  const poolOf = (b: Pick<Building, "poolId">) => (b.poolId && poolIds.has(b.poolId) ? b.poolId : DEFAULT_POOL_ID);
  const durableIds = new Set(inp.credits.filter((c) => !c.expiresAt).map((c) => c.id));
  const live = inp.credits.filter((c) => c.expiresAt && c.expiresAt > iso);
  const durableIn = inp.credits.reduce((s, c) => s + (c.expiresAt ? 0 : c.tokens), 0);
  const isDurable = (d: Pick<BankDebit, "creditId">) => d.creditId === null || durableIds.has(d.creditId);

  const byCredit = new Map<string, number>(), byPoolCredit = new Map<string, number>(), poolDurable = new Map<string, number>();
  let usedBank = 0, durableDebits = 0;
  for (const d of inp.debits) {
    usedBank += d.tokens;
    if (isDurable(d)) { durableDebits += d.tokens; poolDurable.set(d.poolId, (poolDurable.get(d.poolId) ?? 0) + d.tokens); }
    else if (d.creditId) {
      byCredit.set(d.creditId, (byCredit.get(d.creditId) ?? 0) + d.tokens);
      const k = `${d.poolId}\u0000${d.creditId}`;
      byPoolCredit.set(k, (byPoolCredit.get(k) ?? 0) + d.tokens);
    }
  }

  // pools, General first then by creation (Bank.listPools)
  const ordered = [...inp.pools].sort((a, b) => Number(b.id === DEFAULT_POOL_ID) - Number(a.id === DEFAULT_POOL_ID) || a.createdAt.localeCompare(b.createdAt));
  let sharedPct = 0, unsharedTokens = 0;
  const fracs = ordered.map((p) => (inp.shares.get(p.id)?.pct ?? 0) / 100);
  for (const c of live) unsharedTokens += c.tokens - fracs.reduce((s, f) => s + Math.floor(c.tokens * f), 0);
  unsharedTokens += durableIn - fracs.reduce((s, f) => s + Math.floor(durableIn * f), 0);
  // what a deleted pool drew from those credits came out of no live pool's share
  const liveIds = new Set(live.map((c) => c.id));
  for (const d of inp.debits) if (!poolIds.has(d.poolId) && (isDurable(d) || (d.creditId && liveIds.has(d.creditId)))) unsharedTokens -= d.tokens;
  const drawnBy = (key: "poolId" | "buildingId", id: string) => inp.debits.reduce((s, d) => s + (d[key] === id ? d.tokens : 0), 0);
  const pools: PoolRow[] = ordered.map((p, i) => {
    const s = inp.shares.get(p.id) ?? { pct: 0, explicit: false };
    sharedPct += s.pct;
    const f = fracs[i]!;
    let expiringLeft = 0;
    for (const c of live) expiringLeft += Math.max(0, Math.floor(c.tokens * f) - (byPoolCredit.get(`${p.id}\u0000${c.id}`) ?? 0));
    const durable = Math.floor(durableIn * f) - (poolDurable.get(p.id) ?? 0);
    const durableLeft = Math.max(0, durable);
    return {
      id: p.id, name: p.name, pct: round(s.pct), explicit: s.explicit, isDefault: p.id === DEFAULT_POOL_ID,
      buildings: inp.buildings.filter((b) => poolOf(b) === p.id).map((b) => ({ id: b.id, name: b.name })),
      expiringLeft, durableLeft, left: expiringLeft + durableLeft, overdrawn: Math.max(0, -durable),
      drawn: drawnBy("poolId", p.id), dailyInflowTokens: Math.floor(inp.dailyInflowTokens * s.pct / 100),
    };
  });
  const orphanPool = inp.debits.filter((d) => !poolIds.has(d.poolId)).reduce((s, d) => s + d.tokens, 0);
  if (orphanPool) pools.push({
    id: null, name: DELETED_POOL, pct: 0, explicit: false, isDefault: false, buildings: [],
    expiringLeft: 0, durableLeft: 0, left: 0, overdrawn: 0, drawn: orphanPool, dailyInflowTokens: 0,
  });

  const buildingIds = new Set(inp.buildings.map((b) => b.id));
  const buildings: PoolBuildingRow[] = inp.buildings.map((b) => {
    const mine = inp.debits.filter((d) => d.buildingId === b.id);
    const allocs = inp.allocations.filter((a) => a.buildingId === b.id);
    const pid = poolOf(b);
    const draws = b.kind !== "town-hall";
    return {
      id: b.id, name: b.name, poolId: pid, poolName: poolName.get(pid) ?? pid, drawsFromBank: draws,
      drawn: mine.reduce((s, d) => s + d.tokens, 0),
      drawnSubscription: mine.reduce((s, d) => s + (isDurable(d) ? 0 : d.tokens), 0),
      drawnDurable: mine.reduce((s, d) => s + (isDurable(d) ? d.tokens : 0), 0),
      drawnMemberFunded: mine.reduce((s, d) => s + (d.grantId ? d.tokens : 0), 0),
      donated: allocs.reduce((s, a) => s + (a.retired ? Math.min(a.tokens, a.spentTokens) : a.tokens), 0),
      donationsSpent: allocs.reduce((s, a) => s + a.spentTokens, 0),
      held: allocs.reduce((s, a) => s + (a.retired ? 0 : Math.max(0, a.tokens - a.spentTokens)), 0),
      explorationTokensPerDay: draws ? inp.allowance(b.id) : 0,
    };
  });
  const orphan = inp.debits.filter((d) => !buildingIds.has(d.buildingId));
  if (orphan.length) buildings.push({
    id: null, name: DELETED_BUILDING, poolId: null, poolName: "", drawsFromBank: false,
    drawn: orphan.reduce((s, d) => s + d.tokens, 0),
    drawnSubscription: orphan.reduce((s, d) => s + (isDurable(d) ? 0 : d.tokens), 0),
    drawnDurable: orphan.reduce((s, d) => s + (isDurable(d) ? d.tokens : 0), 0),
    drawnMemberFunded: orphan.reduce((s, d) => s + (d.grantId ? d.tokens : 0), 0),
    donated: 0, donationsSpent: 0, held: 0, explorationTokensPerDay: 0,
  });

  // the Bank's own figures, from the credits as a whole (Bank.totals), not from the pools
  let bankExpiring = 0;
  for (const c of live) bankExpiring += Math.max(0, c.tokens - (byCredit.get(c.id) ?? 0));
  const balanceTokens = bankExpiring + Math.max(0, durableIn - durableDebits);
  const overshootTokens = Math.max(0, durableDebits - durableIn);

  const poolsLeftTokens = pools.reduce((s, p) => s + p.left, 0);
  const poolsOverdrawnTokens = pools.reduce((s, p) => s + p.overdrawn, 0);
  const sumB = buildings.reduce((s, b) => s + b.drawn, 0), sumP = pools.reduce((s, p) => s + p.drawn, 0);
  const drawsDiff = Math.abs(sumB - usedBank) + Math.abs(sumP - usedBank);
  const balanceDiff = poolsLeftTokens - poolsOverdrawnTokens + unsharedTokens - (balanceTokens - overshootTokens);
  return {
    pools, buildings, sharedPct: round(sharedPct), balanceTokens, overshootTokens, poolsLeftTokens, poolsOverdrawnTokens, unsharedTokens, usedBank,
    donatedTokens: buildings.reduce((s, b) => s + b.donated, 0), heldTokens: buildings.reduce((s, b) => s + b.held, 0),
    sumCheck: {
      drawsOk: drawsDiff === 0, drawsDiff, balanceOk: balanceDiff === 0, balanceDiff, ok: drawsDiff === 0 && balanceDiff === 0,
      identities: { draws: POOLS_DRAWS_IDENTITY, balance: POOLS_BALANCE_IDENTITY },
    },
    at: iso,
  };
}

/** financePools over the world's ledgers (Bank.pools); the Bank passes its shares and inflow, the caller the allowances. */
export function townPools(repos: Repos, bank: { shares(): Map<string, { pct: number; explicit: boolean }>; dailyInflow(): number }, allowance: (buildingId: string) => number, now = new Date()): FinancePools {
  return financePools({
    pools: repos.bankPools.all(),
    buildings: repos.buildings.all(),
    shares: bank.shares(),
    credits: repos.bankCredits.all(),
    debits: repos.bankDebits.all(),
    allocations: repos.allocations.all(),
    dailyInflowTokens: bank.dailyInflow(),
    allowance,
  }, now);
}

const round = (n: number) => Math.round(n * 100) / 100;
