/**
 * Why a queued assignment can't start (Mitchell's 1:1 mt_ryw7ejayvu): the agent's own budget, an unmet wait, or the lane
 * gate, as one `BlockedBy` with the reason in words and where the map's red line goes. Read-only: it never clears a
 * wait or changes `heldReason` (`checkWaits` and `Budget.holdReason` own those). A wait on a time (an agent's own work
 * parked with `resumeWhen {after}`) is not a block (`waitsOnTime`). Timed jobs are building schedules (schedules.ts).
 */
import { QUEUE_ORDER, type Assignment, type BlockedAssignment, type BlockedBy, type BuildingStats } from "@muster-town/schema";
import { isTownHallItem } from "./domain.ts";
import { laneBlock } from "./lanes.ts";
import { truncate } from "./util.ts";
import { chainTip, waitMet } from "./waits.ts";
import type { World } from "./world.ts";

/** 9,387,488 → "9.4M", 512,000 → "512k" */
const short = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);

/** When this queued assignment resumes by itself (its `waitFor {after}` time, still ahead), else null. */
export function waitsOnTime(a: Assignment, at: Date = new Date()): string | null {
  const w = a.waitFor;
  return a.status === "pending" && !a.offered && w && "after" in w && Date.parse(w.after) > at.getTime() ? w.after : null;
}

/** What keeps this pending assignment from starting, or null (it runs when it reaches the front of the queue, or it is scheduled). */
export function blockedBy(world: World, a: Assignment, at: Date = new Date()): BlockedBy | null {
  if (a.status !== "pending" || a.offered || waitsOnTime(a, at)) return null;
  const th = world.buildings.first("kind = 'town-hall'");
  const townHall = th ? { placeId: `intray:${th.id}` } : {};
  const w = a.waitFor;
  if (w && !waitMet(world, a, at)) {
    if ("deploy" in w) {
      const live = world.host.commit ? ` (live is ${world.host.commit.slice(0, 7)})` : "";
      return { kind: "deploy", targetId: w.deploy, placeId: `door:${a.buildingId}`, text: `waits for ${w.deploy === "next" ? "the next redeploy" : `deploy ${w.deploy.slice(0, 7)}`}${live}` };
    }
    if ("assignment" in w) {
      // a parked dependency: point at its continuation, the work that still has to finish
      const found = world.assignments.get(w.assignment);
      const dep = found && chainTip(world, found);
      return dep
        ? { kind: "assignment", targetId: dep.id, agentId: dep.agentId, text: `waits on assignment "${truncate(dep.title, 80)}" (${world.nameOf(dep.agentId)})` }
        : { kind: "assignment", targetId: w.assignment, text: `waits on assignment ${w.assignment}` };
    }
    if ("decision" in w) {
      const d = world.docs.get(w.decision);
      const tray = d?.buildingId ? (isTownHallItem(world, d) ? townHall : { placeId: `intray:${d.buildingId}` }) : townHall;
      return { kind: "decision", targetId: w.decision, ...tray, text: `waits for a decision on ${d ? `"${truncate(d.title, 80)}"` : w.decision}` };
    }
  }
  const agent = world.agents.get(a.agentId);
  if (agent && !world.budget.canStart(agent.id)) {
    const b = world.buildings.get(agent.homeBuildingId ?? agent.buildingId ?? "");
    const cap = b ? world.budget.capHold(b.id, at) : null;
    if (cap && agent.spentTokensToday < b!.dailyTokensPerAgent && world.budget.remaining(b!.id) > 0) return { kind: "budget", targetId: b!.id, placeId: "bank", text: cap };
    const text = b && agent.spentTokensToday >= b.dailyTokensPerAgent
      ? `out of budget: ${agent.name} used ${short(agent.spentTokensToday)} of ${short(b.dailyTokensPerAgent)} tokens today`
      : `out of budget: ${b?.name ?? "the building"} has no tokens left`;
    return { kind: "budget", targetId: b?.id ?? null, placeId: "bank", text };
  }
  const hold = laneBlock(world, a);
  if (!hold) return null;
  if (hold.kind === "grant") {
    const g = hold.grantId ? world.grants.get(hold.grantId) : undefined;
    const state = !g ? "doesn't exist" : g.status === "checkpoint" ? "at checkpoint" : g.status === "proposed" || g.status === "countered" || g.status === "draft" ? "not funded yet" : g.status;
    return { kind: "grant", targetId: hold.grantId ?? null, ...townHall, text: `grant ${hold.grantId ?? "(none)"} ${state}` };
  }
  if (hold.kind === "done") {
    return { kind: "grant", targetId: hold.grantId ?? null, ...townHall, text: `done: grant proposal ${hold.grantId} names its key result` };
  }
  if (hold.kind === "exploration") {
    return { kind: "exploration", targetId: a.buildingId, ...townHall, text: `exploration allowance spent (${short(hold.used ?? 0)} of ${short(hold.allowance ?? 0)} today, resets at 00:00 UTC)` };
  }
  return { kind: "reserved", targetId: a.buildingId, ...townHall, text: "the building's tokens are reserved for its funded grants" };
}

/** Every agent's blocked queued assignments, in queue order (GET /api/blocked): agent id → list. Agents with none are left out. */
export function townBlocked(world: World, at: Date = new Date()): Record<string, BlockedAssignment[]> {
  const out: Record<string, BlockedAssignment[]> = {};
  for (const a of world.assignments.where("status = 'pending'", [], "ORDER BY position, createdAt, rowid")) {
    const b = blockedBy(world, a, at);
    if (b) (out[a.agentId] ??= []).push({ assignmentId: a.id, title: a.title, blockedBy: b });
  }
  return out;
}

/** The building's work right now (GET /api/buildings/:id/stats): assignments running / queued, its active schedules, its agents and forks, the live commit. */
export function buildingStats(world: World, buildingId: string, at: Date = new Date()): BuildingStats {
  const assignments = { running: 0, queued: 0, blocked: 0, scheduled: 0 };
  for (const a of world.assignments.where("buildingId = ? AND status IN ('pending', 'active')", [buildingId])) {
    if (a.status === "active") assignments.running++;
    else if (a.offered) continue;
    else { assignments.queued++; if (blockedBy(world, a, at)) assignments.blocked++; }
  }
  assignments.scheduled = world.schedules.count("buildingId = ? AND status = 'active'", [buildingId]);
  let agents = 0, forks = 0, working = 0;
  for (const g of world.agents.where("homeBuildingId = ? AND kind = 'resident' AND status NOT IN ('retired', 'banned')", [buildingId])) {
    if (g.forkOf) forks++; else agents++;
    if (g.status === "working") working++;
  }
  return { assignments, agents, forks, working, host: { commit: world.host.commit ?? null, startedAt: world.host.startedAt ?? null } };
}
