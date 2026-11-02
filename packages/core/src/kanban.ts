import type { Assignment, QueueBoard, QueueCard, QueueLane } from "@muster-town/schema";
import { sessionTokens } from "./bank.ts";
import { describeWait } from "./waits.ts";
import type { World } from "./world.ts";

/** Done cards stay on the board this long. */
export const QUEUE_DONE_MS = 24 * 60 * 60_000;

/**
 * The kanban (docs/goals.md "Kanban: the queue as a board", build step 6): a building's assignments as four columns.
 * Queued = pending, not held, in queue order; Held = pending with a held reason, an unmet wait or an open offer;
 * Running = active, with its live session's adjusted tokens; Done = done or cancelled in the last 24 h. The WIP limit
 * shown is the building's desks (`headcount`); nothing is enforced here. Read-only: no schema change, no Bank write.
 */
export function queueLane(world: World, buildingId: string, now = new Date()): QueueLane {
  const b = world.buildings.require(buildingId, "building");
  const since = new Date(now.getTime() - QUEUE_DONE_MS).toISOString();
  const card = (a: Assignment, extra: Partial<QueueCard> = {}): QueueCard => ({
    id: a.id, title: a.title, lane: a.lane, grantId: a.grantId, keyResultId: a.keyResultId, agentId: a.agentId,
    // building-queue work waiting for a fork names no one yet
    agentName: a.queue === "building" && a.status === "pending" ? "next free desk" : world.nameOf(a.agentId),
    status: a.status, createdAt: a.createdAt, updatedAt: a.updatedAt, heldReason: null, tokens: null, reportId: a.reportId, ...extra,
  });
  const lane: QueueLane = { buildingId: b.id, buildingName: b.name, desks: b.headcount, queued: [], held: [], running: [], done: [] };
  for (const a of world.assignments.where("buildingId = ? AND status = 'pending'", [b.id], "ORDER BY position, createdAt, rowid")) {
    const held = a.heldReason ?? (a.waitFor ? `waits for ${describeWait(world, a.waitFor)}` : a.offered ? "offered to a visitor" : null);
    (held ? lane.held : lane.queued).push(card(a, { heldReason: held }));
  }
  for (const a of world.assignments.where("buildingId = ? AND status = 'active'", [b.id], "ORDER BY updatedAt, rowid")) {
    const live = world.sessions.where("assignmentId = ? AND status = 'running'", [a.id]);
    lane.running.push(card(a, { tokens: live.reduce((n, s) => n + sessionTokens(s), 0) }));
  }
  lane.done = world.assignments.where("buildingId = ? AND status IN ('done', 'cancelled') AND updatedAt > ?", [b.id, since], "ORDER BY updatedAt DESC, rowid DESC").map((a) => card(a));
  return lane;
}

/** GET /api/buildings/:id/queue: one building's board. */
export function buildingBoard(world: World, buildingId: string, now = new Date()): QueueBoard {
  return { lanes: [queueLane(world, buildingId, now)], at: now.toISOString() };
}

/** GET /api/goals/:id/queue: one swimlane per building attached anywhere in the goal's subtree. */
export function goalBoard(world: World, goalId: string, now = new Date()): QueueBoard {
  world.goalTree.require(goalId);
  const sub = world.goalTree.subtreeIds(goalId);
  const buildings = world.buildings.all().filter((b) => b.kind !== "town-hall" && sub.has(world.goalTree.attachmentOf(b)));
  return { lanes: buildings.map((b) => queueLane(world, b.id, now)), at: now.toISOString() };
}
