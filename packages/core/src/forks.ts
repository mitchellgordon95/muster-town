/**
 * Manager forks (design note dc_mymt27yz25, step 1): a building with `forks` on queues work to the building; a fork is a
 * short-lived resident row ("Pix 3", forkOf = the manager) that takes a free desk (never growing the lab), works one
 * assignment and is retired when its session ends. The runtime (step 2) calls `forkManager` and `retireFork`.
 */
import { Agent, type Assignment, type Building } from "@muster-town/schema";
import { AppError, badRequest } from "./errors.ts";
import { buildingQueue, managerAgentOf } from "./domain.ts";
import { familyCap } from "./budget.ts";
export { familyCap };
import { buildingRoleId } from "./permissions.ts";
import { newId, nowIso } from "./util.ts";
import type { World } from "./world.ts";

/** The models a building's fork may run on: its work model and its cheap model. */
export function forkModels(b: Building): string[] {
  return [...new Set([b.model, b.cheapModel])];
}

/** Check a per-assignment model override (`assign … model`) against the models the building allows. */
export function checkForkModel(b: Building, model: string | undefined | null): string | null {
  if (!model) return null;
  if (!forkModels(b).includes(model)) throw badRequest(`${b.name} runs forks on ${forkModels(b).join(" or ")}, not ${model}.`);
  return model;
}

