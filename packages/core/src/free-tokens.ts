import { ROOT_GOAL_ID, type ExploreRule, type FreeTokens, type GoalFunding } from "@muster-town/schema";
import type { Repos } from "./store.ts";
import { reservationLeft } from "./explore.ts";
import type { World } from "./world.ts";

/**
 * Free tokens and the exploration cap (docs/how-work-gets-done.md §7, §8; build step 1, as_1nuoiauxlw). There are no
 * Bank pools: one general balance, plus earmarks (a credit scoped to a goal's subtree). Three kinds of claim sit on them:
 * funded grants' remaining tokens (granted − spent), open proposals' asks, and open exploration reservations. Each claim
 * is paid where its session would draw (the draw order): the nearest earmark walking up from its goal, then the general
 * balance. Free tokens under a goal = what the claims leave of the general balance + of the earmarks at or above it.
 * Read-only: nothing is stored but the reservations.
 */

/** The nearest ancestor-or-self goal that sets an exploration cap; null = uncapped. Walks up `parentId` (cycle-safe). */
export function exploreCapAt(goals: Repos["goals"], goalId: string): { tokensPerDay: number; goalId: string } | null {
  const seen = new Set<string>();
  for (let g = goals.get(goalId); g && !seen.has(g.id); g = g.parentId ? goals.get(g.parentId) : undefined) {
    seen.add(g.id);
    if (g.exploreCapTokensPerDay !== null) return { tokensPerDay: g.exploreCapTokensPerDay, goalId: g.id };
  }
  return null;
}

/** The root's explore rule when nothing up the tree sets one (docs/how-work-gets-done.md §3): on, 100,000-token chunks. */
export const EXPLORE_CHUNK_TOKENS = 100_000;

/** The explore rule in effect at a goal: each of on/off and the chunk from the nearest ancestor-or-self that sets it (null = the root default). */
export function exploreRuleAt(goals: Repos["goals"], goalId: string): ExploreRule {
  const rule: ExploreRule = { on: true, onFrom: null, chunkTokens: EXPLORE_CHUNK_TOKENS, chunkFrom: null };
  let onSet = false, chunkSet = false;
  const seen = new Set<string>();
  for (let g = goals.get(goalId); g && !seen.has(g.id) && !(onSet && chunkSet); g = g.parentId ? goals.get(g.parentId) : undefined) {
    seen.add(g.id);
    if (!onSet && g.explore !== null) { rule.on = g.explore; rule.onFrom = g.id; onSet = true; }
    if (!chunkSet && g.exploreChunkTokens !== null) { rule.chunkTokens = g.exploreChunkTokens; rule.chunkFrom = g.id; chunkSet = true; }
  }
  return rule;
}

/** One claim on the Bank: the goal its work sits on and its tokens. */
interface Claim { goalId: string; tokens: number; kind: "funded" | "ask" | "reserved" }

/** Every claim in the town: live grants' remaining, open proposals' asks, open reservations. */
function claims(world: World): Claim[] {
  const out: Claim[] = [];
  const nodeOf = (g: { buildingId: string; id: string }) => world.streams.nodeOf({ buildingId: g.buildingId, grantId: g.id, keyResultId: null }, g.buildingId);
  for (const g of world.grants.where("status IN ('funded', 'checkpoint')")) {
    const left = Math.max(0, (g.grantTokens ?? 0) - world.grantDesk.spent(g.id));
    if (left > 0) out.push({ goalId: nodeOf(g), tokens: left, kind: "funded" });
  }
  for (const g of world.grants.where("status IN ('proposed', 'countered')")) {
    if (g.askTokens > 0) out.push({ goalId: nodeOf(g), tokens: g.askTokens, kind: "ask" });
  }
  // an open reservation claims what its sessions haven't spent yet (they draw on it first; their spend is already off the balance)
  for (const r of world.bankReservations.where("closedAt IS NULL")) {
    const left = reservationLeft(world, r);
    if (left > 0) out.push({ goalId: r.goalId, tokens: left, kind: "reserved" });
  }
  return out;
}

/** Free tokens under every goal in one pass (GET /api/goals, the Bank's Free tokens tab). Keys: goal ids. */
export function freeTokensAll(world: World, now = new Date()): Map<string, FreeTokens> {
  const bank = world.bank;
  // what each goal's own live earmarks hold, consumed by the claims under it nearest-first
  const held = new Map<string, number>();
  for (const inp of bank.earmarks()) {
    if (inp.cancelledAt || !inp.goalId) continue;
    held.set(inp.goalId, (held.get(inp.goalId) ?? 0) + bank.inputBalance(inp.id, now));
  }
  const earmark = new Map(held);
  const generalTokens = bank.balance(now);
  let general = generalTokens;
  const totals = { funded: 0, ask: 0, reserved: 0 };
  for (const c of claims(world)) {
    totals[c.kind] += c.tokens;
    let left = c.tokens;
    for (const g of world.goalTree.ancestors(c.goalId)) {
      const have = earmark.get(g.id) ?? 0;
      if (have <= 0) continue;
      const take = Math.min(have, left);
      earmark.set(g.id, have - take);
      left -= take;
      if (left <= 0) break;
    }
    general -= left;
  }
  const out = new Map<string, FreeTokens>();
  for (const g of world.goals.all()) {
    let earmarkTokens = 0, earmarkLeft = 0;
    for (const a of world.goalTree.ancestors(g.id)) {
      earmarkTokens += held.get(a.id) ?? 0;
      earmarkLeft += earmark.get(a.id) ?? 0;
    }
    out.set(g.id, {
      goalId: g.id, generalTokens, earmarkTokens, fundedRemainingTokens: totals.funded, openAsksTokens: totals.ask, reservedTokens: totals.reserved,
      freeTokens: Math.max(0, general) + earmarkLeft,
    });
  }
  return out;
}

/** Free tokens under one goal (`Bank.freeTokens` in the doc; a goal not in the tree counts as the root). */
export function freeTokens(world: World, goalId: string, now = new Date()): FreeTokens {
  const all = freeTokensAll(world, now);
  return all.get(goalId) ?? { ...all.get(ROOT_GOAL_ID)!, goalId };
}

/** Exploration spent today (UTC) under a goal: lane-exploration sessions of the buildings attached at or under it, plus the open reservations opened today there (a closed one's spend is in its sessions). */
export function exploreSpentToday(world: World, goalId: string, now = new Date()): number {
  const day = new Date(now); day.setUTCHours(0, 0, 0, 0);
  const under = world.goalTree.subtreeIds(goalId);
  const buildings = world.buildings.all().filter((b) => under.has(world.goalTree.attachmentOf(b))).map((b) => b.id);
  let spent = 0;
  for (const b of buildings) spent += world.grantDesk.laneSpentToday(b, "exploration", now);
  for (const r of world.bankReservations.where("openedAt >= ? AND closedAt IS NULL", [day.toISOString()])) if (under.has(r.goalId)) spent += r.tokens;
  return spent;
}

/** A goal's funding as GET /api/goals shows it: the effective explore rule and exploration cap (and what it has used today) and the free tokens. */
export function goalFunding(world: World, goalId: string, free?: FreeTokens, now = new Date()): GoalFunding {
  const exploreCap = exploreCapAt(world.goals, goalId);
  return { exploreCap, explore: exploreRuleAt(world.goals, goalId), exploreSpentTodayTokens: exploreCap ? exploreSpentToday(world, exploreCap.goalId, now) : 0, free: free ?? freeTokens(world, goalId, now) };
}
