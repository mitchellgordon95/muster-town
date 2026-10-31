/**
 * Declarative exploration (docs/how-work-gets-done.md §3; build step 3, 1:1 mt_wql34b8gkl). The rule lives on the goal
 * (`explore`, `exploreChunkTokens`, the optional `exploreCapTokensPerDay`; inherited, free-tokens.ts `exploreRuleAt`).
 * The runtime tick, not a manager, starts explorers: for each goal-directed building whose rule is on, with a free desk
 * and nothing else forkable queued, no explorer of its own open, none started in the last EXPLORE_MIN_GAP_MS, no open
 * proposal of its own and free tokens ≥ the chunk (under the cap), it reserves one chunk (bank_reservations) and queues one
 * exploration assignment on the building queue. The reservation is a claim on free tokens; its sessions' spend shrinks
 * it, and it closes (unspent returns) once its assignment is no longer pending or active.
 */
import type { Assignment, BankReservation, Building } from "@muster-town/schema";
import { buildingQueue, createAssignment, managerAgentOf } from "./domain.ts";
import { familyCap } from "./budget.ts";
import { sessionView } from "./bank.ts";
import { exploreCapAt, exploreRuleAt, exploreSpentToday, freeTokensAll } from "./free-tokens.ts";
import { freeDesks } from "./forks.ts";
import { laneGated } from "./lanes.ts";
import { interruptNow } from "./wakes.ts";
import { newId, truncate } from "./util.ts";
import type { World } from "./world.ts";

/** At most one new explorer per building per this long (docs/how-work-gets-done.md §3). */
export const EXPLORE_MIN_GAP_MS = 30 * 60_000;
/** An explorer whose session has used this share of its chunk is asked once to wrap up and file. */
export const EXPLORE_CEILING_SHARE = 0.9;

/** Adjusted tokens the sessions of an assignment have booked so far (running sessions included). */
export function assignmentSpent(world: World, assignmentId: string): number {
  return world.sessions.where("assignmentId = ?", [assignmentId]).reduce((s, x) => s + sessionView(x).adjustedOutputTokens, 0);
}

/** What an open reservation still claims: its tokens less what its sessions have spent (they draw on it first). */
export function reservationLeft(world: World, r: BankReservation): number {
  if (r.closedAt) return 0;
  return Math.max(0, r.tokens - (r.assignmentId ? assignmentSpent(world, r.assignmentId) : 0));
}

/** Why the tick would not start an explorer in this building now, or null when it would (the Queue tab shows it). */
export function exploreBlock(world: World, b: Building, now = new Date(), free = freeTokensAll(world, now)): string | null {
  if (!laneGated(b)) return "the Town Hall never explores";
  const goalId = world.goalTree.attachmentOf(b);
  const rule = exploreRuleAt(world.goals, goalId);
  if (!rule.on) return `exploration is off (set on goal ${rule.onFrom})`;
  const manager = managerAgentOf(world, b);
  if (!manager || manager.status === "banned" || manager.status === "retired") return "no manager to fork";
  if (world.budget.remaining(b.id) <= 0 || manager.familySpentToday >= familyCap(b)) return "the building's budget for today is spent";
  if (freeDesks(world, b) <= 0) return "no free desk";
  if (buildingQueue(world, b.id).some((a) => !a.waitFor && !a.offered && world.budget.holdReason(a) === null)) return "other work is queued for its desks";
  if (world.bankReservations.first("buildingId = ? AND closedAt IS NULL", [b.id])) return "an explorer of this building is still open";
  const last = world.bankReservations.first("buildingId = ?", [b.id], "ORDER BY openedAt DESC");
  if (last && now.getTime() - Date.parse(last.openedAt) < EXPLORE_MIN_GAP_MS) return `the last explorer started under ${EXPLORE_MIN_GAP_MS / 60_000} min ago`;
  if (world.grants.first("buildingId = ? AND status IN ('proposed', 'countered')", [b.id])) return "a proposal of this building is open and undecided";
  const f = free.get(goalId)?.freeTokens ?? 0;
  if (f < rule.chunkTokens) return `free tokens under the goal (${f.toLocaleString("en-US")}) are less than one chunk (${rule.chunkTokens.toLocaleString("en-US")})`;
  const cap = exploreCapAt(world.goals, goalId);
  if (cap && exploreSpentToday(world, cap.goalId, now) + rule.chunkTokens > cap.tokensPerDay) return `the exploration cap set on goal ${cap.goalId} would be passed today`;
  return null;
}

