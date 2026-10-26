import type { Assignment, Building, LaneFields, Meeting } from "@muster-town/schema";
import { badRequest } from "./errors.ts";
import type { Holder } from "./permissions.ts";
import { BUDGET_POLICY } from "./policy.ts";
import type { World } from "./world.ts";

/** The lane part of an assignment. */
export type Lane = Pick<Assignment, "lane" | "grantId" | "keyResultId" | "gap" | "sourceId">;
export const DIRECTED: Lane = { lane: "directed", grantId: null, keyResultId: null, gap: null, sourceId: null };

const goalDirected = (b: Building | undefined) => b?.budgetMode === "goal-directed";

/** Did a human take part in the meeting (a 1:1, or a human spoke)? Its decisions trace to a human ask. */
export function meetingHadHuman(m: Meeting): boolean {
  return !!m.withUserId || m.transcript.some((u) => u.speakerKind === "user");
}

/**
 * Validate a directed assignment's human source (1:1 mt_ryw7ejayvu) and return its id: a meeting a human took part in
 * (or its notes), a doc a human wrote (a flag, a human-report, ...), a rollup or report a human decided with a reply,
 * or a human's tell. Anything else is refused.
 */
export function humanSource(world: World, sourceId: string): string {
  const meeting = world.meetings.get(sourceId);
  if (meeting) {
    if (!meetingHadHuman(meeting)) throw badRequest(`Meeting ${sourceId} had no human in it: it isn't a human source for directed work.`);
    return sourceId;
  }
  const msg = world.messages.get(sourceId);
  if (msg) {
    if (msg.kind !== "tell" || msg.fromKind !== "user") throw badRequest(`Message ${sourceId} isn't a human's tell: it isn't a human source for directed work.`);
    return sourceId;
  }
  const doc = world.docs.get(sourceId);
  if (!doc) throw badRequest(`Unknown source ${sourceId}: give the id of a meeting with a human, its notes, a flag, a human-report, a rollup a human replied to, or a human's tell.`);
  if (doc.authorKind === "user") return sourceId;
  const notesOf = doc.type === "meeting-notes" ? world.meetings.first("notesDocId = ?", [doc.id]) : undefined;
  if (notesOf && meetingHadHuman(notesOf)) return sourceId;
  if (doc.decidedBy && world.users.get(doc.decidedBy) && doc.decisionNote) return sourceId;
  throw badRequest(`${doc.id} ("${doc.title}") isn't human-authored: directed work cites meeting notes of a meeting with a human, a flag, a human-report, a rollup a human replied to, or a human's tell.`);
}

/**
 * The lane of a new assignment (docs/goal-directed-budgets.md, three spend lanes). Given fields are validated:
 * exploration names a key result of the building goal that no funded grant works on, or a goal gap; grant names a grant
 * of the building (its key result is implied and stored on the assignment; a keyResultId given must be that one). No
 * fields: a continuation (`from`) inherits its lane, anything else is directed. In a goal-directed building an agent
 * creates directed work only when it cites a human source (`sourceId`, 1:1 mt_ryw7ejayvu). Meeting decisions stay
 * exempt (meetings are started by humans or the scheduler); one of a meeting a human took part in records the meeting
 * as its source (`humanMeetingId`). Directed work may name a key result or gap: a key result
 * makes it stop (held) once a grant proposal names it.
 */
export function resolveLane(world: World, buildingId: string, createdBy: Holder | { kind: "system"; id: string }, input: LaneFields | undefined, opts: { from?: Assignment; fromMeeting?: boolean; humanMeetingId?: string } = {}): Lane {
  const building = world.buildings.get(buildingId);
  const gap = input?.gap?.trim() || null;
  const lane = input?.lane ?? (input?.grantId ? "grant" : input?.keyResultId || gap ? "exploration" : input?.sourceId ? "directed" : undefined);
  if (!lane && opts.from) return { lane: opts.from.lane, grantId: opts.from.grantId, keyResultId: opts.from.keyResultId, gap: opts.from.gap, sourceId: opts.from.sourceId ?? null };
  if (!lane || lane === "directed") {
    const sourceId = input?.sourceId ? humanSource(world, input.sourceId) : opts.humanMeetingId ?? null;
    if (goalDirected(building) && !sourceId && !opts.fromMeeting && createdBy.kind !== "system" && (createdBy.kind === "agent" || !BUDGET_POLICY.directedBypassesGrants)) {
      throw badRequest(`${building!.name} is goal-directed: say lane "grant" (grantId of a funded grant) or "exploration" (keyResultId of a goal key result with no funded grant, or gap)${createdBy.kind === "agent" ? "; agents can't create directed work" : ""}.`);
    }
    const kr = input?.keyResultId ? world.keyResults.get(input.keyResultId) : undefined;
    if (input?.keyResultId && (!kr || kr.buildingId !== buildingId)) throw badRequest(`Key result ${input.keyResultId} is not one of this building's goal key results.`);
    const proposed = kr ? world.grants.first("keyResultId = ? AND status NOT IN ('draft', 'rejected')", [kr.id], "ORDER BY createdAt") : undefined;
    if (proposed) throw badRequest(`Key result ${kr!.id} already has a grant proposal (${proposed.id}, ${proposed.status}): directed work naming it would stop at once; leave keyResultId out or work in lane "grant".`);
    return { ...DIRECTED, keyResultId: kr?.id ?? null, gap, sourceId };
  }
  const kr = input?.keyResultId ? world.keyResults.get(input.keyResultId) : undefined;
  if (input?.keyResultId && !kr) throw badRequest(`Unknown key result ${input.keyResultId}.`);
  if (kr && kr.buildingId !== buildingId) throw badRequest(`Key result ${kr.id} is not one of this building's goal key results.`);
  if (lane === "exploration") {
    if (!kr && !gap) throw badRequest("An exploration assignment names a key result of the building goal (keyResultId) or a goal gap (gap: one sentence on what is missing between the goal and the live town).");
    const live = kr ? world.grantDesk.liveGrantOf(kr.id) : undefined;
    if (live) throw badRequest(`Key result ${kr!.id} has a funded grant (${live.id}): work on it in lane "grant" with grantId ${live.id}.`);
    return { lane, grantId: null, keyResultId: kr?.id ?? null, gap, sourceId: null };
  }
  if (!input?.grantId) throw badRequest("A grant assignment names its grant (grantId); the grant's key result is implied.");
  const g = world.grants.get(input.grantId);
  if (!g || g.buildingId !== buildingId) throw badRequest(`Grant ${input.grantId} is not one of this building's grants.`);
  if (kr && kr.id !== g.keyResultId) throw badRequest(`Grant ${g.id} works toward key result ${g.keyResultId ?? "(none)"}, not ${kr.id}; leave keyResultId out.`);
  if (g.status === "closed" || g.status === "rejected" || g.status === "draft") throw badRequest(`Grant ${g.id} is ${g.status}: work can't be charged to it.`);
  return { lane, grantId: g.id, keyResultId: g.keyResultId, gap, sourceId: null };
}