/** The lowest n ≥ 1 that no live (not retired) fork of the manager uses. */
export function nextForkN(world: World, managerId: string): number {
  const used = new Set(world.agents.where("forkOf = ? AND status != 'retired'", [managerId]).map((a) => a.forkN));
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

/**
 * Step 2, the runtime's spawn check: the building-queue work a fork may start now, in queue order. Empty when forks are
 * off, there is no manager to fork, the building's budget or the family's daily cap is spent. Waiting and offered rows
 * are skipped; a row the lane gate holds keeps its `heldReason` (as for a resident's queue).
 */
export function forkableQueue(world: World, b: Building): Assignment[] {
  if (!b.forks) return [];
  const manager = managerAgentOf(world, b);
  if (!manager || manager.status === "banned" || manager.status === "retired") return [];
  if (world.budget.remaining(b.id) <= 0 || manager.familySpentToday >= familyCap(b)) return [];
  return buildingQueue(world, b.id).filter((a) => !a.waitFor && !a.offered && world.budget.holdReason(a) === null);
}

/** Desks a fork can take: the building's headcount minus the desks in use (named residents' and live forks'). */
export const freeDesks = (world: World, b: Building): number => Math.max(0, b.headcount - world.layout.deskCount(b.id));

/** Live (not retired) forks, e.g. for the runtime's sweep of forks whose session is gone. */
export const liveForks = (world: World): Agent[] => world.agents.where("forkOf IS NOT NULL AND status != 'retired'");

/** The desk number (0-based, as in the `desks` table) the agent sits at, or null. */
function deskN(world: World, agentId: string): number | null {
  const r = world.db.prepare("SELECT n FROM desks WHERE agentId = ?").get(agentId) as { n: number } | undefined;
  return r?.n ?? null;
}

/**
 * Fork the building's manager for a building-queue assignment, in one transaction: a new resident row ("<Manager> <n>",
 * the manager's sprite, the assignment's model or the building's, the resident permission set), the lowest free desk
 * WITHOUT growing the lab (refused when every desk is taken), the assignment handed to the fork, and `agent.forked`.
 * The caller (the runtime) then starts the work session.
 */
export function forkManager(world: World, buildingId: string, assignmentId: string): { fork: Agent; desk: number; assignment: Assignment } {
  const b = world.buildings.require(buildingId, "building");
  if (!b.forks) throw badRequest(`${b.name} doesn't run forks (its \`forks\` setting is off).`);
  const manager = managerAgentOf(world, b);
  if (!manager) throw new AppError("conflict", `${b.name} has no manager agent to fork.`);
  const a = world.assignments.require(assignmentId, "assignment");
  if (a.buildingId !== b.id || a.queue !== "building") throw badRequest(`"${a.title}" isn't on ${b.name}'s building queue.`);
  if (a.status !== "pending") throw new AppError("conflict", `"${a.title}" is ${a.status}, not queued.`);
  if (world.agents.get(a.agentId)?.forkOf) throw new AppError("conflict", `"${a.title}" was already taken by ${world.nameOf(a.agentId)}.`);
  return world.transaction(() => {
    const id = newId("ag");
    const n = nextForkN(world, manager.id);
    world.agents.upsert(Agent.parse({
      id, name: `${manager.name} ${n}`, kind: "resident", buildingId: b.id, homeBuildingId: b.id, ownerUserId: manager.ownerUserId,
      sprite: manager.sprite, model: a.model ?? b.model, pos: world.layout.door(b.id) ?? manager.pos, status: "idle",
      currentAssignmentId: a.id, inheritsOwner: false, forkOf: manager.id, forkN: n, createdAt: nowIso(),
    }), { silent: true });
    // desks stay the cap: no grow (claimDesk throws a conflict when the lab is full, and the transaction rolls back)
    const place = world.layout.claimDesk(b.id, id);
    const fork = world.agents.patch(id, { pos: place.pos });
    world.permissions.grant(fork, buildingRoleId(b.id, "member"));
    const assignment = world.assignments.upsert({ ...a, agentId: id, updatedAt: nowIso() });
    const desk = deskN(world, id)!;
    const chainReportId = a.fromReportId ?? (world.db.prepare(
      "SELECT id FROM docs WHERE type = 'report' AND assignmentId IN (SELECT id FROM assignments WHERE chainId = ?) ORDER BY createdAt DESC, rowid DESC LIMIT 1",
    ).get(a.chainId ?? a.id) as { id: string } | undefined)?.id ?? null;
    world.events.append({
      type: "agent.forked", agentId: id, buildingId: b.id, text: `${manager.name} forked ${fork.name} for "${a.title}" at desk ${desk}`,
      payload: { forkOf: manager.id, forkN: n, desk, assignmentId: a.id, chainId: a.chainId, chainReportId, model: fork.model },
    });
    return { fork, desk, assignment };
  });
}

/**
 * Retire a fork at the end of its session, whatever the outcome: queued work it still holds goes back on the building
 * queue, its desk is released, its tokens revoked and memberships removed, status `retired` (the row stays, so its docs
 * keep their author), and `agent.retired` with the report and the adjusted tokens it spent. Idempotent.
 */
export function retireFork(world: World, forkId: string, outcome: { reportId?: string | null; reason?: string } = {}): Agent {
  const fork = world.agents.require(forkId, "agent");
  if (!fork.forkOf) throw badRequest(`${fork.name} isn't a fork.`);
  if (fork.status === "retired") return fork;
  return world.transaction(() => {
    world.movement.cancel(forkId, "Retired.");
    const requeued: string[] = [];
    for (const a of world.assignments.where("agentId = ? AND status = 'pending'", [forkId])) {
      world.assignments.upsert({ ...a, agentId: fork.forkOf!, queue: "building", updatedAt: nowIso() });
      requeued.push(a.id);
    }
    const revokedTokens = world.tokens.revokeAll("agent", forkId);
    world.memberships.removeAll("agent", forkId);
    const desk = deskN(world, forkId);
    if (desk !== null) world.layout.releaseDesk(forkId);
    world.agents.patch(forkId, { currentAssignmentId: null, currentMeetingId: null, activity: "" });
    const reportId = outcome.reportId ?? null;
    const tokens = fork.spentTokensTotal;
    const retired = world.setStatus(forkId, "retired", `${fork.name} retired`);
    world.events.append({
      type: "agent.retired", agentId: forkId, buildingId: fork.homeBuildingId,
      text: `${fork.name} retired (${reportId ? `report ${reportId}` : outcome.reason ?? "no report"}, ${Math.round(tokens / 1000)}k adj. tokens)`,
      payload: { forkOf: fork.forkOf, forkN: fork.forkN, reportId, tokens, desk, requeued, revokedTokens, ...(outcome.reason ? { reason: outcome.reason } : {}) },
    });
    return retired;
  });
}
