import type { Assignment, Building, LaneFields } from "@muster-town/schema";
import { badRequest } from "./errors.ts";
import type { Holder } from "./permissions.ts";
import { BUDGET_POLICY } from "./policy.ts";
import type { World } from "./world.ts";

/** The lane part of an assignment. */
export type Lane = Pick<Assignment, "lane" | "grantId" | "keyResultId" | "gap">;
export const DIRECTED: Lane = { lane: "directed", grantId: null, keyResultId: null, gap: null };

const goalDirected = (b: Building | undefined) => b?.budgetMode === "goal-directed";

/**
 * The lane of a new assignment (docs/goal-directed-budgets.md, three spend lanes). Given fields are validated:
 * exploration names a key result of the building or a goal gap; grant names a grant of the building and one of its key
 * results. No fields: a continuation (`from`) inherits its lane, anything else is directed. In a goal-directed building
 * an agent can't create directed work (meeting decisions are exempt: meetings are started by humans or the scheduler).
 */
export function resolveLane(world: World, buildingId: string, createdBy: Holder | { kind: "system"; id: string }, input: LaneFields | undefined, opts: { from?: Assignment; fromMeeting?: boolean } = {}): Lane {
  const building = world.buildings.get(buildingId);
  const gap = input?.gap?.trim() || null;
  const lane = input?.lane ?? (input?.grantId ? "grant" : input?.keyResultId || gap ? "exploration" : undefined);
  if (!lane && opts.from) return { lane: opts.from.lane, grantId: opts.from.grantId, keyResultId: opts.from.keyResultId, gap: opts.from.gap };
  if (!lane || lane === "directed") {
    if (goalDirected(building) && !opts.fromMeeting && createdBy.kind !== "system" && (createdBy.kind === "agent" || !BUDGET_POLICY.directedBypassesGrants)) {
      throw badRequest(`${building!.name} is goal-directed: say lane "grant" (grantId + keyResultId) or "exploration" (keyResultId or gap)${createdBy.kind === "agent" ? "; agents can't create directed work" : ""}.`);
    }
    return DIRECTED;
  }
  const kr = input?.keyResultId ? world.keyResults.get(input.keyResultId) : undefined;
  if (input?.keyResultId && !kr) throw badRequest(`Unknown key result ${input.keyResultId}.`);
  const krGrant = kr ? world.grants.get(kr.grantId) : undefined;
  if (kr && krGrant?.buildingId !== buildingId) throw badRequest(`Key result ${kr.id} is not one of this building's grants.`);
  if (lane === "exploration") {
    if (!kr && !gap) throw badRequest("An exploration assignment names a key result (keyResultId) or a goal gap (gap: one sentence on what is missing between the goal and the live town).");
    return { lane, grantId: null, keyResultId: kr?.id ?? null, gap };
  }
  if (!input?.grantId || !kr) throw badRequest("A grant assignment needs grantId and a keyResultId of that grant.");
  const g = world.grants.get(input.grantId);
  if (!g || g.buildingId !== buildingId) throw badRequest(`Grant ${input.grantId} is not one of this building's grants.`);
  if (kr.grantId !== g.id) throw badRequest(`Key result ${kr.id} belongs to another grant (${kr.grantId}).`);
  if (g.status === "closed" || g.status === "rejected" || g.status === "draft") throw badRequest(`Grant ${g.id} is ${g.status}: work can't be charged to it.`);
  return { lane, grantId: g.id, keyResultId: kr.id, gap };
}

/** The manager's checkpoint-report assignment (lane grant without a key result, created by the system): it may run while its grant is at checkpoint. */
export function isCheckpointAssignment(a: Pick<Assignment, "lane" | "grantId" | "keyResultId" | "createdBy">): boolean {
  return a.lane === "grant" && !!a.grantId && !a.keyResultId && a.createdBy === "system";
}

/**
 * Why the lane gate holds this assignment now, or null (the gate half of `Budget.canStart`). Open buildings: never.
 * grant → the grant is funded (its checkpoint assignment also runs at checkpoint); exploration → the building's
 * exploration spend today is under its allowance; directed → nothing extra.
 */
export function laneHold(world: World, a: Assignment): string | null {
  const building = world.buildings.get(a.buildingId);
  if (!goalDirected(building)) return null;
  if (a.lane === "grant") {
    const g = a.grantId ? world.grants.get(a.grantId) : undefined;
    if (!g) return "held: its grant doesn't exist";
    if (g.status === "funded") return null;
    if (g.status === "checkpoint") return isCheckpointAssignment(a) ? null : "held: grant at checkpoint";
    if (g.status === "proposed" || g.status === "countered" || g.status === "draft") return "held: grant not funded yet";
    return `held: grant ${g.status}`;
  }
  if (BUDGET_POLICY.grantReservations && world.budget.remaining(a.buildingId) - reservedTokens(world, a.buildingId) <= 0) {
    return "held: the building's tokens are reserved for its funded grants";
  }
  if (a.lane === "exploration") {
    const e = world.grantDesk.exploration(a.buildingId);
    if (e.spentTodayTokens >= e.allowanceTokens) return `held: exploration allowance spent today (${fmt(e.spentTodayTokens)} / ${fmt(e.allowanceTokens)} tokens)`;
  }
  return null;
}

/** Unspent tokens of the building's funded grants (only used when grants are reservations, BUDGET_POLICY.grantReservations). */
function reservedTokens(world: World, buildingId: string): number {
  return world.grants.where("buildingId = ? AND status IN ('funded', 'checkpoint')", [buildingId])
    .reduce((s, g) => s + Math.max(0, (g.grantTokens ?? 0) - world.grantDesk.spent(g.id)), 0);
}

const fmt = (n: number) => n.toLocaleString("en-US");
