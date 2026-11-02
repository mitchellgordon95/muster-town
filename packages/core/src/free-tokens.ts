import { ROOT_GOAL_ID, type ExploreRule, type FreeTokens, type GoalFunding } from "@muster-town/schema";
import type { Repos } from "./store.ts";
import { reservationLeft } from "./explore.ts";
import { retainerClaims } from "./retainers.ts";
import type { World } from "./world.ts";

type OverdraftedClaim = NonNullable<FreeTokens["overdrafted"]>[number];

/**
 * Free tokens and the exploration cap (docs/how-work-gets-done.md §7, §8; build step 1, as_1nuoiauxlw). There are no
 * Bank pools: one general balance, plus earmarks (a credit scoped to a goal's subtree). Four kinds of claim sit on them:
 * funded grants' remaining tokens (granted − spent), open proposals' asks, open exploration reservations, and funded
 * retainers (tokensPerRun × runs left of a schedule a human approved, retainers.ts). Each claim
 * is paid where its session would draw (the draw order): the nearest earmark walking up from its goal, then the general
 * balance. Free tokens under a goal = what the claims leave of the general balance less the operating reserve (town
 * `operatingReserveTokens`, 1:1 mt_lb7tm75jgb: kept for 1:1s, meetings and directed work) + of the earmarks at or above it.
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

/** One claim on the Bank: the goal its work sits on, its tokens, and what it is (for the overdraft walk's order and its list). */
interface Claim { goalId: string; tokens: number; kind: "funded" | "ask" | "reserved" | "retainer"; id: string; title: string; at: string }

/**
 * The overdraft walk's order (Mitchell, 2026-11-01): claims are covered by the usable balance first come, first served by
 * urgency. Retainers first (their runs are due at a time), then funded grants by when they were funded, then open
 * exploration reservations, then proposals' asks last (an ask is not yet a promise, so it soaks up a shortfall first).
 */
const ORDER: Record<Claim["kind"], number> = { retainer: 0, funded: 1, reserved: 2, ask: 3 };
const byOrder = (a: Claim, b: Claim) => ORDER[a.kind] - ORDER[b.kind] || a.at.localeCompare(b.at) || a.id.localeCompare(b.id);

/** The goal a grant's work sits on (its `goalId`, else its building's attachment): where its claim is paid from. */
export function grantGoalOf(world: World, g: { buildingId: string; id: string }): string {
  return world.streams.nodeOf({ buildingId: g.buildingId, grantId: g.id, keyResultId: null }, g.buildingId);
}

/** Every claim in the town: live grants' remaining, open proposals' asks, open reservations (`except`: leave that grant's claim out). */
function claims(world: World, except?: string, now = new Date()): Claim[] {
  const out: Claim[] = [];
  const nodeOf = (g: { buildingId: string; id: string }) => grantGoalOf(world, g);
  for (const g of world.grants.where("status IN ('funded', 'checkpoint')")) {
    if (g.id === except) continue;
    const left = Math.max(0, (g.grantTokens ?? 0) - world.grantDesk.spent(g.id));
    if (left > 0) out.push({ goalId: nodeOf(g), tokens: left, kind: "funded", id: g.id, title: g.objective, at: g.fundedAt ?? g.createdAt });
  }
  for (const g of world.grants.where("status IN ('proposed', 'countered')")) {
    if (g.id === except) continue;
    if (g.askTokens > 0) out.push({ goalId: nodeOf(g), tokens: g.askTokens, kind: "ask", id: g.id, title: g.objective, at: g.createdAt });
  }
  // an open reservation claims what its sessions haven't spent yet (they draw on it first; their spend is already off the balance)
  for (const r of world.bankReservations.where("closedAt IS NULL")) {
    const left = reservationLeft(world, r);
    if (left > 0) out.push({ goalId: r.goalId, tokens: left, kind: "reserved", id: r.id, title: `exploration reservation ${r.id}`, at: r.openedAt });
  }
  // a funded retainer claims tokensPerRun × runs left (1:1 mt_cyd2t5ioob decision 2; retainers.ts)
  for (const c of retainerClaims(world, now)) out.push({ ...c, kind: "retainer" });
  return out.sort(byOrder);
}

/**
 * Free tokens under every goal in one pass (GET /api/goals, the Bank's Free tokens tab). Keys: goal ids. `except`: a
 * grant whose own claim is left out (funding it asks what is free besides it).
 */