/** Open one reservation and queue its explorer (one building, its rule already checked by `exploreBlock`). */
function startExplorer(world: World, b: Building, now: Date): Assignment {
  const goalId = world.goalTree.attachmentOf(b);
  const goal = world.goals.get(goalId);
  const rule = exploreRuleAt(world.goals, goalId);
  const manager = managerAgentOf(world, b)!;
  const goalText = truncate(goal?.text ?? b.name, 200);
  return world.transaction(() => {
    const r = world.bankReservations.upsert({ id: newId("rs"), goalId, buildingId: b.id, assignmentId: null, tokens: rule.chunkTokens, openedAt: now.toISOString(), closedAt: null, spentTokens: null });
    const a = createAssignment(world, {
      agentId: manager.id, buildingId: b.id, queue: "building", createdBy: { kind: "system", id: r.id },
      title: `Explore under "${truncate(goal?.text ?? b.name, 70)}"`,
      description: `The town's explore tick reserved ${rule.chunkTokens.toLocaleString("en-US")} tokens (${r.id}) for this session because ${b.name} had a free desk and free tokens under its goal ${goalId}. Pick ONE direction under the goal, investigate it this session (the live town, the code, the web), and end with ONE grant proposal (\`propose_grant\`: goalId in your subtree, objective, approach, stopCondition, askTokens, 2-4 keyResults with howToCheck and due), or, if nothing is worth a grant, a short report on why. Stay within the chunk: you are asked to wrap up at ${Math.round(EXPLORE_CEILING_SHARE * 100)}% of it.`,
      lane: { lane: "exploration", gap: `Explore under: ${goalText}`.slice(0, 300) }, reservationId: r.id,
    });
    world.bankReservations.upsert({ ...r, assignmentId: a.id });
    world.events.append({
      type: "exploration.reserved", agentId: manager.id, buildingId: b.id,
      text: `${b.name}: the explore tick reserved ${rule.chunkTokens.toLocaleString("en-US")} tokens and queued an explorer under "${truncate(goal?.text ?? goalId, 80)}"`,
      payload: { reservationId: r.id, assignmentId: a.id, goalId, tokens: rule.chunkTokens },
    });
    return a;
  });
}

/** Close the open reservations whose assignment is no longer pending or active: what its sessions spent is booked, the rest returns. */
function closeReservations(world: World, now: Date): BankReservation[] {
  const closed: BankReservation[] = [];
  for (const r of world.bankReservations.where("closedAt IS NULL")) {
    const a = r.assignmentId ? world.assignments.get(r.assignmentId) : undefined;
    if (a && (a.status === "pending" || a.status === "active")) continue;
    const spent = r.assignmentId ? assignmentSpent(world, r.assignmentId) : 0;
    const c = world.bankReservations.upsert({ ...r, closedAt: now.toISOString(), spentTokens: spent });
    world.events.append({
      type: "exploration.closed", buildingId: r.buildingId,
      text: `Explorer reservation ${r.id} closed: ${spent.toLocaleString("en-US")} of ${r.tokens.toLocaleString("en-US")} tokens spent, ${Math.max(0, r.tokens - spent).toLocaleString("en-US")} returned to free tokens`,
      payload: { reservationId: r.id, assignmentId: r.assignmentId, goalId: r.goalId, tokens: r.tokens, spentTokens: spent, status: a?.status ?? null },
    });
    closed.push(c);
  }
  return closed;
}

/** `exploration.started` once per reservation (its assignment went active); the wrap-up ask once its session nears the chunk. */
function watchExplorers(world: World): void {
  for (const r of world.bankReservations.where("closedAt IS NULL AND assignmentId IS NOT NULL")) {
    const a = world.assignments.get(r.assignmentId!);
    if (a?.status !== "active") continue;
    const seen = (type: string) => !!world.db.prepare("SELECT 1 FROM events WHERE type = ? AND json_extract(payload, '$.reservationId') = ? LIMIT 1").get(type, r.id);
    if (!seen("exploration.started")) {
      world.events.append({ type: "exploration.started", agentId: a.agentId, buildingId: r.buildingId, text: `${world.nameOf(a.agentId)} started exploring (${r.tokens.toLocaleString("en-US")}-token chunk ${r.id})`, payload: { reservationId: r.id, assignmentId: a.id, goalId: r.goalId } });
    }
    const spent = assignmentSpent(world, a.id);
    if (spent >= EXPLORE_CEILING_SHARE * r.tokens && !world.db.prepare("SELECT 1 FROM events WHERE type = 'system' AND json_extract(payload, '$.exploreCeiling') = ? LIMIT 1").get(r.id)) {
      interruptNow(world, a.agentId, `You have used ${spent.toLocaleString("en-US")} of the ${r.tokens.toLocaleString("en-US")} tokens reserved for this exploration. Don't start anything new: file your grant proposal now (\`propose_grant\`), or if nothing is worth a grant say why, then \`submit_report\`.`, "The explore tick");
      world.events.append({ type: "system", agentId: a.agentId, buildingId: r.buildingId, text: `${world.nameOf(a.agentId)} reached ${Math.round(EXPLORE_CEILING_SHARE * 100)}% of its exploration chunk and was asked to file`, payload: { exploreCeiling: r.id, assignmentId: a.id, spentTokens: spent, tokens: r.tokens } });
    }
  }
}

/** The runtime tick's explore step: close finished reservations, watch running explorers, then start at most one explorer per building. */
export function exploreTick(world: World, now = new Date()): { started: Assignment[]; closed: BankReservation[] } {
  const closed = closeReservations(world, now);
  watchExplorers(world);
  const started: Assignment[] = [];
  let free = freeTokensAll(world, now);
  for (const b of world.buildings.all()) {
    if (exploreBlock(world, b, now, free) !== null) continue;
    started.push(startExplorer(world, b, now));
    free = freeTokensAll(world, now); // the new reservation claims its chunk
  }
  return { started, closed };
}