/**
 * The manager's checkpoint-report assignment (lane grant without a key result, created by the system): it may run while
 * its grant is at checkpoint. Other grant work stores its grant's key result, and a grant can't be funded without one.
 */
export function isCheckpointAssignment(a: Pick<Assignment, "lane" | "grantId" | "keyResultId" | "createdBy">): boolean {
  return a.lane === "grant" && !!a.grantId && !a.keyResultId && a.createdBy === "system";
}

/**
 * Why the lane gate holds this assignment now, or null (the gate half of `Budget.canStart`). Open buildings: never.
 * grant → the grant is funded (its checkpoint assignment also runs at checkpoint); exploration → the building's
 * exploration spend today is under its allowance; directed → never the allowance, but one naming a key result stops
 * once a grant proposal names that key result (its default stop condition).
 */
export function laneHold(world: World, a: Assignment): string | null {
  return laneBlock(world, a)?.reason ?? null;
}

/** `laneHold` with what it is: the grant hold (and its grant), the reservation hold, the spent exploration allowance, or directed work done (a grant proposal names its key result). */
export function laneBlock(world: World, a: Assignment): { kind: "grant" | "reserved" | "exploration" | "done"; reason: string; grantId?: string; used?: number; allowance?: number } | null {
  const building = world.buildings.get(a.buildingId);
  if (!goalDirected(building)) return null;
  if (a.lane === "grant") {
    const g = a.grantId ? world.grants.get(a.grantId) : undefined;
    const grantId = a.grantId ?? undefined;
    if (!g) return { kind: "grant", grantId, reason: "held: its grant doesn't exist" };
    if (g.status === "funded") return null;
    if (g.status === "checkpoint") return isCheckpointAssignment(a) ? null : { kind: "grant", grantId, reason: "held: grant at checkpoint" };
    if (g.status === "proposed" || g.status === "countered" || g.status === "draft") return { kind: "grant", grantId, reason: "held: grant not funded yet" };
    return { kind: "grant", grantId, reason: `held: grant ${g.status}` };
  }
  if (BUDGET_POLICY.grantReservations && world.budget.remaining(a.buildingId) - reservedTokens(world, a.buildingId) <= 0) {
    return { kind: "reserved", reason: "held: the building's tokens are reserved for its funded grants" };
  }
  if (a.lane === "exploration") {
    const e = world.grantDesk.exploration(a.buildingId);
    if (e.spentTodayTokens >= e.allowanceTokens) return { kind: "exploration", used: e.spentTodayTokens, allowance: e.allowanceTokens, reason: `held: exploration allowance spent today (${fmt(e.spentTodayTokens)} / ${fmt(e.allowanceTokens)} tokens)` };
  }
  // directed work is never held by the allowance; one naming a key result runs until a grant proposal names it
  if (a.lane === "directed" && a.keyResultId) {
    const g = world.grants.first("keyResultId = ? AND status NOT IN ('draft', 'rejected')", [a.keyResultId], "ORDER BY createdAt");
    if (g) return { kind: "done", grantId: g.id, reason: `held: done once a grant proposal names its key result (${g.id}, ${g.status})` };
  }
  return null;
}

/** Unspent tokens of the building's funded grants (only used when grants are reservations, BUDGET_POLICY.grantReservations). */
function reservedTokens(world: World, buildingId: string): number {
  return world.grants.where("buildingId = ? AND status IN ('funded', 'checkpoint')", [buildingId])
    .reduce((s, g) => s + Math.max(0, (g.grantTokens ?? 0) - world.grantDesk.spent(g.id)), 0);
}

const fmt = (n: number) => n.toLocaleString("en-US");