export function freeTokensAll(world: World, now = new Date(), except?: string): Map<string, FreeTokens> {
  const bank = world.bank;
  // what each goal's own live earmarks hold, consumed by the claims under it nearest-first
  const held = new Map<string, number>();
  for (const inp of bank.earmarks()) {
    if (inp.cancelledAt || !inp.goalId) continue;
    held.set(inp.goalId, (held.get(inp.goalId) ?? 0) + bank.inputBalance(inp.id, now));
  }
  const earmark = new Map(held);
  // promised and available (docs/bank.md): claims are covered by what sessions can actually draw on, not by every credit
  const promisedTokens = bank.balance(now);
  const unavailable = bank.unavailable(now);
  const generalTokens = Math.max(0, promisedTokens - unavailable.tokens);
  const reserveTokens = world.town.get().operatingReserveTokens;
  let general = generalTokens - reserveTokens;
  const totals = { funded: 0, ask: 0, reserved: 0, retainer: 0 };
  let retainerJobs = 0;
  const overdrafted: OverdraftedClaim[] = [];
  for (const c of claims(world, except, now)) {
    totals[c.kind] += c.tokens;
    if (c.kind === "retainer") retainerJobs++;
    let left = c.tokens;
    for (const g of world.goalTree.ancestors(c.goalId)) {
      const have = earmark.get(g.id) ?? 0;
      if (have <= 0) continue;
      const take = Math.min(have, left);
      earmark.set(g.id, have - take);
      left -= take;
      if (left <= 0) break;
    }
    // the walk: what the usable general balance (after the reserve) still covers of this claim, in order
    const covered = Math.min(Math.max(0, general), left);
    if (covered < left && c.kind !== "ask") overdrafted.push({ kind: c.kind, id: c.id, title: c.title, tokens: c.tokens, shortTokens: left - covered });
    general -= left;
  }
  const overdraftTokens = overdrafted.reduce((s, o) => s + o.shortTokens, 0);
  const out = new Map<string, FreeTokens>();
  for (const g of world.goals.all()) {
    let earmarkTokens = 0, earmarkLeft = 0;
    for (const a of world.goalTree.ancestors(g.id)) {
      earmarkTokens += held.get(a.id) ?? 0;
      earmarkLeft += earmark.get(a.id) ?? 0;
    }
    out.set(g.id, {
      goalId: g.id, generalTokens, reserveTokens, earmarkTokens, fundedRemainingTokens: totals.funded, openAsksTokens: totals.ask, reservedTokens: totals.reserved,
      retainerTokens: totals.retainer, retainerJobs, freeTokens: Math.max(0, general) + earmarkLeft,
      // shown only when they say something: some credit can't be drawn on, or approved claims aren't backed
      ...(unavailable.tokens > 0 ? { promisedTokens, unavailableTokens: unavailable.tokens, unavailable: unavailable.inputs } : {}),
      ...(overdraftTokens > 0 ? { overdraftTokens, overdrafted } : {}),
    });
  }
  return out;
}

/**
 * The overdraft walk's verdict on one claim (a funded grant, a retainer, a reservation): how many of its tokens the usable
 * balance doesn't cover, or 0. Its work holds only when none of it is covered (a claim straddling the line runs).
 */
export function claimShort(world: World, id: string, now = new Date()): { tokens: number; shortTokens: number } | null {
  // the scheduler asks per held row every tick: one walk serves them all for a few seconds, until anything is logged
  // (a credit, a limit, a funded or closed grant, a session's end all append an event)
  const lastEvent = (world.db.prepare("SELECT MAX(id) AS id FROM events").get() as { id: number | null }).id ?? 0;
  let c = walkCache.get(world);
  if (!c || c.lastEvent !== lastEvent || Math.abs(now.getTime() - c.at) > WALK_TTL_MS) {
    c = { at: now.getTime(), lastEvent, rows: freeTokensAll(world, now).get(ROOT_GOAL_ID)?.overdrafted ?? [] };
    walkCache.set(world, c);
  }
  const o = c.rows.find((x) => x.id === id);
  return o ? { tokens: o.tokens, shortTokens: o.shortTokens } : null;
}
const WALK_TTL_MS = 5_000;
const walkCache = new WeakMap<World, { at: number; lastEvent: number; rows: OverdraftedClaim[] }>();

/** Free tokens under one goal (`Bank.freeTokens` in the doc; a goal not in the tree counts as the root). */
export function freeTokens(world: World, goalId: string, now = new Date(), except?: string): FreeTokens {
  const all = freeTokensAll(world, now, except);
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
